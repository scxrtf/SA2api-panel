// 余额趋势采样（移植 internal/balance/balance.go）：定时驱动的余额水位存量记录。
// 与 UsageEvent（事件驱动的流量）刻意分开：没有请求也要照常采样，否则空闲时段折线断裂。
//
// 两级粒度：近 detailedKeepMs 保留原始点；更早折叠为日粒度点（每天最后一个水位，
// 随点保存当日首值/消耗/到账——折叠后没有相邻采样对，不随点保存会让日流量静默归零）。
// 采样挂在 runBalanceRefresh 之后（那里已拿到新鲜余额，不额外打上游）。
import { prisma } from "./db";

export const BALANCE_SAMPLE_INTERVAL_MS = 30 * 60_000; // 采样节流：30 分钟一点
const DETAILED_KEEP_MS = 30 * 24 * 3600_000; // 原始点保留 30 天
const DAY_KEEP_MS = 365 * 24 * 3600_000; // 日粒度点保留 365 天
const EXPECTED_PER_DAY = 40; // 判定"某日采样完整"所需最少点数（理论 48，留容差）
const DAY_LAYOUT_TZ = "Asia/Shanghai";

export interface BalancePoint {
  t: number; // unix 秒
  u: string; // uid
  c: number; // 水位
  d?: string; // 非空 = 日粒度折叠点
  f?: number; // 折叠点：当日首个水位
  cons?: number; // 折叠点：当日消耗合计
  gain?: number; // 折叠点：当日到账合计
}

export interface DailyRow {
  day: string;
  first: number;
  last: number;
  change: number;
  min: number;
  max: number;
  n: number;
  full: boolean;
  consumed: number; // 下界估计
  gained: number; // 下界估计
}

export interface BalanceSeries {
  uid: string;
  name: string;
  realm: string;
  points: BalancePoint[];
  current: number;
  min: number;
  max: number;
  change: number;
  daily: DailyRow[];
}

function shanghaiDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DAY_LAYOUT_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

// sampleAll 对一批 (uid, credits) 采样：同账号距上次落点不足 30 分钟则跳过（节流按账号）。
export async function sampleAll(entries: { uid: string; credits: bigint | number }[]): Promise<number> {
  const cutoff = new Date(Date.now() - BALANCE_SAMPLE_INTERVAL_MS);
  let added = 0;
  for (const e of entries) {
    if (!e.uid) continue;
    const last = await prisma.balanceSample.findFirst({
      where: { uid: e.uid, day: "" },
      orderBy: { at: "desc" },
      select: { at: true },
    });
    if (last && last.at > cutoff) continue;
    await prisma.balanceSample.create({
      data: { uid: e.uid, credits: BigInt(e.credits) },
    });
    added++;
  }
  return added;
}

// rollup 把超出 DETAILED_KEEP_MS 的原始点折叠为日粒度；同时丢弃超出 DAY_KEEP_MS 的日点。
// 幂等，由余额刷新循环顺带调用。
export async function rollupBalanceSamples(now = Date.now()): Promise<void> {
  const cutoff = new Date(now - DETAILED_KEEP_MS);
  const olds = await prisma.balanceSample.findMany({
    where: { day: "", at: { lt: cutoff } },
    orderBy: { at: "asc" },
  });
  if (olds.length > 0) {
    type Fold = { last: (typeof olds)[number]; first: bigint; consumed: bigint; gained: bigint; prev: bigint; hasPrev: boolean };
    const folds = new Map<string, Fold>();
    const ids: string[] = [];
    for (const p of olds) {
      const k = p.uid + "|" + shanghaiDay(p.at);
      let f = folds.get(k);
      if (!f) {
        f = { last: p, first: p.credits, consumed: 0n, gained: 0n, prev: 0n, hasPrev: false };
        folds.set(k, f);
      }
      if (f.hasPrev) {
        const d = p.credits - f.prev;
        if (d > 0n) f.gained += d;
        else if (d < 0n) f.consumed += -d;
      }
      f.prev = p.credits;
      f.hasPrev = true;
      if (p.at >= f.last.at) f.last = p;
      ids.push(p.id);
    }
    for (const [k, f] of folds) {
      await prisma.balanceSample.create({
        data: {
          uid: f.last.uid,
          credits: f.last.credits,
          day: k.split("|")[1],
          first: f.first,
          consumed: f.consumed,
          gained: f.gained,
          at: f.last.at,
        },
      });
    }
    await prisma.balanceSample.deleteMany({ where: { id: { in: ids } } });
  }
  // 超期日粒度点裁剪
  const dayCutoff = shanghaiDay(new Date(now - DAY_KEEP_MS));
  await prisma.balanceSample.deleteMany({ where: { day: { not: "", lt: dayCutoff } } });
}

// snapshot 返回 sinceMs 之后各账号的余额序列（含按日聚合），供「余额趋势」视图。
// names/realms 为展示元数据（uid → 昵称/域），不入库，由调用方从账号池实时注入。
export async function snapshotBalance(
  sinceMs: number,
  names: Record<string, string>,
  realms: Record<string, string>,
): Promise<BalanceSeries[]> {
  const rows = await prisma.balanceSample.findMany({
    where: { at: { gte: new Date(sinceMs) } },
    orderBy: { at: "asc" },
  });
  const byUID = new Map<string, BalancePoint[]>();
  for (const r of rows) {
    const p: BalancePoint = {
      t: Math.floor(r.at.getTime() / 1000),
      u: r.uid,
      c: Number(r.credits),
    };
    if (r.day) {
      p.d = r.day;
      p.f = Number(r.first);
      p.cons = Number(r.consumed);
      p.gain = Number(r.gained);
    }
    const arr = byUID.get(r.uid);
    if (arr) arr.push(p);
    else byUID.set(r.uid, [p]);
  }
  const out: BalanceSeries[] = [];
  for (const [uid, pts] of byUID) {
    const s: BalanceSeries = {
      uid,
      name: names[uid] || "",
      realm: realms[uid] || "",
      points: pts,
      current: pts[pts.length - 1].c,
      min: 0,
      max: 0,
      change: 0,
      daily: [],
    };
    let lo = pts[0].c, hi = pts[0].c;
    for (const p of pts) {
      if (p.c < lo) lo = p.c;
      if (p.c > hi) hi = p.c;
      // 折叠点只剩末值：当日首值也要参与极值，否则窗口首日水位失真
      if (p.d && p.f) {
        if (p.f < lo) lo = p.f;
        if (p.f > hi) hi = p.f;
      }
    }
    s.min = lo;
    s.max = hi;
    const firstPt = pts[0];
    const firstVal = firstPt.d && firstPt.f ? firstPt.f : firstPt.c;
    s.change = pts[pts.length - 1].c - firstVal;
    s.daily = dailyOf(pts);
    out.push(s);
  }
  // 稳定排序：按最新值降序（主账号在前），再按 uid 保证确定性
  out.sort((a, b) => b.current - a.current || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
  return out;
}

// dailyOf 按本地日历日聚合每日变化。口径：末值 − 首值（不用跨零点连续口径，
// 与用户对"今天赚了多少"的直觉一致）。消耗/到账为相邻差值分正负累加（下界估计）。
function dailyOf(pts: BalancePoint[]): DailyRow[] {
  type Acc = {
    first: number; last: number; min: number; max: number; n: number;
    consumed: number; gained: number; prev: number; hasPrev: boolean;
  };
  const m = new Map<string, Acc>();
  for (const p of pts) {
    const day = shanghaiDay(new Date(p.t * 1000));
    let a = m.get(day);
    if (!a) {
      // 折叠点自带当日首值：first 不能取自身，否则 Change 恒为 0
      const first = p.d && p.f ? p.f : p.c;
      a = { first, last: p.c, min: p.c, max: p.c, n: 0, consumed: 0, gained: 0, prev: 0, hasPrev: false };
      m.set(day, a);
    }
    a.last = p.c;
    if (a.hasPrev) {
      const d = p.c - a.prev;
      if (d > 0) a.gained += d;
      else if (d < 0) a.consumed += -d;
    }
    // 折叠点自带的消耗/到账是折叠时算好的当日合计，必须加进来
    a.consumed += p.cons ?? 0;
    a.gained += p.gain ?? 0;
    a.prev = p.c;
    a.hasPrev = true;
    let lo = p.c, hi = p.c;
    if (p.d && p.f) {
      if (p.f < lo) lo = p.f;
      if (p.f > hi) hi = p.f;
    }
    if (lo < a.min) a.min = lo;
    if (hi > a.max) a.max = hi;
    a.n++;
  }
  const today = shanghaiDay(new Date());
  return [...m.entries()]
    .sort((x, y) => (x[0] < y[0] ? -1 : 1))
    .map(([day, a]) => ({
      day,
      first: a.first,
      last: a.last,
      change: a.last - a.first,
      min: a.min,
      max: a.max,
      n: a.n,
      consumed: a.consumed,
      gained: a.gained,
      full: day !== today && a.n >= EXPECTED_PER_DAY,
    }));
}
