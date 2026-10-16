// cron 任务公共逻辑（供 /api/cron/* 与面板手动触发复用）。
// 外部调度（cron-job.org / Railway Cron 插件）打 HTTP 触发；Bearer 校验在路由层。
import { prisma } from "./db";
import type { AppConfig } from "./config";
import { getConfig } from "./config";
import * as pool from "./pool";
import {
  dailyCheckin,
  refreshToken,
  needsRefresh,
  userResource,
  type AuthShape,
} from "./upstream/client";
import { isAlreadyCheckin } from "./upstream/errors";
import { reportChatActivity } from "./upstream/report";
import {
  buddyInfo, buddyAgreement, buddyFirst, travelStatus, travelDepart, travelClaim,
} from "./upstream/tasks";
import { listActiveAccounts, reportGapMs } from "./taskcenter";

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

// runCheckin 全量签到：仅 CN 非企业号；已签到幂等。09:00/21:00（Asia/Shanghai）由外部调度。
export async function runCheckin(): Promise<{ done: number; already: number; failed: number }> {
  const cfg = await getConfig();
  const accounts = await prisma.account.findMany({ include: { state: true } });
  let done = 0, already = 0, failed = 0;
  for (const a of accounts) {
    if (a.state?.disabled || a.realm === "global" || a.enterpriseId !== "") continue;
    try {
      await dailyCheckin(cfg, shapeOf(a));
      await pool.markCheckin(a.uid);
      done++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isAlreadyCheckin(msg)) {
        await pool.markCheckin(a.uid);
        already++;
      } else {
        failed++;
      }
    }
  }
  return { done, already, failed };
}

// runKeepalive 全量 token 保活：临近过期窗口内走 refreshToken（失败冷却记连败）。
export async function runKeepalive(): Promise<{ refreshed: number; skipped: number; failed: number }> {
  const cfg = await getConfig();
  const accounts = await prisma.account.findMany({ include: { state: true } });
  let refreshed = 0, skipped = 0, failed = 0;
  for (const a of accounts) {
    if (a.state?.disabled || !a.refreshToken) continue;
    const shape = shapeOf(a);
    if (!needsRefresh(shape, cfg.refresh_skew_sec * 12)) {
      skipped++;
      continue;
    }
    try {
      const patch = await refreshToken(cfg, shape);
      await prisma.account.update({
        where: { uid: a.uid },
        data: {
          accessToken: patch.accessToken ?? a.accessToken,
          refreshToken: patch.refreshToken ?? a.refreshToken,
          expiresAt: BigInt(patch.expiresAt ?? 0 > 0 ? patch.expiresAt! : Number(a.expiresAt)),
          domain: patch.domain ?? a.domain,
        },
      });
      refreshed++;
    } catch {
      await pool.noteError(cfg, a.uid);
      failed++;
    }
  }
  return { refreshed, skipped, failed };
}

// runBalanceRefresh 全量余额刷新（写回 credits 快照，含解冻语义）。
export async function runBalanceRefresh(): Promise<{ updated: number; failed: number }> {
  const cfg = await getConfig();
  const accounts = await prisma.account.findMany({ include: { state: true } });
  let updated = 0, failed = 0;
  for (const a of accounts) {
    if (a.state?.disabled || !a.accessToken) continue;
    try {
      const r = await userResource(cfg, shapeOf(a));
      await pool.setCreditsDetailed(a.uid, BigInt(r.remain), BigInt(r.total), 0n, 0n, 0n);
      updated++;
    } catch {
      failed++;
    }
  }
  return { updated, failed };
}


// ─── 旅行巡检 / 活跃上报（移植 scheduler/travel.go、runActivity）───────────────



const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// travelAccountDelayMs 账号间限速（对齐 scheduler travelAccountDelay，保守 2s）。
const travelAccountDelayMs = 2000;

// adoptTried 记录各账号当日「领养门槛未达」判定（每日零点自然失效）。
const adoptTried = new Map<string, string>();
const travelDay = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });

// runTravelNow 立即对池内所有可用账号执行一趟旅行巡检（对齐 RunTravelNow）。
// 禁用账号跳过；global/企业门控（无 CN 成长体系，不发起上游调用）；401/查询失败只跳过。
export async function runTravelNow(): Promise<{ adopted: number; departed: number; claimed: number; skipped: number }> {
  const cfg = await getConfig();
  const rows = await listActiveAccounts();
  let adopted = 0, departed = 0, claimed = 0, skipped = 0;
  let first = true;
  for (const row of rows) {
    if (!row.auth.refreshToken) continue;
    if (row.realm === "global" || row.enterpriseId !== "") continue;
    if (!first) await sleep(travelAccountDelayMs);
    first = false;
    const r = await travelOne(cfg, row.auth);
    if (r === "adopted") adopted++;
    else if (r === "departed") departed++;
    else if (r === "claimed") claimed++;
    else skipped++;
  }
  return { adopted, departed, claimed, skipped };
}

// travelOne 单账号单趟状态机：查有无猫 + 查状态 + 最多一个动作，不轮询不等待。
async function travelOne(cfg: AppConfig, a: AuthShape): Promise<"adopted" | "departed" | "claimed" | "skipped"> {
  let buddy: { id: number; name: string } | null = null;
  try { buddy = await buddyInfo(cfg, a); } catch { return "skipped"; }
  if (buddy == null) {
    await travelAdopt(cfg, a);
    return "skipped";
  }
  let ts;
  try { ts = await travelStatus(cfg, a); } catch { return "skipped"; }
  switch (ts.state) {
    case "arrived":
      if (ts.record_id && ts.record_id > 0) {
        try { await travelClaim(cfg, a, ts.record_id); return "claimed"; } catch { return "skipped"; }
      }
      return "skipped";
    case "idle":
      if (ts.daily_limit_reached) return "skipped";
      try { await travelDepart(cfg, a); return "departed"; } catch { return "skipped"; }
    default:
      return "skipped";
  }
}

// travelAdopt 无猫时领养：report（解锁前置）→ agreement → buddy/first。
// 门槛未达（当日无活跃）当日不再重试。
async function travelAdopt(cfg: AppConfig, a: AuthShape): Promise<void> {
  if (adoptTried.get(a.uid) === travelDay()) return;
  try {
    await reportChatActivity(cfg, a, "wb2api-adopt-" + Date.now(), "");
    await sleep(reportGapMs);
  } catch { /* 前置上报失败不阻塞，让 buddy/first 按既有错误路径暴露 */ }
  try { await buddyAgreement(cfg, a); } catch { return; }
  try {
    await buddyFirst(cfg, a);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/first_buddy|task not completed|incomplete/i.test(msg)) {
      adoptTried.set(a.uid, travelDay());
    }
  }
}

// runActivityNow 立即对池内所有可用账号执行一次对话活跃上报（对齐 runActivity）。
// 禁用账号跳过；企业版跳过（零收益）；global 也上报（国际版 /v2/report 可用）。
export async function runActivityNow(): Promise<{ reported: number; failed: number; skipped: number }> {
  const cfg = await getConfig();
  const rows = await listActiveAccounts();
  let reported = 0, failed = 0, skipped = 0;
  let first = true;
  for (const row of rows) {
    if (!row.auth.accessToken) { skipped++; continue; }
    if (row.enterpriseId !== "") { skipped++; continue; }
    if (!first) await sleep(travelAccountDelayMs);
    first = false;
    try {
    await reportChatActivity(cfg, row.auth, "wb2api-" + Date.now(), "");
      reported++;
    } catch {
      failed++;
    }
  }
  return { reported, failed, skipped };
}
