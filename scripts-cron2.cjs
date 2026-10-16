const fs = require("fs");
const path = require("path");

// 1) 追加 schoolVouchers 到 src/lib/upstream/tasks.ts
const tasksPath = "src/lib/upstream/tasks.ts";
let tasks = fs.readFileSync(tasksPath, "utf8");
tasks += String.raw`
// ─── 开学季券码（school.go；活动期只读查询）───────────────────────────────────

export interface SchoolVoucher {
  grant_id: number;
  draw_uuid?: string;
  sku_code?: string;   // kfc_ice_cream / voucher_luckin / voucher_kugou …
  prize_name?: string; // 肯德基冰淇淋
  code: string;        // 券码本体（复制给店员核销）
  valid_from?: string;
  valid_to?: string;   // "2026-10-24"
  granted_at?: string; // RFC3339
}

// schoolVouchers 查询账号的开学季券码列表（billing 同域 /portal/activity/school/vouchers）。
export async function schoolVouchers(cfg: AppConfig, a: AuthShape): Promise<SchoolVoucher[]> {
  const { billingBase } = await import("./client");
  const data = (await doGrowthJSON(
    billingBase(a) + "/portal/activity/school/vouchers",
    billingHeaders(cfg, a), "GET", null,
  )) as { items?: SchoolVoucher[] } | null;
  return data?.items ?? [];
}
`;
fs.writeFileSync(tasksPath, tasks, "utf8");
console.log("tasks.ts appended");

// 2) 追加 travelAll / activityAll 到 src/lib/cron.ts
const cronPath = "src/lib/cron.ts";
let cron = fs.readFileSync(cronPath, "utf8");
cron += String.raw`

// ─── 旅行巡检 / 活跃上报（移植 scheduler/travel.go、runActivity）───────────────

import {
  buddyInfo, buddyAgreement, buddyFirst, travelStatus, travelDepart, travelClaim,
} from "./upstream/tasks";
import { reportGapMs } from "./taskcenter";

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
  const { listActiveAccounts } = await import("./taskcenter");
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
    const { reportChatActivity } = await import("./upstream/report");
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
  const { listActiveAccounts } = await import("./taskcenter");
  const rows = await listActiveAccounts();
  let reported = 0, failed = 0, skipped = 0;
  let first = true;
  for (const row of rows) {
    if (!row.auth.accessToken) { skipped++; continue; }
    if (row.enterpriseId !== "") { skipped++; continue; }
    if (!first) await sleep(travelAccountDelayMs);
    first = false;
    try {
      const { reportChatActivity } = await import("./upstream/report");
      await reportChatActivity(cfg, aAuth(row), "wb2api-" + Date.now(), "");
      reported++;
    } catch {
      failed++;
    }
  }
  return { reported, failed, skipped };
}
function aAuth(row: { auth: AuthShape }): AuthShape { return row.auth; }
`;
fs.writeFileSync(cronPath, cron, "utf8");
console.log("cron.ts appended");
