const fs = require("fs");
const content = String.raw`
// 自动任务编排（移植 internal/panel/autotask.go 的框架部分）。
// 动作表（25 个任务码，顺序即依赖序）+ mp 口径登记 + 回读/领奖工具 +
// runAutoAll 全量执行。具体 run 实现在 ./autotask-actions.ts（逐步实装）。
import type { AppConfig } from "./config";
import type { AuthShape } from "./upstream/client";
import {
  listTasks, listTasksMP, acceptTasksMP, claimReward, claimRewardMP, type GrowthTask,
} from "./upstream/tasks";
import { reportGapMs } from "./taskcenter";
import * as actions from "./autotask-actions";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── 动作表（顺序即执行顺序：先解锁依赖项）──────────────────────────────────

export interface TaskAction {
  taskCode: string;
  desc: string;
  attempt: boolean; // true = 尝试型（上游未证实可脚本化）
  run: (cfg: AppConfig, a: AuthShape) => Promise<string>;
}

export const autoActions: TaskAction[] = [
  { taskCode: "chat_5", desc: "上报 5 条对话活跃事件（自动补足差额）", attempt: false, run: actions.runChat5 },
  { taskCode: "first_buddy", desc: "上报解锁 → 同意协议 → 领取第一只 Buddy（+300 分）", attempt: false, run: actions.runFirstBuddy },
  { taskCode: "Model_chat_GLM5.2", desc: "接受任务 → glm-5.2 真实对话一次 → 对齐模型上报", attempt: false, run: actions.runModelChat },
  { taskCode: "RichMeow_Chat", desc: "桌面指纹事件链上报（纯 API 可点亮）", attempt: false, run: actions.runRichMeow },
  { taskCode: "Buddy_App", desc: "上报「进入 Buddy 应用」事件链", attempt: false, run: actions.runBuddyApp },
  { taskCode: "Buddy_App_QQ", desc: "上报「进入企鹅教师助手」事件链", attempt: false, run: actions.runBuddyApp },
  { taskCode: "automation_1", desc: "上报「定时任务创建」事件", attempt: false, run: actions.runAutomationCreate },
  { taskCode: "Library_read", desc: "上报「读资料库介绍」事件", attempt: false, run: actions.runLibraryRead },
  { taskCode: "template_5", desc: "上报「使用模板创建任务」事件组 ×5", attempt: false, run: actions.runTemplateUse },
  { taskCode: "playbook_prompt", desc: "上报「灵感案例做同款发送 Prompt」事件组", attempt: false, run: actions.runPlaybookPrompt },
  { taskCode: "create_canvas", desc: "上报「设计创意画布创建」事件组（+300 分）", attempt: false, run: actions.runCreateCanvas },
  { taskCode: "expert_5", desc: "真实专家召唤+使用链 ×5", attempt: false, run: actions.runExpertUse },
  { taskCode: "Expert_team_use_3", desc: "真实专家团召唤+使用链 ×3", attempt: false, run: actions.runExpertTeamUse },
  { taskCode: "Hp_Appearance", desc: "设置主题 API + 皮肤生效事件", attempt: false, run: actions.runAppearance },
  { taskCode: "skill_1", desc: "真实对话 + skill_info 技能加载事件", attempt: false, run: actions.runSkillFresh },
  { taskCode: "Expert_lighthouse", desc: "真实轻量云专家召唤+使用链", attempt: false, run: actions.runExpertLighthouse },
  { taskCode: "black_cat", desc: "夜猫子：23:00–08:00 窗口内 glm-5.2 对话补足", attempt: true, run: actions.runBlackCat },
  { taskCode: "school_season", desc: "校园日（小程序口径）：accept → mini 对话+activityId 上报 → 领奖", attempt: false, run: actions.runSchoolSeason },
  { taskCode: "Sequential_Tasks_1", desc: "小程序首对话（小程序口径）", attempt: false, run: actions.runSequentialChat },
  { taskCode: "Sequential_Tasks_2", desc: "小程序选专家对话（小程序口径）", attempt: false, run: actions.runMiniExpert },
  { taskCode: "Sequential_Tasks_3", desc: "小程序五次对话（小程序口径）", attempt: false, run: actions.runSequentialChat5 },
  { taskCode: "Sequential_Tasks_4", desc: "小程序定时任务（预留，每日零点解锁一环）", attempt: true, run: actions.runSequentialAutomation },
  { taskCode: "Sequential_Tasks_5", desc: "小程序使用 GLM5.2（预留）", attempt: true, run: actions.runSequentialModelChat },
  { taskCode: "Sequential_Tasks_6", desc: "小程序十次对话（预留）", attempt: true, run: actions.runSequentialChat10 },
  { taskCode: "Sequential_Tasks_7", desc: "体验灵感功能（预留）", attempt: true, run: actions.runSequentialPlaybook },
];

export function autoActionFor(code: string): TaskAction | null {
  const c = code.trim();
  return autoActions.find((a) => a.taskCode === c) ?? null;
}

export function autoActionIndex(code: string): number {
  const i = autoActions.findIndex((a) => a.taskCode === code);
  return i >= 0 ? i : 1 << 20;
}

// mpTaskCodes 小程序口径专属下发的成长任务：accept/claim 均要求 X-Client-Platform: miniprogram。
const mpTaskCodes = new Set([
  "school_season",
  "Sequential_Tasks_1", "Sequential_Tasks_2", "Sequential_Tasks_3",
  "Sequential_Tasks_4", "Sequential_Tasks_5", "Sequential_Tasks_6", "Sequential_Tasks_7",
]);

export const isMPTaskCode = (code: string): boolean => mpTaskCodes.has(code);

// ─── 任务查询（双口径 + 异步计分有界轮询）────────────────────────────────────

// taskByCode 默认列表定位任务；mp 专属码自动回落 mp 列表。
export async function taskByCode(cfg: AppConfig, a: AuthShape, code: string): Promise<GrowthTask | null> {
  const tasks = await listTasks(cfg, a);
  const t = tasks.find((x) => x.task_code === code);
  if (t) return t;
  if (isMPTaskCode(code)) return taskByCodeMP(cfg, a, code);
  return null;
}

export async function taskByCodeMP(cfg: AppConfig, a: AuthShape, code: string): Promise<GrowthTask | null> {
  const tasks = await listTasksMP(cfg, a);
  return tasks.find((x) => x.task_code === code) ?? null;
}

// claimPollAttempts / claimPollGapMs 达标回读的有界轮询参数。
// 背景：上游计分是异步的——行为事件上报后进度要数秒才刷新，一次性回读会误判
// "未达标"。最多轮询 N 次、每次间隔 gap，总预算约 12 秒。
export const claimPollAttempts = 4;
export const claimPollGapMs = 3000;

// taskByCodeWaiting 回读任务，未达标则在有界预算内轮询等待（上游异步计分）。
export async function taskByCodeWaiting(cfg: AppConfig, a: AuthShape, code: string): Promise<GrowthTask | null> {
  let t = await taskByCode(cfg, a, code);
  if (t == null || t.claimable || t.claimed) return t;
  for (let i = 1; i < claimPollAttempts; i++) {
    await sleep(claimPollGapMs);
    let t2: GrowthTask | null = null;
    try { t2 = await taskByCode(cfg, a, code); } catch { /* 轮询失败不覆盖已有结果 */ }
    if (t2 != null) {
      t = t2;
      if (t.claimable || t.claimed) return t;
    }
  }
  return t;
}

// mpActionGapMs mp 任务写动作间隔（accept/上报/领奖之间，防频控）。
export const mpActionGapMs = 2000;

// mpChatEventGapMs mp 对话事件（chat_request_send）的真人节奏间隔。
// 上游反作弊：连发事件先计入后被整体回滚（实测 2s 连发 4 条全灭，45s 间隔全存活）。
export const mpChatEventGapMs = 45_000;

// acceptWithVerifyMP accept 并回读验证登记生效（上游存在 200+OK 但未落账的形态），
// 未生效重试一次。
export async function acceptWithVerifyMP(cfg: AppConfig, a: AuthShape, code: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await acceptTasksMP(cfg, a, [code]);
    } catch {
      continue;
    }
    await sleep(mpActionGapMs);
    const t = await taskByCodeMP(cfg, a, code).catch(() => null);
    if (t && t.accept_status !== "not_accepted" && t.accept_status !== "") return true;
  }
  return false;
}

// taskProgressText 任务进度的可读表示（回读对比用）。
export function taskProgressText(t: GrowthTask | null): string {
  if (t == null) return "?";
  if (t.target > 0) return t.current + "/" + t.target;
  if (t.claimed) return "claimed";
  return t.accept_status ?? "?";
}

// truncateStr 截断错误文本（避免把上游长响应原样透给前端）。
export function truncateStr(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

// ─── 全量自动完成（runAutoAll / accountTaskAutoAll 的核心）────────────────────

export interface AutoAllItem {
  task_code: string;
  desc?: string;
  status: string; // done | skipped | error
  message: string;
  progress_after?: string;
  claimable?: boolean;
  claimed?: boolean;
  credit?: number;
  energy?: number;
  claim_error?: string;
}

// runAutoAll 对单账号依次执行所有可自动化任务（单项失败不影响后续项）。
// 流程与 Go 版一致：先批量 accept（默认口径 + mp 口径），再按依赖序逐项执行。
export async function runAutoAll(cfg: AppConfig, a: AuthShape): Promise<AutoAllItem[]> {
  const out: AutoAllItem[] = [];

  // 阶段 0：批量接受尚未接受的任务（失败不阻塞——行为事件才是进度唯一判据）。
  try {
    const tasks = await listTasks(cfg, a);
    const codes = tasks
      .filter((t) => !t.claimed && !t.locked && t.accept_status !== "accepted" && t.accept_status !== "completed")
      .map((t) => t.task_code);
    if (codes.length > 0) {
      try {
        const { acceptTasks } = await import("./upstream/tasks");
        await acceptTasks(cfg, a, codes);
        out.push({ task_code: "(批量接受)", status: "done", message: "已接受 " + codes.length + " 个任务" });
        await sleep(reportGapMs);
      } catch (e) {
        out.push({
          task_code: "(批量接受)", status: "error",
          message: "接受任务失败（不阻塞后续）: " + (e instanceof Error ? e.message : String(e)),
        });
      }
    }
  } catch { /* 列表失败静默 */ }

  // 阶段 0b：小程序口径任务单独接受。
  try {
    const mpTasks = await listTasksMP(cfg, a);
    const mpCodes = mpTasks
      .filter((t) => !t.claimed && !t.locked && t.accept_status !== "accepted" && t.accept_status !== "completed")
      .map((t) => t.task_code);
    if (mpCodes.length > 0) {
      try {
        await acceptTasksMP(cfg, a, mpCodes);
        out.push({ task_code: "(批量接受-mp)", status: "done", message: "已接受 " + mpCodes.length + " 个小程序任务" });
        await sleep(reportGapMs);
      } catch (e) {
        out.push({
          task_code: "(批量接受-mp)", status: "error",
          message: "接受小程序任务失败（不阻塞后续）: " + (e instanceof Error ? e.message : String(e)),
        });
      }
    }
  } catch { /* mp 列表失败静默 */ }

  for (const act of autoActions) {
    const item: AutoAllItem = { task_code: act.taskCode, desc: act.desc, status: "done", message: "" };
    let before: GrowthTask | null = null;
    try {
      before = await taskByCode(cfg, a, act.taskCode);
    } catch (e) {
      item.status = "error";
      item.message = "查询失败: " + (e instanceof Error ? e.message : String(e));
      out.push(item);
      continue;
    }
    if (before == null) {
      item.status = "skipped";
      item.message = "该账号无此任务";
      out.push(item);
      continue;
    }
    if (before.claimed || (before.target > 0 && before.current >= before.target)) {
      item.status = "skipped";
      item.message = "已完成（" + taskProgressText(before) + "）";
      out.push(item);
      continue;
    }
    let msg = "";
    try {
      msg = await act.run(cfg, a);
    } catch (e) {
      item.status = "error";
      item.message = e instanceof Error ? e.message : String(e);
      out.push(item);
      continue;
    }
    const mp = isMPTaskCode(act.taskCode);
    const after = mp ? await taskByCodeMP(cfg, a, act.taskCode).catch(() => null)
      : await taskByCodeWaiting(cfg, a, act.taskCode).catch(() => null);
    item.status = "done";
    item.message = msg;
    item.progress_after = taskProgressText(after);
    // 进度达标即自动领奖；领奖失败不掩盖主流程结果。
    if (after?.claimable) {
      item.claimable = true;
      try {
        const r = mp ? await claimRewardMP(cfg, a, act.taskCode) : await claimReward(cfg, a, act.taskCode);
        item.claimed = true;
        item.credit = r.credit;
        item.energy = r.energy;
        item.message = (r.credit > 0 || r.energy > 0)
          ? msg + "；已自动领奖 +" + r.credit + " 分 +" + r.energy + " 能"
          : msg + "；奖励此前已领取";
      } catch (e) {
        item.claim_error = e instanceof Error ? e.message : String(e);
        item.message = msg + "；达标但领奖失败（可在列表手动重试）";
      }
    }
    out.push(item);
    await sleep(reportGapMs); // 项间节流
  }
  return out;
}
`;
fs.writeFileSync("src/lib/autotask.ts", content.trimStart(), "utf8");
console.log("written", content.length);
