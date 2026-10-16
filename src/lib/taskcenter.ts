// 任务中心（移植 internal/panel/taskcenter.go + tasks.go 的批量/自动动作编排）。
// 语义与 Go 版一致：
//   - 扫描（scan_all）：并发拉取每账号成长任务（默认+小程序口径），汇总
//     "未完成且可自动化"的待办清单（只读）。
//   - 执行队列（run_queue + queue）：待办按账号分组，账号内串行（per-account 锁）、
//     账号间受并发信号量约束（[1,4]，默认 1）。模块级状态（单容器语义，与 Go 单机等价），
//     同时落库 TaskQueueItem 便于重启后查看最近一轮。
//   - per-account 锁与单任务「一键完成」/「全部完成」共用，互相 409。
import type { AppConfig } from "./config";
import { getConfig } from "./config";
import type { AuthShape } from "./upstream/client";
import { isGlobal } from "./upstream/client";
import {
  listTasks, listTasksMP, acceptTasks, acceptTasksMP,
  claimReward, claimRewardMP, type GrowthTask,
} from "./upstream/tasks";
import {
  autoActionFor, autoActionIndex, isMPTaskCode, taskByCode, taskByCodeMP, taskByCodeWaiting,
  taskProgressText,
} from "./autotask";
import { prisma } from "./db";
import { runlog } from "./runlog";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// reportGapMs / acceptBatchGapMs 对齐上游脚本实测的 1.05s 口径（避免风控）。
export const reportGapMs = 1050;
export const acceptBatchGapMs = 1050;

// ─── per-account 任务锁（对齐 panel.go tryLockAccount/unlockAccount）────────

const accountLocks = new Set<string>();

export function tryLockAccount(uid: string): boolean {
  if (accountLocks.has(uid)) return false;
  accountLocks.add(uid);
  return true;
}
export function unlockAccount(uid: string): void {
  accountLocks.delete(uid);
}

// ─── 扫描（只读）────────────────────────────────────────────────────────────

// growthPending 任务是否"未完成且可自动化"（对齐 taskcenter.go）。
export function growthPending(t: GrowthTask): boolean {
  if (t.claimed) return false;
  // 上游锁定的不出待办：Sequential 族每日零点解锁一环，锁定窗口扫进队列只会
  // accept 不落账报失败；零点解锁后自然回到待办。
  if (t.locked) return false;
  // 达标未领也入队（执行后自动领），但仅限有自动化动作的任务。
  return autoActionFor(t.task_code) != null;
}

export interface ScanAccountItem {
  uid: string;
  nickname: string;
  growth?: GrowthTask[];
  growth_error?: string;
}

export interface TaskAccountRow {
  uid: string;
  nickname: string;
  realm: string;
  enterpriseId: string;
  disabled: boolean;
  paused?: boolean;
  auth: AuthShape;
}

// listActiveAccounts 拉取启用账号及其凭证（全量扫描/队列共用）。
// includeDisabled=true 时（schedule.include_disabled_in_tasks）禁用号也参与——
// 对齐 Go：禁用只关选号，不停保号（签到/活跃/保活/余额照常跑）。
export async function listActiveAccounts(includeDisabled = false): Promise<TaskAccountRow[]> {
  const rows = await prisma.account.findMany({
    ...(includeDisabled ? {} : { where: { state: { is: { disabled: false } } } }),
    orderBy: { createdAt: "asc" },
    include: { state: true },
  });
  return rows.map((r) => ({
    uid: r.uid,
    nickname: r.nickname,
    realm: r.realm,
    enterpriseId: r.enterpriseId,
    disabled: r.state?.disabled ?? false,
    paused: r.state?.paused ?? false,
    auth: {
      uid: r.uid,
      nickname: r.nickname,
      realm: r.realm,
      accessToken: r.accessToken,
      refreshToken: r.refreshToken,
      expiresAt: Number(r.expiresAt),
      domain: r.domain,
      enterpriseId: r.enterpriseId,
      deviceToken: r.deviceToken,
    },
  }));
}

// scanAccountGrowth 单账号待办扫描（默认口径 + mp 口径合并去重；global/企业门控）。
async function scanAccountGrowth(cfg: AppConfig, row: TaskAccountRow): Promise<ScanAccountItem> {
  const it: ScanAccountItem = { uid: row.uid, nickname: row.nickname };
  // D4 门控：global 账号无 CN 成长任务体系；企业版无个人成长体系（上游 403）。
  if (isGlobal(row.auth) || row.enterpriseId !== "") return it;
  const growth: GrowthTask[] = [];
  try {
    for (const t of await listTasks(cfg, row.auth)) {
      if (growthPending(t)) growth.push(t);
    }
  } catch (e) {
    it.growth_error = e instanceof Error ? e.message : String(e);
  }
  // mp 口径是默认口径超集，按 task_code 去重；失败静默。
  try {
    const seen = new Set(growth.map((t) => t.task_code));
    for (const t of await listTasksMP(cfg, row.auth)) {
      if (growthPending(t) && !seen.has(t.task_code)) growth.push(t);
    }
  } catch { /* mp 列表失败静默 */ }
  if (growth.length > 0) it.growth = growth;
  return it;
}

// tasksScanAll 扫描全部账号待办（并发拉取；对齐 tasksScanAll）。
// 返回口径与 Go 版一致：accounts 只含有待办或有错误的账号，pending_count 为总待办数。
export async function tasksScanAll(cfg: AppConfig) {
  const rows = await listActiveAccounts();
  const scanned = await Promise.all(rows.map((r) => scanAccountGrowth(cfg, r)));
  const accounts = scanned.filter((it) => it.growth != null || it.growth_error != null);
  const pending = accounts.reduce((n, it) => n + (it.growth?.length ?? 0), 0);
  runlog("school 扫描完成：" + accounts.length + " 个账号有待办，共 " + pending + " 项");
  return { accounts, pending_count: pending };
}

// ─── 执行队列 ───────────────────────────────────────────────────────────────

export interface QueueItem {
  uid: string;
  nickname: string;
  kind: string; // growth
  code: string;
  status: string; // pending | running | done | skipped | error
  message?: string;
}

// queueState 队列运行状态。seq 每轮 +1——前端只渲染"自己启动的那一轮"。
interface QueueState {
  running: boolean;
  startedAt: Date | null;
  items: QueueItem[];
  conc: number;
  seq: number;
}

// 模块级全局（Next dev 热更新与多 chunk 下保持单例）。
const g = globalThis as unknown as { __wbQueue?: QueueState };
const q: QueueState = g.__wbQueue ?? (g.__wbQueue = {
  running: false, startedAt: null, items: [], conc: 1, seq: 0,
});

export function queueStatus() {
  return {
    running: q.running,
    total: q.items.length,
    conc: q.conc,
    started: q.startedAt != null,
    started_at: q.startedAt,
    seq: q.seq,
    items: q.items.map((it) => ({ ...it })),
  };
}

interface QueueAccount {
  row: TaskAccountRow;
  grow: GrowthTask[];
}

// startGrowthQueue 扫描全部账号待办并启动队列。返回 seq==-1 表示冲突（已在跑）；
// started=false 时 msg 为无可执行待办的说明。
export async function startGrowthQueue(
  concurrency: number, growth: boolean,
): Promise<{ started: boolean; total: number; seq: number; msg: string }> {
  const conc = Math.min(4, Math.max(1, concurrency || 1));
  if (q.running) {
    return { started: false, total: 0, seq: -1, msg: "队列正在执行中（可在任务中心查看进度）" };
  }
  // 先占位：扫描（数秒级）期间并发触发直接命中 running 判拒。无待办时回滚。
  q.running = true;
  q.startedAt = new Date();

  const cfg = await getConfig();
  const rows = await listActiveAccounts();
  const accts: QueueAccount[] = [];
  if (growth) {
    const scanned = await Promise.all(rows.map(async (row) => {
      if (isGlobal(row.auth) || row.enterpriseId !== "") return null;
      let grow: GrowthTask[] = [];
      try {
        grow = (await listTasks(cfg, row.auth)).filter(growthPending);
        const seen = new Set(grow.map((t) => t.task_code));
        try {
          for (const t of await listTasksMP(cfg, row.auth)) {
            if (growthPending(t) && !seen.has(t.task_code)) grow.push(t);
          }
        } catch { /* mp 失败静默 */ }
        // 按 autoActions 顺序（依赖前置）。
        grow.sort((x, y) => autoActionIndex(x.task_code) - autoActionIndex(y.task_code));
      } catch { /* 列表失败则该账号无待办 */ }
      return grow.length > 0 ? { row, grow } : null;
    }));
    for (const s of scanned) if (s) accts.push(s);
  }

  const items: QueueItem[] = [];
  for (const one of accts) {
    for (const t of one.grow) {
      items.push({ uid: one.row.uid, nickname: one.row.nickname, kind: "growth", code: t.task_code, status: "pending" });
    }
  }
  if (items.length === 0) {
    q.running = false;
    q.startedAt = null;
    return { started: false, total: 0, seq: 0, msg: "全部账号没有待办任务" };
  }

  q.items = items;
  q.conc = conc;
  q.seq++;
  const seq = q.seq;

  // 落库（TaskQueueItem：重启后可回看最近一轮）。失败不影响内存队列。
  void prisma.taskQueueItem.deleteMany({}).then(() =>
    prisma.taskQueueItem.createMany({
      data: items.map((it) => ({
        uid: it.uid, taskCode: it.code, title: it.nickname, mp: isMPTaskCode(it.code),
        status: it.status, result: "",
      })),
    }),
  ).catch(() => { /* noop */ });

  void runQueueItems(cfg, accts, conc);
  runlog("school 队列已启动：" + items.length + " 项待办，并发 " + conc);
  return { started: true, total: items.length, seq, msg: "" };
}

// runQueueItems 队列执行主体：账号间并发（计数信号量）、账号内串行。
async function runQueueItems(cfg: AppConfig, accts: QueueAccount[], concurrency: number) {
  try {
    let active = 0;
    await Promise.all(accts.map((one) => (async () => {
      // 并发信号量（账号级）。
      while (active >= concurrency) await sleep(200);
      active++;
      try {
        // per-account 互斥：与单任务/一键完成共用一把锁。
        if (!tryLockAccount(one.row.uid)) {
          for (const it of q.items) {
            if (it.uid === one.row.uid) {
              it.status = "skipped";
              it.message = "该账号有其它任务动作在执行，跳过";
            }
          }
          return;
        }
        try {
          // 前置：批量接受尚未接受的任务（上游对 not_accepted 的任务不计数）。
          const accepted = await acceptPendingTasks(cfg, one.row.auth);
          if (accepted > 0) await sleep(reportGapMs);
          for (const it of q.items) {
            if (it.uid !== one.row.uid) continue;
            it.status = "running";
            try {
              it.message = await runGrowthQueued(cfg, one.row.auth, it.code);
              it.status = "done";
            } catch (e) {
              it.status = "error";
              it.message = e instanceof Error ? e.message : String(e);
            }
            await sleep(reportGapMs); // 项间节流
          }
        } finally {
          unlockAccount(one.row.uid);
        }
      } finally {
        active--;
      }
    })()));
  } finally {
    q.running = false;
    const done = q.items.filter((i) => i.status === "done").length;
    const err = q.items.filter((i) => i.status === "error").length;
    runlog("school 队列已结束：done=" + done + " error=" + err + " skipped=" + (q.items.length - done - err));
  }
}

// acceptPendingTasks 批量接受该账号未接受的任务（失败返回 0 不阻塞）。
async function acceptPendingTasks(cfg: AppConfig, a: AuthShape): Promise<number> {
  let tasks: GrowthTask[];
  try {
    tasks = await listTasks(cfg, a);
  } catch {
    return 0;
  }
  const codes = tasks
    .filter((t) => !t.claimed && !t.locked && t.accept_status !== "accepted" && t.accept_status !== "completed")
    .map((t) => t.task_code);
  if (codes.length === 0) return 0;
  try {
    await acceptTasks(cfg, a, codes);
    return codes.length;
  } catch {
    return 0;
  }
}

// runGrowthQueued 执行单个成长任务（动作 + 回读 + 自动领奖；与 accountTaskAuto 同语义）。
export async function runGrowthQueued(cfg: AppConfig, a: AuthShape, code: string): Promise<string> {
  const act = autoActionFor(code);
  if (!act) throw new Error("任务 " + code + " 无自动动作");
  const before = await taskByCode(cfg, a, code);
  if (before == null) return "该账号无此任务";
  const mp = isMPTaskCode(code);
  if (before.claimed) return "已完成（已领取）";
  const msg = await act.run(cfg, a);
  const after = mp ? await taskByCodeMP(cfg, a, code).catch(() => null)
    : await taskByCodeWaiting(cfg, a, code).catch(() => null);
  let out = msg;
  if (after?.claimable) {
    try {
      const r = mp ? await claimRewardMP(cfg, a, code) : await claimReward(cfg, a, code);
      if (r.credit > 0 || r.energy > 0) {
        out += "；自动领奖 +" + r.credit + " 分 +" + r.energy + " 能";
      }
    } catch { /* 领奖失败不掩盖主流程 */ }
  }
  if (after) out += "（进度 " + taskProgressText(after) + "）";
  return out;
}

// ─── 接受 / 领奖（tasks.go HTTP 层的库函数部分）──────────────────────────────

// mergedTaskList 默认口径 + mp 口径合并（mp 是超集，按 task_code 去重；失败静默）。
export async function mergedTaskList(cfg: AppConfig, a: AuthShape): Promise<GrowthTask[]> {
  const tasks = await listTasks(cfg, a);
  try {
    const seen = new Set(tasks.map((t) => t.task_code));
    for (const t of await listTasksMP(cfg, a)) {
      if (!seen.has(t.task_code)) {
        tasks.push(t);
        seen.add(t.task_code);
      }
    }
  } catch { /* mp 失败静默 */ }
  return tasks;
}

// taskAcceptAll 接受全部尚未接受的任务（分片 20 个/批，批间 1.05s 节流；mp 码单独 mp 口径接受）。
export async function taskAcceptAll(
  cfg: AppConfig, a: AuthShape,
): Promise<{ accepted: number; failed: string[] }> {
  const tasks = await listTasks(cfg, a);
  const codes = tasks
    .filter((t) => !t.claimed && !t.locked && t.accept_status !== "accepted" && t.accept_status !== "completed")
    .map((t) => t.task_code);
  let accepted = 0;
  const failed: string[] = [];
  const batch = 20;
  for (let i = 0; i < codes.length; i += batch) {
    const part = codes.slice(i, i + batch);
    try {
      await acceptTasks(cfg, a, part);
      accepted += part.length;
    } catch {
      failed.push(...part);
    }
    await sleep(acceptBatchGapMs);
  }
  // 小程序口径任务单独批量接受（accept 也要求 mp 头）。
  try {
    const mpTasks = await listTasksMP(cfg, a);
    const mpCodes = mpTasks
      .filter((t) => !t.claimed && !t.locked && t.accept_status !== "accepted" && t.accept_status !== "completed")
      .map((t) => t.task_code);
    if (mpCodes.length > 0) {
      try {
        await acceptTasksMP(cfg, a, mpCodes);
        accepted += mpCodes.length;
      } catch {
        failed.push(...mpCodes);
      }
      await sleep(acceptBatchGapMs);
    }
  } catch { /* mp 列表失败静默 */ }
  return { accepted, failed };
}

// claimTaskReward 领取奖励（mp 码走 mp 口径，其余 Web 域）。
export async function claimTaskReward(
  cfg: AppConfig, a: AuthShape, code: string,
): Promise<{ credit: number; energy: number }> {
  return isMPTaskCode(code) ? claimRewardMP(cfg, a, code) : claimReward(cfg, a, code);
}


