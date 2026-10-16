// scheduler.ts 进程内调度器（移植 internal/scheduler/scheduler.go）。
// 单实例语义：模块级状态挂 globalThis.__wbSched，Next dev 热更新不重复建循环。
// Railway 单容器与 Go 单机等价——四类时点任务 + 独立余额刷新循环，全部本进程内跑。
//
// 时点口径：Asia/Shanghai 整点小时（容器可能是 UTC，绝不能拿本地时区算）。
// 等待：分段 setTimeout（段长 60s）+ 每段墙钟重判（对齐 waitSlot 防容器休眠冻结
// 单调时钟导致错过时点）；迟到唤醒先等 wakeupGrace 网络宽限再派发。
import { getConfig } from "./config";
import { prisma } from "./db";
import * as cron from "./cron";
import * as pool from "./pool";
import { startGrowthQueue } from "./taskcenter";
import { isAlreadyCheckin } from "./upstream/errors";

type TaskKind = "checkin" | "travel" | "activity" | "keepalive" | "blackcat" | "growth";

// ─── 全局单例状态 ────────────────────────────────────────────────────────────
interface SchedState {
  started: boolean;       // 主循环是否已启动
  stop: boolean;          // 优雅停机标志
  rearm: boolean;         // Reconfigure 触发的重排通知
  running: Promise<void> | null;
}
const g = globalThis as unknown as { __wbSched?: SchedState };
const st: SchedState = g.__wbSched ?? (g.__wbSched = {
  started: false, stop: false, rearm: false, running: null,
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// wallclockCheckStep 墙钟校验段长：单次 setTimeout 的最大时长，每段醒来用墙钟重判
// 是否到点（对齐 Go wallclockCheckStep=time.Minute）。容器睡眠冻结计时器时，至多一段
// 之后即到点补跑，偏差上限 = 段长 + 落段余量。
const WALLCLOCK_CHECK_STEP_MS = 60_000;

// wakeupGraceDelay 迟到唤醒补跑派发前的网络宽限（容器从休眠唤醒瞬间网络/DNS 未就绪）。
// 对齐 Go wakeupGraceDelay=5s。只对迟到补跑生效（准点零延迟）。
const WAKEUP_GRACE_MS = 5_000;
// wakeupLateThreshold 迟到判定阈值：晚于槽位计划时刻超过 1s 才算迟到补跑。
const WAKEUP_LATE_THRESHOLD_MS = 1_000;

// shanghaiNow 当前 Asia/Shanghai 时刻的 Date（用其字段构造的本地 Date，
// 时钟值等于上海墙钟）。容器在 UTC 时直接取本地字段会漂移 8 小时。
function shanghaiNow(): Date {
  const s = new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" });
  return new Date(s);
}

// nextFire 返回 now 之后最近的一个整点触发时刻（毫秒时间戳）；hours 为上海本地小时。
// 对齐 Go nextFire：同刻过点则滚到次日同一小时。
function nextFire(now: Date, hours: number[]): number {
  let earliest = 0;
  for (const h of hours) {
    let t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0, 0).getTime();
    if (t <= now.getTime()) t += 24 * 3600_000;
    if (earliest === 0 || t < earliest) earliest = t;
  }
  return earliest;
}

interface Slot { at: number; kind: TaskKind; }

// nextWake 返回最近的唤醒时刻与该时刻需执行的全部任务（多任务同刻并行）。
// 对齐 Go nextWake：已禁用任务不进候选；全部禁用返回 0。
async function nextWake(now: Date): Promise<{ at: number; kinds: TaskKind[] }> {
  const cfg = await getConfig();
  const slots: Slot[] = [];
  if (!cfg.schedule_checkin_disabled) slots.push({ at: nextFire(now, cfg.schedule_checkin_hours), kind: "checkin" });
  if (!cfg.schedule_travel_disabled) slots.push({ at: nextFire(now, cfg.schedule_travel_hours), kind: "travel" });
  if (!cfg.schedule_activity_disabled) slots.push({ at: nextFire(now, cfg.schedule_activity_hours), kind: "activity" });
  if (!cfg.schedule_keepalive_disabled) slots.push({ at: nextFire(now, cfg.schedule_keepalive_hours), kind: "keepalive" });
  if (!cfg.schedule_blackcat_disabled) slots.push({ at: nextFire(now, cfg.schedule_blackcat_hours), kind: "blackcat" });
  if (!cfg.schedule_growth_disabled) slots.push({ at: nextFire(now, cfg.schedule_growth_hours), kind: "growth" });
  let earliest = 0;
  for (const s of slots) {
    if (s.at === 0) continue;
    if (earliest === 0 || s.at < earliest) earliest = s.at;
  }
  if (earliest === 0) return { at: 0, kinds: [] };
  return { at: earliest, kinds: slots.filter((s) => s.at === earliest).map((s) => s.kind) };
}

type SlotWake = "fired" | "rearm" | "stop";

// waitSlot 分段等到墙钟到达 next：每段 setTimeout 上限 60s，段末回到循环顶用墙钟重判。
// rearm（在线改配置重排）/stop 在每段间随时被检查。
async function waitSlot(next: number): Promise<SlotWake> {
  for (;;) {
    if (st.stop) return "stop";
    if (st.rearm) { st.rearm = false; return "rearm"; }
    const wallRemain = next - shanghaiNow().getTime();
    if (wallRemain <= 0) return "fired";
    await sleep(Math.min(wallRemain, WALLCLOCK_CHECK_STEP_MS));
  }
}

// inNightWindow 当前是否处于夜猫子计数窗口（23:00–08:00 Asia/Shanghai）。
function inNightWindow(): boolean {
  const h = shanghaiNow().getHours();
  return h >= 23 || h < 8;
}

// ─── 各任务执行体 ────────────────────────────────────────────────────────────

// 签到：仅 CN 非企业号；含余额回写（签到成功的解冻语义在 pool.setCreditsDetailed 内）。
// 对齐 Go RunCheckinNow：签到 + UserResourceDetailedWithExpiry + ReenableIfCredits。
async function execCheckin(): Promise<void> {
  const cfg = await getConfig();
  const includeDisabled = cfg.schedule_include_disabled_in_tasks;
  const accounts = await prisma.account.findMany({ include: { state: true } });
  for (const a of accounts) {
    if ((a.state?.disabled ?? false) && !includeDisabled) continue;
    if (!a.refreshToken) continue;
    if (a.realm === "global") continue; // D4 门控：global 无 CN 任务体系
    const shape = {
      uid: a.uid, nickname: a.nickname, realm: a.realm,
      accessToken: a.accessToken, refreshToken: a.refreshToken,
      expiresAt: Number(a.expiresAt), domain: a.domain,
      enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
    };
    // 企业版无签到体系（daily-checkin 400 code 10001），但余额查询照常跑。
    if (a.enterpriseId === "") {
      try {
        const { dailyCheckin } = await import("./upstream/client");
        await dailyCheckin(cfg, shape);
        await pool.markCheckin(a.uid);
        console.log("[scheduler] checkin " + a.uid + ": 签到成功");
      } catch (e) {
        if (isAlreadyCheckin(e)) {
          await pool.markCheckin(a.uid);
          console.log("[scheduler] checkin " + a.uid + ": 今天已签到（幂等）");
        } else {
          console.log("[scheduler] checkin " + a.uid + ": " + (e instanceof Error ? e.message : String(e)));
        }
      }
    }
    // 余额回写（含快过期窗口；earliest 明细待 P4 userResourceDetailedWithExpiry 实装）。
    try {
      const { userResource } = await import("./upstream/client");
      const r = await userResource(cfg, shape);
      await pool.setCreditsDetailed(a.uid, BigInt(r.remain), BigInt(r.total), 0n, 0n, 0n);
    } catch (e) {
      console.log("[scheduler] user-resource " + a.uid + ": " + (e instanceof Error ? e.message : String(e)));
    }
  }
  // TODO(P4): RunStreakBonusNow 连登管家（可兑换档位自动兑换 + 抽奖）。
}

async function execTravel(): Promise<void> {
  const r = await cron.runTravelNow();
  console.log("[scheduler] travel: adopted=" + r.adopted + " departed=" + r.departed + " claimed=" + r.claimed + " skipped=" + r.skipped);
}

async function execActivity(): Promise<void> {
  const r = await cron.runActivityNow();
  console.log("[scheduler] activity: reported=" + r.reported + " failed=" + r.failed + " skipped=" + r.skipped);
}

async function execKeepalive(): Promise<void> {
  const r = await cron.runKeepalive();
  console.log("[scheduler] keepalive: refreshed=" + r.refreshed + " skipped=" + r.skipped + " failed=" + r.failed);
}

// 夜猫子：23:00–08:00 窗口内对池内账号补足 glm 对话并上报事件链。
// TODO(P4)：真实对话链路（BlackcatNeed/RunNightChats 依赖 events_desktop 上报链）。
// 当前仅做窗口判定 + 门控账号过滤并打日志，不发起上游调用。
async function execBlackcat(): Promise<void> {
  if (!inNightWindow()) {
    console.log("[scheduler] blackcat: 当前不在 23:00-08:00 计数窗口，跳过");
    return;
  }
  const rows = await prisma.account.findMany({ include: { state: true } });
  let considered = 0;
  for (const a of rows) {
    if (a.state?.disabled) continue;
    if (a.state?.paused) continue; // 夜猫子是唯一「整任务真实模型对话」，与让位防风控冲突
    if (!a.accessToken) continue;
    if (a.realm === "global") continue; // D4 门控
    if (a.enterpriseId !== "") continue; // 企业版无成长体系
    considered++;
  }
  console.log("[scheduler] blackcat: 窗口内 " + considered + " 账号待补足（真实对话链路 P4 实装）");
}

// 成长任务队列：时点触发等同于面板「执行全部待办」（sequential 并发 1，扫描+执行）。
// 对齐 Go GrowthHook = panel.RunGrowthQueueOnce。
function execGrowth(): void {
  void startGrowthQueue(1, true).then((r) => {
    console.log("[scheduler] growth: " + (r.started ? "队列已启动 total=" + r.total : r.msg));
  }).catch((e) => {
    console.log("[scheduler] growth: " + (e instanceof Error ? e.message : String(e)));
  });
}

// runBatch 并行派发一批任务（同一唤醒时刻的多类任务），等全部完成返回。
async function runBatch(kinds: TaskKind[]): Promise<void> {
  const jobs = kinds.map((k) => (async () => {
    try {
      switch (k) {
        case "checkin": await execCheckin(); break;
        case "travel": await execTravel(); break;
        case "activity": await execActivity(); break;
        case "keepalive": await execKeepalive(); break;
        case "blackcat": await execBlackcat(); break;
        case "growth": execGrowth(); break;
      }
    } catch (e) {
      console.log("[scheduler] task " + k + " error: " + (e instanceof Error ? e.message : String(e)));
    }
  })());
  await Promise.all(jobs);
}

// ─── 主循环 ─────────────────────────────────────────────────────────────────
async function mainLoop(): Promise<void> {
  for (;;) {
    if (st.stop) return;
    const { at, kinds } = await nextWake(shanghaiNow());
    if (at === 0) {
      // 全部禁用：不空转，等重排通知或停机。每分钟醒一次检查 rearm/stop。
      for (;;) {
        if (st.stop) return;
        if (st.rearm) { st.rearm = false; break; }
        await sleep(WALLCLOCK_CHECK_STEP_MS);
      }
      continue;
    }
    const wake = await waitSlot(at);
    if (wake === "stop") return;
    if (wake === "rearm") continue;
    // 迟到唤醒先等网络宽限（容器休眠唤醒瞬间网络未就绪）。
    if (shanghaiNow().getTime() - at > WAKEUP_LATE_THRESHOLD_MS) {
      console.log("[scheduler] wakeup grace " + WAKEUP_GRACE_MS + "ms: late catch-up for slot");
      await sleep(WAKEUP_GRACE_MS);
      if (st.stop) return;
    }
    await runBatch(kinds);
  }
}

// ─── 余额刷新独立循环 ────────────────────────────────────────────────────────
async function balanceLoop(): Promise<void> {
  for (;;) {
    if (st.stop) return;
    const cfg = await getConfig();
    const intervalMs = cfg.schedule_balance_refresh_enabled
      ? cfg.schedule_balance_refresh_minutes * 60_000 : 0;
    if (intervalMs <= 0) {
      // 暂停：每分钟醒一次等重排/停机。
      for (;;) {
        if (st.stop) return;
        if (st.rearm) { st.rearm = false; break; }
        await sleep(WALLCLOCK_CHECK_STEP_MS);
      }
      continue;
    }
    // 每段睡眠间检查 rearm/stop，保证热配与停机响应性。
    let waited = 0;
    while (waited < intervalMs) {
      if (st.stop) return;
      if (st.rearm) { st.rearm = false; break; }
      const step = Math.min(intervalMs - waited, WALLCLOCK_CHECK_STEP_MS);
      await sleep(step);
      waited += step;
    }
    if (st.stop) return;
    if (waited < intervalMs) continue; // 被 rearm 打断：重算间隔
    try {
      const r = await cron.runBalanceRefresh();
      console.log("[scheduler] balance: updated=" + r.updated + " failed=" + r.failed);
    } catch (e) {
      console.log("[scheduler] balance error: " + (e instanceof Error ? e.message : String(e)));
    }
  }
}

// ─── 对外接口 ────────────────────────────────────────────────────────────────
// startScheduler 幂等启动主循环 + 余额循环（instrumentation register 调用一次）。
export function startScheduler(): void {
  if (st.started) return;
  st.started = true;
  st.stop = false;
  void mainLoop();
  void balanceLoop();
  console.log("[scheduler] started (Asia/Shanghai 整点时口径)");
}

// reconfigure 热更新排程参数：置重排标志，两个循环在下一段睡眠边界消费重算。
// 对齐 Go Reconfigure + SetBalanceInterval（面板保存配置后调用）。
export function reconfigure(): void {
  st.rearm = true;
}

// stopScheduler 优雅停机（测试/调试；生产容器靠进程退出）。
export function stopScheduler(): void {
  st.stop = true;
}
