// cron 任务公共逻辑（供 /api/cron/* 与面板手动触发复用）。
// 外部调度（cron-job.org / Railway Cron 插件）打 HTTP 触发；Bearer 校验在路由层。
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
  type AuthShape,
} from "./upstream/client";
import { isAlreadyCheckin, isSessionDead } from "./upstream/errors";
import { SESSION_DEAD_THRESHOLD } from "./pool";
import { reportChatActivity } from "./upstream/report";
import {
  buddyInfo, buddyAgreement, buddyFirst, travelStatus, travelDepart, travelClaim,
  growthStreak, growthStreakFull, growthRedeemTier, lotteryChances, lotteryDraw,
  heatmapYesterdayMissed, useMakeupCard, claimGift, claimCompensation,
} from "./upstream/tasks";
import { listActiveAccounts, reportGapMs } from "./taskcenter";
import { runlog } from "./runlog";
import { label } from "./logfmt";
import { gcSticky } from "./session";

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

// runKeepalive 全量 token 保活（对齐 Go RunKeepaliveNow）：无条件刷新所有有
// refreshToken 的账号（Go 无 needsRefresh 窗口，到点就全刷）；失败逐号记日志，
// 12153 session dead 连续 3 次自动禁用（对齐 NoteSessionDead），刷新成功清误判计数。
// 禁用账号默认跳过；schedule_include_disabled_in_tasks 打开时也续期（但已禁用的
// 号不再重复计数 12153）。
export async function runKeepalive(): Promise<{ refreshed: number; skipped: number; failed: number }> {
  const cfg = await getConfig();
  const includeDisabled = cfg.schedule_include_disabled_in_tasks;
  const accounts = await prisma.account.findMany({ include: { state: true } });
  let refreshed = 0, skipped = 0, failed = 0;
  for (const a of accounts) {
    if ((a.state?.disabled ?? false) && !includeDisabled) continue;
    if (!a.refreshToken) { skipped++; continue; }
    const lb = label(a.uid, a.nickname);
    let patch: Awaited<ReturnType<typeof refreshToken>>;
    try {
      patch = await refreshToken(cfg, shapeOf(a));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      runlog("keepalive " + lb + ": " + msg);
      // session dead（12153）走连续计数禁用；且不对已禁用的号重复计数（终态，再打
      // 一行「— 禁用」只会误导）。其余失败只记日志，不动熔断（对齐 Go）。
      if (isSessionDead(e) && !(a.state?.disabled ?? false)) {
        if (await pool.noteSessionDead(a.uid)) {
          runlog("keepalive " + lb + ": 连续 " + SESSION_DEAD_THRESHOLD + " 次 12153 session dead — 禁用");
        }
      }
      failed++;
      continue;
    }
    await pool.clearSessionDead(a.uid); // 刷新成功清误判计数
    refreshed++;
    try {
      await prisma.account.update({
        where: { uid: a.uid },
        data: {
          accessToken: patch.accessToken ?? a.accessToken,
          refreshToken: patch.refreshToken ?? a.refreshToken,
          expiresAt: BigInt(patch.expiresAt ?? 0 > 0 ? patch.expiresAt! : Number(a.expiresAt)),
          domain: patch.domain ?? a.domain,
        },
      });
    } catch (e) {
      // 对齐 Go RunKeepaliveNow：落盘失败单独记 save 行，不计入刷新失败。
      runlog("keepalive " + lb + " save: " + (e instanceof Error ? e.message : String(e)));
    }
  }
  // 顺手清粘性会话过期绑定（StickySession 表只增不减，否则面板的"粘性会话"
  // 计数会无限累积；TTL 30min 见 session.ts STICKY_TTL_MS）。
  try {
    const n = await gcSticky();
    if (n > 0) runlog("keepalive gc sticky: 清理过期绑定 " + n + " 条");
  } catch (e) {
    runlog("keepalive gc sticky: " + errMsg(e));
  }
  return { refreshed, skipped, failed };
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
      updated++;
    } catch (e) {
      failed++;
      runlog("balance " + label(a.uid, a.nickname) + ": " + errMsg(e));
    }
  }
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
      runlog("travel " + lb + ": skip (unknown state " + JSON.stringify(ts.state ?? "") + ")");
      return "skipped";
  }
}

// travelAdopt 无猫时领养：report（解锁前置）→ agreement → buddy/first。
// 门槛未达（当日无活跃）当日不再重试。
async function travelAdopt(cfg: AppConfig, a: AuthShape, lb: string): Promise<boolean> {
  if (adoptTried.get(a.uid) === travelDay()) return false;
  try {
    await reportChatActivity(cfg, a, "wb2api-adopt-" + Date.now(), "");
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
      await reportChatActivity(cfg, row.auth, "wb2api-" + Date.now(), "");
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
  await useMakeupCard(cfg, a, yesterday);
  runlog("streak-bonus " + lb + ": 已用补签卡补签 " + yesterday + "（保连登）");
}
