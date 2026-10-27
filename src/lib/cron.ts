// cron 任务公共逻辑（供 /api/cron/* 与面板手动触发复用）。
// 外部调度（cron-job.org / Railway Cron 插件）打 HTTP 触发；Bearer 校验在路由层。
import { randomUUID } from "crypto";
import { prisma } from "./db";
import type { AppConfig } from "./config";
import { getConfig } from "./config";
import * as pool from "./pool";
import {
  dailyCheckin,
  refreshToken,
  userResource,
  expiringSoonMs,
  fetchAccountProfile,
  newConversationID,
  type AuthShape,
} from "./upstream/client";
import { isAlreadyCheckin, isSessionDead, UpstreamError } from "./upstream/errors";
import { SESSION_DEAD_THRESHOLD } from "./pool";
import { reportChatActivity } from "./upstream/report";
import {
  buddyInfo, buddyAgreement, buddyFirst, travelStatus, travelDepart, travelClaim,
  growthStreak, growthStreakFull, growthRedeemTier, lotteryChances, lotteryDraw,
  heatmapYesterdayMissed, useMakeupCard as makeupCard, claimGift, claimCompensation,
} from "./upstream/tasks";
import { listActiveAccounts, reportGapMs } from "./taskcenter";
import { runlog } from "./runlog";
import { label } from "./logfmt";
import { gcSticky } from "./session";
import { sampleAll, rollupBalanceSamples } from "./balance";

// errMsg 提取错误消息（Error.message 优先，其余 String 化）。
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function shapeOf(a: {
  uid: string; nickname: string; realm: string; accessToken: string;
  refreshToken: string; expiresAt: bigint; domain: string; enterpriseId: string;
  deviceToken: string;
}): AuthShape {
  return {
    uid: a.uid, nickname: a.nickname, realm: a.realm,
    accessToken: a.accessToken, refreshToken: a.refreshToken,
    expiresAt: Number(a.expiresAt), domain: a.domain,
    enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
  };
}

// runCheckin 全量签到（对齐 Go RunCheckinNow）：逐账号签到 + 余额回写 + 解冻，
// 末尾跑连登管家。global/企业号跳过签到但企业号仍刷余额；禁用账号默认跳过
// （schedule_include_disabled_in_tasks 打开时一并执行）；已签到幂等。
// 日志对齐 Go：逐号 `checkin 昵称(uid8): 签到成功/今天已签到（幂等）/…` +
// `user-resource …` 失败行。
export async function runCheckin(): Promise<{ done: number; already: number; failed: number }> {
  const cfg = await getConfig();
  const includeDisabled = cfg.schedule_include_disabled_in_tasks;
  const accounts = await prisma.account.findMany({ include: { state: true } });
  let done = 0, already = 0, failed = 0;
  for (const a of accounts) {
    if ((a.state?.disabled ?? false) && !includeDisabled) continue;
    if (!a.refreshToken) continue;
    if (a.realm === "global") continue; // D4 门控：global 无 CN 任务体系
    const lb = label(a.uid, a.nickname);
    // 企业版无签到体系（daily-checkin 400 code 10001），但余额查询照常跑。
    if (a.enterpriseId === "") {
      try {
        await dailyCheckin(cfg, shapeOf(a));
        await pool.markCheckin(a.uid);
        done++;
        runlog("checkin " + lb + ": 签到成功");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isAlreadyCheckin(msg)) {
          await pool.markCheckin(a.uid);
          already++;
          runlog("checkin " + lb + ": 今天已签到（幂等）");
        } else {
          failed++;
          runlog("checkin " + lb + ": " + msg);
        }
        // 其余业务错误也继续走余额查询
      }
    }
    // 余额回写（对齐 Go UserResourceDetailedWithExpiry + ReenableIfCredits：
    // setCreditsDetailed 内含余额恢复解冻语义）。
    try {
      const r = await userResource(cfg, shapeOf(a), expiringSoonMs(cfg.expiring_soon_hours));
      await pool.setCreditsDetailed(
        a.uid, BigInt(r.remain), BigInt(r.total),
        BigInt(r.expiring), BigInt(r.earliestAt), BigInt(r.earliestRemain),
      );
    } catch (e) {
      runlog("user-resource " + lb + ": " + (e instanceof Error ? e.message : String(e)));
    }
  }
  // 连登管家（对齐 Go RunCheckinNow 末尾的 RunStreakBonusNow）：逐号日志由
  // streakBonusAccount 的 console.log 打（"streak-bonus " 前缀），无总结行（对齐 Go）。
  await runStreakBonusNow();
  return { done, already, failed };
}

export interface KeepaliveOptions {
  force?: boolean; // 面板手动「全部保活」为 true；自动/外部 cron 只刷临期账号
  source?: "scheduler" | "cron" | "panel";
  timeBudgetMs?: number;
}

export interface KeepaliveResult {
  refreshed: number;
  skipped: number;
  failed: number;
  deferred: number; // 已确认到期，但本轮预算耗尽，留给下一次触发
  candidates: number;
  busy: boolean; // 其他实例/触发源正持有 lease
  force: boolean;
  elapsedMs: number;
}

const KEEPALIVE_LEASE_KEY = "__job:keepalive";
const KEEPALIVE_LEASE_GRACE_MS = 90_000;
const KEEPALIVE_MAX_ATTEMPTS = 2;
const KEEPALIVE_RETRY_BASE_MS = 1_000;
const KEEPALIVE_MAX_RETRY_WAIT_MS = 5_000;
const KEEPALIVE_SAVE_ATTEMPTS = 2;
const KEEPALIVE_SAVE_RETRY_MS = 250;

const keepaliveSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// acquireKeepaliveLease 用 Setting 行的幂等主键做跨进程原子租约。
// value 格式为 "<expiresAtUnixMs>:<owner>"；只有过期 lease 能被抢占。
async function acquireKeepaliveLease(ttlMs: number): Promise<string | null> {
  const now = Date.now();
  const token = randomUUID();
  const value = `${now + ttlMs}:${token}`;
  const rows = await prisma.$queryRaw<Array<{ value: string }>>`
    INSERT INTO "Setting" ("key", "value", "updatedAt")
    VALUES (${KEEPALIVE_LEASE_KEY}, ${value}, NOW())
    ON CONFLICT ("key") DO UPDATE
    SET "value" = EXCLUDED."value", "updatedAt" = NOW()
    WHERE CASE
      WHEN "Setting"."value" ~ '^[0-9]{1,15}:'
        THEN split_part("Setting"."value", ':', 1)::bigint
      ELSE 0
    END <= ${now}
    RETURNING "value"
  `;
  return rows[0]?.value === value ? value : null;
}

async function releaseKeepaliveLease(lease: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: KEEPALIVE_LEASE_KEY, value: lease } });
}

// keepaliveDue 对已知有效期始终按到期时间判断；只有有效期未知/已陈旧时才用最近
// 成功时间限流，避免短有效期 token 被 24 小时窗口误判为无需刷新。
export function keepaliveDue(
  cfg: AppConfig,
  a: { expiresAt: bigint; state: { lastKeepaliveAt: bigint } | null },
  now: number,
  force: boolean,
): boolean {
  if (force) return true;
  const refreshBeforeMs = cfg.schedule_keepalive_refresh_before_hours * 3600_000;
  const expiresAtMs = Number(a.expiresAt) * 1000;
  if (expiresAtMs > now) return expiresAtMs <= now + refreshBeforeMs;
  const lastSuccess = Number(a.state?.lastKeepaliveAt ?? 0n);
  // 上次成功晚于旧到期时间，说明刷新成功但上游未返回新 expiresIn；旧时间已陈旧。
  // 若上次成功早于到期时间，则 token 是在成功后续期期内真正过期，必须再次刷新。
  if (lastSuccess >= expiresAtMs && lastSuccess > 0 && now - lastSuccess < refreshBeforeMs) {
    return false;
  }
  return true;
}

// retryDelay 只重试网络抖动/上游临时故障；session dead、鉴权失败等确定性错误不重试。
function retryDelay(err: unknown): number | null {
  if (!(err instanceof UpstreamError)) {
    const msg = errMsg(err);
    if (/no refreshToken|refresh_failed/i.test(msg)) return null;
    return KEEPALIVE_RETRY_BASE_MS;
  }
  switch (err.kind) {
    case "server":
    case "soft_rate":
    case "soft_queue":
    case "waf_block": {
      const delay = err.retryAfterMs > 0 ? err.retryAfterMs : KEEPALIVE_RETRY_BASE_MS;
      return delay <= KEEPALIVE_MAX_RETRY_WAIT_MS ? delay : null;
    }
    default:
      return null;
  }
}

type KeepaliveAccount = {
  uid: string;
  nickname: string;
  realm: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: bigint;
  domain: string;
  enterpriseId: string;
  deviceToken: string;
  state: { disabled: boolean; lastKeepaliveAt: bigint } | null;
};

async function refreshKeepaliveAccount(
  cfg: AppConfig,
  a: KeepaliveAccount,
  deadline: number,
): Promise<{ ok: boolean; err?: unknown }> {
  let lastErr: unknown;
  let patch: Partial<AuthShape> | null = null;
  for (let attempt = 1; attempt <= KEEPALIVE_MAX_ATTEMPTS; attempt++) {
    try {
      patch = await refreshToken(cfg, shapeOf(a));
      break;
    } catch (e) {
      lastErr = e;
      const delay = retryDelay(e);
      if (attempt >= KEEPALIVE_MAX_ATTEMPTS || delay === null) break;
      // 留出至少一次上游请求的启动时间，避免预算末尾再发一个必然被截断的重试。
      if (Date.now() + delay + 1_000 >= deadline) break;
      await keepaliveSleep(delay);
    }
  }
  if (!patch) return { ok: false, err: lastErr };

  const savedAt = Date.now();
  const nextExpiresAt = typeof patch.expiresAt === "number" && patch.expiresAt > 0
    ? BigInt(patch.expiresAt)
    : a.expiresAt;
  for (let attempt = 1; attempt <= KEEPALIVE_SAVE_ATTEMPTS; attempt++) {
    try {
      await prisma.$transaction([
        prisma.account.update({
          where: { uid: a.uid },
          data: {
            accessToken: patch.accessToken ?? a.accessToken,
            refreshToken: patch.refreshToken ?? a.refreshToken,
            expiresAt: nextExpiresAt,
            domain: patch.domain ?? a.domain,
          },
        }),
        prisma.accountState.upsert({
          where: { uid: a.uid },
          create: {
            uid: a.uid,
            lastKeepaliveAt: BigInt(savedAt),
            sessionStrikes: 0,
            sessionDead: false,
          },
          update: {
            lastKeepaliveAt: BigInt(savedAt),
            sessionStrikes: 0,
            sessionDead: false,
          },
        }),
      ]);
      return { ok: true };
    } catch (e) {
      lastErr = e;
      if (attempt < KEEPALIVE_SAVE_ATTEMPTS) await keepaliveSleep(KEEPALIVE_SAVE_RETRY_MS);
    }
  }
  return { ok: false, err: lastErr };
}

// runKeepalive 仅刷新临期 token；force=true 保留面板「全部保活」语义。
// 跨触发源用 DB lease 互斥，账号并发处理，预算耗尽时返回 deferred 供下一轮续跑。
// 12153 session dead 连续 3 次自动禁用；成功续期会清误判计数。
export async function runKeepalive(options: KeepaliveOptions = {}): Promise<KeepaliveResult> {
  const startedAt = Date.now();
  const force = options.force ?? false;
  const cfg = await getConfig();
  const includeDisabled = cfg.schedule_include_disabled_in_tasks;
  const budgetMs = options.timeBudgetMs ?? cfg.schedule_keepalive_time_budget_ms;
  const concurrency = cfg.schedule_keepalive_concurrency;
  const lease = await acquireKeepaliveLease(budgetMs + KEEPALIVE_LEASE_GRACE_MS);
  if (!lease) {
    runlog("keepalive: 已有任务运行中，跳过 source=" + (options.source ?? "unknown"));
    return {
      refreshed: 0, skipped: 0, failed: 0, deferred: 0, candidates: 0,
      busy: true, force, elapsedMs: Date.now() - startedAt,
    };
  }

  try {
    const deadline = startedAt + budgetMs;
    const accounts = await prisma.account.findMany({ include: { state: true } });
    const now = Date.now();
    let skipped = 0;
    const candidates: KeepaliveAccount[] = [];
    for (const a of accounts) {
      if ((a.state?.disabled ?? false) && !includeDisabled) {
        skipped++;
        continue;
      }
      if (!a.refreshToken) {
        skipped++;
        continue;
      }
      if (!keepaliveDue(cfg, a, now, force)) {
        skipped++;
        continue;
      }
      candidates.push(a);
    }

    candidates.sort((x, y) => {
      const xe = Number(x.expiresAt);
      const ye = Number(y.expiresAt);
      if (xe <= 0 && ye > 0) return -1;
      if (ye <= 0 && xe > 0) return 1;
      return xe - ye;
    });

    let next = 0;
    let started = 0;
    let refreshed = 0;
    let failed = 0;
    const workerCount = Math.min(concurrency, candidates.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        if (Date.now() >= deadline) return;
        const i = next++;
        if (i >= candidates.length) return;
        started++;
        const a = candidates[i];
        let r: { ok: boolean; err?: unknown };
        try {
          r = await refreshKeepaliveAccount(cfg, a, deadline);
        } catch (e) {
          r = { ok: false, err: e };
        }
        if (r.ok) {
          refreshed++;
          continue;
        }
        failed++;
        const msg = errMsg(r.err);
        const lb = label(a.uid, a.nickname);
        runlog("keepalive " + lb + ": " + msg);
        // session dead（12153）走连续计数禁用；已禁用的号不重复计数。
        if (isSessionDead(r.err) && !(a.state?.disabled ?? false)) {
          try {
            if (await pool.noteSessionDead(a.uid)) {
              runlog("keepalive " + lb + ": 连续 " + SESSION_DEAD_THRESHOLD + " 次 12153 session dead — 禁用");
            }
          } catch (e) {
            // 状态落库失败不能中断整轮，其他账号仍应继续续期。
            runlog("keepalive " + lb + " session-dead state: " + errMsg(e));
          }
        }
      }
    });
    await Promise.all(workers);

    const deferred = candidates.length - started;
    // 顺手清粘性会话过期绑定（StickySession 表只增不减，TTL 30min）。
    try {
      const n = await gcSticky();
      if (n > 0) runlog("keepalive gc sticky: 清理过期绑定 " + n + " 条");
    } catch (e) {
      runlog("keepalive gc sticky: " + errMsg(e));
    }
    const elapsedMs = Date.now() - startedAt;
    runlog(
      "keepalive: refreshed=" + refreshed + " skipped=" + skipped + " failed=" + failed
      + " deferred=" + deferred + " candidates=" + candidates.length
      + " force=" + force + " elapsed=" + elapsedMs + "ms source=" + (options.source ?? "unknown"),
    );
    return {
      refreshed, skipped, failed, deferred, candidates: candidates.length,
      busy: false, force, elapsedMs,
    };
  } finally {
    await releaseKeepaliveLease(lease).catch((e) => {
      runlog("keepalive lease release: " + errMsg(e));
    });
  }
}

// runBalanceRefresh 全量余额刷新（写回 credits 快照，含解冻语义）。
export async function runBalanceRefresh(): Promise<{ updated: number; failed: number }> {
  const cfg = await getConfig();
  const includeDisabled = cfg.schedule_include_disabled_in_tasks;
  const accounts = await prisma.account.findMany({ include: { state: true } });
  let updated = 0, failed = 0;
  for (const a of accounts) {
    // 禁用只关选号：开关打开时禁用号也刷新余额（对齐 Go RunBalanceRefreshNow）。
    if ((a.state?.disabled ?? false) && !includeDisabled) continue;
    if (!a.accessToken) continue;
    try {
      const r = await userResource(cfg, shapeOf(a), expiringSoonMs(cfg.expiring_soon_hours));
      await pool.setCreditsDetailed(
        a.uid, BigInt(r.remain), BigInt(r.total),
        BigInt(r.expiring), BigInt(r.earliestAt), BigInt(r.earliestRemain),
      );
      // 余额采样：这里已拿到新鲜余额，顺手记一点（不额外打上游）。
      // 内部按账号 30 分钟节流，多数刷新周期不会落点。
      await sampleAll([{ uid: a.uid, credits: r.remain }]).catch(() => 0);
      updated++;
    } catch (e) {
      failed++;
      runlog("balance " + label(a.uid, a.nickname) + ": " + errMsg(e));
    }
  }
  // 顺带做粒度折叠与超期裁剪（幂等；对齐 Go Recorder.Start 的周期 Rollup）。
  await rollupBalanceSamples().catch(() => undefined);
  return { updated, failed };
}

// syncNicknames 手动刷新时的昵称同步（issue #94：上游改名免重登，移植
// panel.go syncNicknames）。只在面板手动「刷新」路径调用——后台余额定时器
// 不触发。逐号拉 /console/account，只取 nickname（手机号等敏感字段在
// fetchAccountProfile 内即被丢弃）；单号失败静默跳过，不打断余额刷新结果。
export async function syncNicknames(): Promise<{ updated: number; failed: number }> {
  const cfg = await getConfig();
  const accounts = await prisma.account.findMany({ include: { state: true } });
  const jobs = accounts.filter((a) => !a.state?.disabled && a.accessToken);
  let updated = 0;
  let failed = 0;
  const CONCURRENCY = 3; // 与 Go 同并发上限
  const queue = [...jobs];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const a = queue.shift();
      if (!a) return;
      try {
        const nick = await fetchAccountProfile(cfg, shapeOf(a));
        if (nick && nick !== a.nickname) {
          await prisma.account.update({ where: { uid: a.uid }, data: { nickname: nick } });
          updated++;
        }
      } catch {
        failed++;
      }
    }
  });
  await Promise.all(workers);
  return { updated, failed };
}


// ─── 旅行巡检 / 活跃上报（移植 scheduler/travel.go、runActivity）───────────────



const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// travelAccountDelayMs 账号间限速（对齐 scheduler travelAccountDelay，保守 2s）。
const travelAccountDelayMs = 2000;
// TRAVEL_LOCATION_ID 派出发地点固定 4（古镇客栈）：4 个地点收益/时长完全相同
// （对齐 Go travelLocationID）；上游要求显式携带 location_id。
const TRAVEL_LOCATION_ID = 4;

// adoptTried 记录各账号当日「领养门槛未达」判定（每日零点自然失效）。
const adoptTried = new Map<string, string>();
const travelDay = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });

// runTravelNow 立即对池内所有可用账号执行一趟旅行巡检（对齐 RunTravelNow）。
// 禁用账号跳过；global/企业门控（无 CN 成长体系，不发起上游调用）；401/查询失败只跳过。
// 日志对齐 Go：逐号 `travel 昵称(uid8): depart ok / claim ok / adopt ok / skip (…)`。
export async function runTravelNow(): Promise<{ adopted: number; departed: number; claimed: number; skipped: number }> {
  const cfg = await getConfig();
  // 旅行与 Go RunTravelNow 同口径：禁用账号始终跳过（该开关不覆盖旅行）。
  const rows = await listActiveAccounts();
  let adopted = 0, departed = 0, claimed = 0, skipped = 0;
  let first = true;
  for (const row of rows) {
    if (!row.auth.refreshToken) continue;
    if (row.realm === "global" || row.enterpriseId !== "") continue;
    if (!first) await sleep(travelAccountDelayMs);
    first = false;
    const r = await travelOne(cfg, row.auth, row.nickname);
    if (r === "adopted") adopted++;
    else if (r === "departed") departed++;
    else if (r === "claimed") claimed++;
    else skipped++;
  }
  return { adopted, departed, claimed, skipped };
}

// travelOne 单账号单趟状态机：查有无猫 + 查状态 + 最多一个动作，不轮询不等待。
async function travelOne(cfg: AppConfig, a: AuthShape, nickname: string): Promise<"adopted" | "departed" | "claimed" | "skipped"> {
  const lb = label(a.uid, nickname);
  let buddy: { id: number; name: string } | null = null;
  try { buddy = await buddyInfo(cfg, a); }
  catch (e) { runlog("travel " + lb + ": buddy-info: " + errMsg(e)); return "skipped"; }
  if (buddy == null) {
    const ok = await travelAdopt(cfg, a, lb);
    return ok ? "adopted" : "skipped";
  }
  let ts;
  try { ts = await travelStatus(cfg, a); }
  catch (e) { runlog("travel " + lb + ": status: " + errMsg(e)); return "skipped"; }
  switch (ts.state) {
    case "arrived":
      if (ts.record_id && ts.record_id > 0) {
        try {
          const reward = await travelClaim(cfg, a, ts.record_id);
          runlog("travel " + lb + ": claim ok record=" + ts.record_id + " reward=" + (reward ?? 0));
          return "claimed";
        } catch (e) {
          runlog("travel " + lb + ": claim record=" + ts.record_id + ": " + errMsg(e));
          return "skipped";
        }
      }
      runlog("travel " + lb + ": claim skipped (arrived but no record_id)");
      return "skipped";
    case "idle":
      if (ts.daily_limit_reached) { runlog("travel " + lb + ": skip (daily limit reached)"); return "skipped"; }
      try {
        await travelDepart(cfg, a, TRAVEL_LOCATION_ID);
        runlog("travel " + lb + ": depart ok location=" + TRAVEL_LOCATION_ID);
        return "departed";
      } catch (e) {
        runlog("travel " + lb + ": depart: " + errMsg(e));
        return "skipped";
      }
    case "traveling":
      runlog("travel " + lb + ": skip (traveling record=" + (ts.record_id ?? 0) + ")");
      return "skipped";
    default:
      runlog("travel " + lb + ": skip (未知状态 " + JSON.stringify(ts.state ?? "") + ")");
      return "skipped";
  }
}

// travelAdopt 无猫时领养：report（解锁前置）→ agreement → buddy/first。
// 门槛未达（当日无活跃）当日不再重试。
async function travelAdopt(cfg: AppConfig, a: AuthShape, lb: string): Promise<boolean> {
  if (adoptTried.get(a.uid) === travelDay()) return false;
  try {
    // 会话 ID 用官方形态（UUID v4）：旧值 wb2api-adopt-<毫秒> 把项目缩写 + 时间戳
    // 直接写进上报体（上游 issue #51）。
    await reportChatActivity(cfg, a, newConversationID(), "");
    await sleep(reportGapMs);
  } catch (e) {
    // 前置上报失败不阻塞，让 buddy/first 按既有错误路径暴露。
    runlog("travel " + lb + ": adopt preflight report: " + errMsg(e));
  }
  try { await buddyAgreement(cfg, a); }
  catch (e) {
    const msg = errMsg(e);
    // 协议接口返回参数级 400（如 must agree to adopt）属确定性失败，
    // 当日不再重试，避免每轮巡检刷同一条错误。
    if (/http 4\d\d/.test(msg)) {
      adoptTried.set(a.uid, travelDay());
      runlog("travel " + lb + ": agreement rejected, retry tomorrow: " + msg);
    } else {
      runlog("travel " + lb + ": agreement: " + msg);
    }
    return false;
  }
  try {
    await buddyFirst(cfg, a);
    runlog("travel " + lb + ": adopt ok (+300 credits)");
    return true;
  } catch (e) {
    const msg = errMsg(e);
    if (/first_buddy|task not completed|incomplete/i.test(msg)) {
      adoptTried.set(a.uid, travelDay());
      runlog("travel " + lb + ": adopt skipped (conversation threshold not reached, retry tomorrow)");
    } else {
      runlog("travel " + lb + ": adopt: " + msg);
    }
    return false;
  }
}

// runActivityNow 立即对池内所有可用账号执行一次对话活跃上报（对齐 runActivity）。
// 禁用账号跳过；企业版跳过（零收益）；global 也上报（国际版 /v2/report 可用）。
// 上报成功后续跑 streak 自检（对齐 Go checkActivityStreak）：回读连登天数，发现
// 「上报 200 但 streak 没涨」的静默丢弃。日志对齐 Go：逐号
// `activity 昵称(uid8): … / streak days=N`。
export async function runActivityNow(): Promise<{ reported: number; failed: number; skipped: number }> {
  const cfg = await getConfig();
  const rows = await listActiveAccounts(cfg.schedule_include_disabled_in_tasks);
  let reported = 0, failed = 0, skipped = 0;
  let first = true;
  for (const row of rows) {
    if (!row.auth.accessToken) { skipped++; continue; }
    if (row.enterpriseId !== "") { skipped++; continue; }
    if (!first) await sleep(travelAccountDelayMs);
    first = false;
    const lb = label(row.uid, row.nickname);
    try {
      await reportChatActivity(cfg, row.auth, newConversationID(), "");
      reported++;
      await checkActivityStreak(cfg, row.auth, lb); // 上报成功 → 回读 streak 自检
    } catch (e) {
      failed++;
      runlog("activity " + lb + ": " + errMsg(e));
    }
  }
  return { reported, failed, skipped };
}

// checkActivityStreak 上报成功后回读连登天数（只读 oracle，对齐 Go checkActivityStreak）。
async function checkActivityStreak(cfg: AppConfig, a: AuthShape, lb: string): Promise<void> {
  let days: number;
  try {
    days = await growthStreak(cfg, a);
  } catch (e) {
    runlog("activity " + lb + ": streak check failed (report OK): " + errMsg(e));
    return;
  }
  if (days === 0) {
    runlog("activity " + lb + ": report OK but streak.days=0 (silent drop?)");
    return;
  }
  runlog("activity " + lb + ": streak days=" + days);
}

// ─── 连登管家（移植 internal/scheduler/streak.go RunStreakBonusNow）────────
// 补签保连登 → 礼包/补偿 → 兑换所有已解锁档位（7d/14d/28d）→ 抽完所有 chances。
// 幂等：locked/无次数自动跳过；由签到排程末尾调用，也可面板手动触发。
export async function runStreakBonusNow(): Promise<{ redeemed: number; drawn: number; skipped: number }> {
  const cfg = await getConfig();
  const rows = await listActiveAccounts(); // 禁用跳过（对齐 Go RunStreakBonusNow）
  let redeemed = 0, drawn = 0, skipped = 0;
  for (const row of rows) {
    if (!row.auth.accessToken) { skipped++; continue; }
    if (row.realm === "global") continue; // D4 门控：global 无 CN 任务体系
    if (row.enterpriseId !== "") continue; // 企业版无成长体系（growth 403）
    try {
      const r = await streakBonusAccount(cfg, row.auth);
      redeemed += r.redeemed;
      drawn += r.drawn;
    } catch {
      skipped++;
    }
  }
  return { redeemed, drawn, skipped };
}

async function streakBonusAccount(cfg: AppConfig, a: AuthShape): Promise<{ redeemed: number; drawn: number }> {
  let redeemed = 0, drawn = 0;
  const lb = label(a.uid, a.nickname);
  // 0. 补签保连登：昨日漏签且有补签卡则补上（连续天数一断就要重攒 7 天）。
  await makeupYesterday(cfg, a, lb).catch(() => {});
  // 0.5 礼包/补偿（每号一次，无则业务错误静默跳过）。
  await claimGift(cfg, a).then((c) => {
    if (c > 0) runlog("streak-bonus " + lb + ": 新手礼包 +" + c + "c");
  }).catch(() => {});
  await claimCompensation(cfg, a).then((c) => {
    if (c > 0) runlog("streak-bonus " + lb + ": 补偿领取 +" + c + "c");
  }).catch(() => {});
  // 1. 兑换所有已解锁档位。
  const full = await growthStreakFull(cfg, a);
  const statuses: Record<string, string | undefined> = {
    "7d": full.redemption_status?.tier_7d_status,
    "14d": full.redemption_status?.tier_14d_status,
    "28d": full.redemption_status?.tier_28d_status,
  };
  for (const tier of full.redemption_status?.tiers ?? []) {
    const status = statuses[tier.tier];
    if (status === "locked" || status === "claimed") continue;
    try {
      await growthRedeemTier(cfg, a, tier.tier);
      redeemed++;
      runlog("streak-bonus " + lb + ": 兑换 " + tier.tier + " 档（+" + (tier.credit ?? 0) + "c +" + (tier.energy ?? 0) + "e 卡×" + (tier.cards ?? 0) + " 抽奖×" + (tier.chances ?? 0) + "）");
    } catch (e) {
      // 未解锁（403）属预期，静默；其余记日志。
      const msg = errMsg(e);
      if (!/403/.test(msg)) runlog("streak-bonus " + lb + ": redeem " + tier.tier + ": " + msg);
    }
  }
  // 2. 抽奖：按当前 chances 全抽完（兑换刚发的次数已在服务端累加）。
  let chances = 0;
  try {
    chances = await lotteryChances(cfg, a);
  } catch (e) {
    runlog("streak-bonus " + lb + ": lottery summary: " + errMsg(e));
    return { redeemed, drawn };
  }
  for (let i = 0; i < chances; i++) {
    try {
      await lotteryDraw(cfg, a);
      drawn++;
    } catch (e) {
      runlog("streak-bonus " + lb + ": draw: " + errMsg(e));
      break;
    }
  }
  if (chances > 0) runlog("streak-bonus " + lb + ": 抽奖完成 " + chances + " 次");
  return { redeemed, drawn };
}

// makeupYesterday 昨日漏签且有补签卡时自动补签（保住连登连续天数）。
async function makeupYesterday(cfg: AppConfig, a: AuthShape, lb: string): Promise<void> {
  const missed = await heatmapYesterdayMissed(cfg, a);
  if (!missed) return;
  const full = await growthStreakFull(cfg, a);
  if ((full.makeup_cards?.balance ?? 0) <= 0) return;
  const yesterday = new Date(Date.now() - 24 * 3600_000)
    .toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  await makeupCard(cfg, a, yesterday);
  runlog("streak-bonus " + lb + ": 已用补签卡补签 " + yesterday + "（保连登）");
}
