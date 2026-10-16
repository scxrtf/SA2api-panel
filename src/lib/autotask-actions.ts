// 任务动作实现（移植 internal/panel/autotask.go 的 25 个 run* 函数，P4 全量实装）。
// 事件形状/间隔/轮询全部按 Go 版实测口径逐字对齐，勿随意精简字段。
// 通用约定：返回 string 为业务结果（含「跳过/稍后重试」语义），throw 为系统错误。
import type { AppConfig } from "./config";
import type { AuthShape } from "./upstream/client";
import { chatStream, truncate, type ChatMeta } from "./upstream/client";
import {
  acceptTasks, acceptTasksMP, claimReward, claimRewardMP, listTasks, listTasksMP,
  buddyAgreement, buddyFirst,
} from "./upstream/tasks";
import { reportChatActivity, reportChatActivityModel } from "./upstream/report";
import { buddyTaskIncompleteMarker } from "./upstream/errors";
import {
  reportDesktopEvent, reportWebEvent, reportMPEvent, setAppearanceTheme,
  desktopChatSequence, desktopBuddyAppSequence, desktopAutomationCreateEvent,
  desktopTemplateUseSequence, desktopPlaybookPromptSequence, desktopDesignCanvasSequence,
  marketExpertList, desktopChatWithExpert, desktopExpertSummonSequence,
  desktopExpertActualUseEvent,
  schoolChatTimesEvents, schoolSeasonChatEvent, miniExpertUseEvent,
  miniChatModelEvent, miniPlaybookEvents, type MarketExpert,
} from "./upstream/desktop";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── 通用工具 ────────────────────────────────────────────────────────────────

// reportGapMs 连续上报间隔（上游脚本实测 1.05s 口径，防风控）。
const reportGapMs = 1050;
// expertSummonGapMs 专家召唤链间隔（真实使用节奏，实测 8s 成功率 100%）。
const expertSummonGapMs = 6000;
// mpActionGapMs mp 任务写动作间隔（accept/上报/领奖之间）。
const mpActionGapMs = 2000;
// mpChatEventGapMs mp 对话事件真人节奏（连发先计数后回滚，45s 间隔全存活）。
const mpChatEventGapMs = 45_000;
const mpChatJitterMaxMs = 10_000;
// claimPollGapMs 达标回读间隔（上游异步计分，总预算 ~12s）。
const claimPollGapMs = 3000;

// nightWindow 上海时区 23:00–08:00 判定（black_cat 计数窗口）。
export function inNightWindow(): boolean {
  const h = Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "numeric", hour12: false }));
  return h >= 23 || h < 8;
}

// msgID 构造（expert/skill JOIN 事件的 messageId 口径）。
const msgOf = (req: string) => "msg-" + req.slice(-8);

// ─── A. 已有基础的低风险动作 ────────────────────────────────────────────────

// runChat5 补足 chat_5 进度：按差额上报 chat_request_send。
export async function runChat5(cfg: AppConfig, a: AuthShape): Promise<string> {
  const tasks = await listTasks(cfg, a);
  const t = tasks.find((x) => x.task_code === "chat_5");
  if (!t) throw new Error("任务不存在");
  const target = t.target > 0 ? t.target : 5;
  const need = target - t.current;
  if (need <= 0) return "进度已达标，无需上报";
  for (let i = 0; i < need; i++) {
    const cid = "wb2api-chat5-" + Date.now() + "-" + i;
    try {
      await reportChatActivity(cfg, a, cid, "");
    } catch (e) {
      return "上报第 " + (i + 1) + "/" + need + " 条失败: " + (e instanceof Error ? e.message : String(e));
    }
    if (i < need - 1) await sleep(reportGapMs);
  }
  return "已补报 " + need + " 条对话事件";
}

// runFirstBuddy 领养：report（解锁前置）→ agreement → first。
export async function runFirstBuddy(cfg: AppConfig, a: AuthShape): Promise<string> {
  try {
    await reportChatActivity(cfg, a, "wb2api-adopt-" + Date.now(), "");
  } catch (e) {
    throw new Error("前置上报: " + (e instanceof Error ? e.message : String(e)));
  }
  await sleep(reportGapMs);
  try {
    await buddyAgreement(cfg, a);
  } catch (e) {
    throw new Error("同意协议: " + (e instanceof Error ? e.message : String(e)));
  }
  try {
    await buddyFirst(cfg, a);
  } catch (e) {
    if (e instanceof Error && e.message.toLowerCase().includes(buddyTaskIncompleteMarker)) {
      return "前置已上报，但领养门槛未过（上游要求当日活跃），请稍后重试";
    }
    throw new Error("领取 Buddy: " + (e instanceof Error ? e.message : String(e)));
  }
  return "已领取 Buddy（+300 分 +8 能量）";
}

// runModelChat Model_chat_GLM5.2：accept → glm-5.2 真实对话 → 对齐模型上报。
export async function runModelChat(cfg: AppConfig, a: AuthShape): Promise<string> {
  const code = "Model_chat_GLM5.2";
  const modelID = "glm-5.2";
  const modelName = "GLM-5.2";
  try {
    await acceptTasks(cfg, a, [code]);
  } catch { /* accept 失败不阻塞——行为事件才是判据 */ }
  await sleep(reportGapMs);
  const body = JSON.stringify({
    model: modelID,
    messages: [{ role: "user", content: "hi，请回复一句话" }],
    stream: true,
  });
  const meta: ChatMeta = { conversationID: "", conversationRequestID: "", traceID: "" };
  const r = await chatStream(cfg, a, body, "", meta);
  if (r.status >= 400) {
    throw new Error("对话失败 http=" + r.status + ": " + truncate(r.respBody ?? "", 160));
  }
  // 读干 SSE（上游强制流式，不读完会残留连接）。
  if (r.body) {
    const rd = r.body.getReader();
    let n = 0;
    for (;;) {
      const x = await rd.read();
      if (x.done) break;
      n += x.value.byteLength;
      if (n > 1 << 20) { void rd.cancel().catch(() => {}); break; }
    }
  }
  await sleep(reportGapMs);
  try {
    await reportChatActivityModel(cfg, a, "wb2api-glm52-" + Date.now(), "", modelID, modelName);
  } catch (e) {
    return "对话已完成，但进度上报失败：" + (e instanceof Error ? e.message : String(e));
  }
  return "已完成 glm-5.2 对话并上报";
}

// ─── B. 桌面指纹纯事件链（三账号实测纯 API 点亮）──────────────────────────

// runRichMeow RichMeow_Chat：桌面端完整对话事件链。
export async function runRichMeow(cfg: AppConfig, a: AuthShape): Promise<string> {
  const ms = Date.now();
  const events = desktopChatSequence(
    "wb2api-rm-" + ms, "wb2api-rm-req-" + ms, "req-" + ms + "-user", "fast-model", "fast-model",
  );
  await reportDesktopEvent(cfg, a, events);
  return "已按桌面端指纹上报完整对话事件链（agent_task_created→chat_response）";
}

// runBuddyApp Buddy_App / Buddy_App_QQ：buddyapp 五连事件（企鹅教师助手载体）。
export async function runBuddyApp(cfg: AppConfig, a: AuthShape): Promise<string> {
  const events = desktopBuddyAppSequence("cb_y5Dy46tPQGGWtueMxXbe", "企鹅教师助手");
  await reportDesktopEvent(cfg, a, events);
  return "已上报 buddyapp 进入五连事件（同时覆盖 Buddy_App 与 Buddy_App_QQ）";
}

// runAutomationCreate automation_1：定时任务创建成功事件。
export async function runAutomationCreate(cfg: AppConfig, a: AuthShape): Promise<string> {
  await reportDesktopEvent(cfg, a, [desktopAutomationCreateEvent("wb2api 自动化")]);
  return "已上报定时任务创建事件";
}

// runLibraryRead Library_read：web 域资料库介绍点击事件。
export async function runLibraryRead(cfg: AppConfig, a: AuthShape): Promise<string> {
  const docURL = "https://www.workbuddy.cn/space/d/o0KWYeynteVv06UnAZqIFm";
  await reportWebEvent(cfg, a, "web_element_click", docURL, "library_doc_intro_click", "WorkBuddy资料库介绍");
  return "已上报资料库介绍阅读事件";
}

// runTemplateUse template_5：五组模板事件（一次上报 5 组 → 5/5）。
export async function runTemplateUse(cfg: AppConfig, a: AuthShape): Promise<string> {
  const templates: [string, string][] = [
    ["1", "深度研究"], ["2", "周报生成"], ["3", "竞品分析"], ["4", "活动策划"], ["5", "代码评审"],
  ];
  for (let i = 0; i < templates.length; i++) {
    const [id, name] = templates[i];
    const ms = Date.now();
    const events = desktopTemplateUseSequence("wb2api-tpl-" + ms + "-" + i, "wb2api-tpl-req-" + ms + "-" + i, id, name);
    try {
      await reportDesktopEvent(cfg, a, events);
    } catch (e) {
      return "第 " + (i + 1) + " 组模板事件上报失败: " + (e instanceof Error ? e.message : String(e));
    }
    await sleep(300);
  }
  return "已上报 template_used ×5";
}

// runPlaybookPrompt playbook_prompt：灵感案例做同款事件组。
export async function runPlaybookPrompt(cfg: AppConfig, a: AuthShape): Promise<string> {
  const ms = Date.now();
  const events = desktopPlaybookPromptSequence(
    "wb2api-pb-" + ms, "wb2api-pb-req-" + ms, "pm-gtm-launch-plan", "新产品上市 GTM 发布计划一页纸",
  );
  await reportDesktopEvent(cfg, a, events);
  return "已上报 playbook_cta_click + playbook_prompt_send";
}

// runCreateCanvas create_canvas：设计创意画布创建事件组（+300 分）。
export async function runCreateCanvas(cfg: AppConfig, a: AuthShape): Promise<string> {
  const ms = Date.now();
  const events = desktopDesignCanvasSequence("wb2api-canvas-" + ms, "wb2api-canvas-req-" + ms);
  await reportDesktopEvent(cfg, a, events);
  return "已上报 wbx_design_canvas_task_create/open";
}

// runAppearance Hp_Appearance：set API 留痕 + appearance_skin_apply 事件。
export async function runAppearance(cfg: AppConfig, a: AuthShape): Promise<string> {
  const themeKey = "theme-tkmw7j"; // 和平精英激战金秋（判据主题）
  try {
    await setAppearanceTheme(cfg, a, themeKey);
  } catch (e) {
    throw new Error("设置主题: " + (e instanceof Error ? e.message : String(e)));
  }
  await sleep(2000);
  await reportDesktopEvent(cfg, a, [{
    eventCode: "appearance_skin_apply", action: "apply", source: "settings_close",
    id: themeKey, vipLevel: 0, series: "", type: "unknown",
  }]);
  return "已设置主题并上报皮肤生效事件";
}

// ─── C. 真实对话链（desktopChatWithExpert 拿服务端 requestId）──────────────

// runSkillFresh skill_1：真实对话 + skill_info 技能加载事件。
export async function runSkillFresh(cfg: AppConfig, a: AuthShape): Promise<string> {
  const { conversationID: conv, requestID: req } = await desktopChatWithExpert(cfg, a, "");
  const msgID = msgOf(req);
  const events = desktopChatSequence(conv, req, msgID, "fast-model", "fast-model");
  for (const ev of events) {
    if (ev["eventCode"] === "chat_message_response") ev["finishReason"] = "tool_calls";
  }
  events.push({
    eventCode: "skill_info",
    id: "润泽小馆·日报撰写",
    skillId: "skill_2097350077599879168",
    skillVersion: "1.0.0",
    toolStatus: "success",
    fileCount: 56,
    source: "workbuddy-desktop",
    conversationId: conv, requestId: req, messageId: msgID,
    requestModelId: "fast-model", requestModelName: "fast-model",
    traceId: req,
  });
  try {
    await reportDesktopEvent(cfg, a, events);
  } catch (e) {
    throw new Error("skill_info 事件: " + (e instanceof Error ? e.message : String(e)));
  }
  return "已上报真实对话 + skill_info 技能加载事件";
}

// runExpertLighthouse Expert_lighthouse：轻量云专家召唤+使用链（LOCAL 模式）。
export async function runExpertLighthouse(cfg: AppConfig, a: AuthShape): Promise<string> {
  const lhID = "ex_2cvvUZQhDyeJ";
  let lh: MarketExpert = {
    expert_id: lhID, expert_type: "agent",
    display_name_zh: "腾讯轻量云专家", profession_zh: "腾讯轻量云专家",
    version: "1.0.2", categories: [],
  };
  try {
    const experts = await marketExpertList(cfg, a, "agent");
    const hit = experts.find((e) => e.expert_id === lhID);
    if (hit) lh = hit;
  } catch { /* 市场列表失败用兜底档案 */ }
  try {
    await reportDesktopEvent(cfg, a, desktopExpertSummonSequence(lh));
  } catch (e) {
    throw new Error("召唤链: " + (e instanceof Error ? e.message : String(e)));
  }
  const { conversationID: conv, requestID: req } = await desktopChatWithExpert(cfg, a, lhID);
  const events = desktopChatSequence(conv, req, msgOf(req), "fast-model", "fast-model");
  for (const ev of events) {
    if (ev["eventCode"] === "agent_task_created") {
      ev["has_expert"] = true;
      ev["expert_id"] = lh.expert_id;
      ev["expert_name"] = lh.display_name_zh;
      ev["expert_industry_id"] = "";
    }
  }
  const use = desktopExpertActualUseEvent(lh, conv, req, "LOCAL");
  // 对齐真实样本细节：轻量云专家 actual_use 的 type 为空、cost=0。
  use["type"] = "";
  use["cost"] = 0;
  events.push(use);
  try {
    await reportDesktopEvent(cfg, a, events);
  } catch (e) {
    throw new Error("使用事件: " + (e instanceof Error ? e.message : String(e)));
  }
  return "已上报轻量云专家召唤+使用链（真实对话 requestId）";
}

// runExpertBatch 专家召唤+使用公共实现（失败逐个继续）。
async function runExpertBatch(cfg: AppConfig, a: AuthShape, expertType: string, count: number): Promise<string> {
  let experts: MarketExpert[];
  try {
    experts = await marketExpertList(cfg, a, expertType);
  } catch (e) {
    throw new Error("拉取专家列表: " + (e instanceof Error ? e.message : String(e)));
  }
  if (experts.length === 0) throw new Error("专家市场列表为空");
  let ok = 0;
  for (let i = 0; i < experts.length && ok < count; i++) {
    const e = experts[i];
    try {
      await reportDesktopEvent(cfg, a, desktopExpertSummonSequence(e));
      const { conversationID: conv, requestID: req } = await desktopChatWithExpert(cfg, a, e.expert_id);
      const events = [
        ...desktopChatSequence(conv, req, msgOf(req), "fast-model", "fast-model"),
        desktopExpertActualUseEvent(e, conv, req, "craft"),
      ];
      await reportDesktopEvent(cfg, a, events);
      ok++;
    } catch { continue; }
    if (i < experts.length - 1) await sleep(expertSummonGapMs);
  }
  return "已对 " + ok + " 位真实专家完成召唤+使用链（类型 " + expertType + "）";
}

export function runExpertUse(cfg: AppConfig, a: AuthShape): Promise<string> {
  return runExpertBatch(cfg, a, "agent", 5);
}
export function runExpertTeamUse(cfg: AppConfig, a: AuthShape): Promise<string> {
  return runExpertBatch(cfg, a, "team", 3);
}

// ─── D. 夜猫子（black_cat）─────────────────────────────────────────────────

// blackcatNeed 查 black_cat 剩余差额（任务不存在/已领返回 0）。
async function blackcatNeed(cfg: AppConfig, a: AuthShape): Promise<number> {
  const tasks = await listTasks(cfg, a);
  for (const t of tasks) {
    if (t.task_code === "black_cat") {
      if (t.claimed || t.current >= t.target) return 0;
      return t.target - t.current;
    }
  }
  return 0;
}

// runNightChats 发 need 次 glm-5.2 真实对话（读干流）并上报事件链。
async function runNightChats(cfg: AppConfig, a: AuthShape, need: number): Promise<{ ok: number; err?: string }> {
  let ok = 0;
  for (let i = 0; i < need; i++) {
    const body = JSON.stringify({
      model: "glm-5.2",
      messages: [{ role: "user", content: "1+1等于几？直接回答。" }],
      stream: true,
    });
    const meta: ChatMeta = { conversationID: "", conversationRequestID: "", traceID: "" };
    let r;
    try {
      r = await chatStream(cfg, a, body, "", meta);
    } catch (e) {
      return { ok, err: "第 " + (i + 1) + " 次对话失败: err=" + (e instanceof Error ? e.message : String(e)) };
    }
    if (r.status >= 400) {
      return { ok, err: "第 " + (i + 1) + " 次对话失败: http=" + r.status + " body=" + truncate(r.respBody ?? "", 120) };
    }
    if (r.body) {
      const rd = r.body.getReader();
      let n = 0;
      for (;;) {
        const x = await rd.read();
        if (x.done) break;
        n += x.value.byteLength;
        if (n > 1 << 20) { void rd.cancel().catch(() => {}); break; }
      }
    }
    try {
      await reportChatActivityModel(cfg, a, "wb2api-night-" + Date.now() + "-" + i, "", "glm-5.2", "GLM-5.2");
    } catch (e) {
      return { ok, err: "第 " + (i + 1) + " 次上报失败: " + (e instanceof Error ? e.message : String(e)) };
    }
    ok++;
    await sleep(4000);
  }
  return { ok };
}

export async function runBlackCat(cfg: AppConfig, a: AuthShape): Promise<string> {
  if (!inNightWindow()) {
    return "当前不在 23:00–08:00 计数窗口，行为不计分；网关会在每日 23 点自动补足";
  }
  let need: number;
  try {
    need = await blackcatNeed(cfg, a);
  } catch (e) {
    throw e;
  }
  if (need <= 0) return "进度已达标，无需补足";
  const r = await runNightChats(cfg, a, need);
  if (r.err) return "完成 " + r.ok + "/" + need + " 次后中断: " + r.err;
  return "已完成 " + r.ok + " 次夜间对话并上报";
}

// ─── E. 小程序口径（school_season + Sequential_Tasks_1..7）────────────────

// mpTaskOne mp 列表定位任务；未找到返回 null（活动未下发）。
async function mpTaskOne(cfg: AppConfig, a: AuthShape, code: string) {
  const tasks = await listTasksMP(cfg, a);
  return tasks.find((x) => x.task_code === code) ?? null;
}

// acceptWithVerifyMP accept 并回读验证登记生效（200+OK 但未落账时重试一次）。
async function acceptWithVerifyMP(cfg: AppConfig, a: AuthShape, code: string): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await acceptTasksMP(cfg, a, [code]);
    } catch { continue; }
    await sleep(mpActionGapMs);
    const t = await mpTaskOne(cfg, a, code).catch(() => null);
    if (t && t.accept_status !== "not_accepted" && t.accept_status !== "") return true;
  }
  return false;
}

// claimMP 领奖并格式化结果（mp claim 失败不覆盖主流程语义，直接抛给上层按 error 记）。
async function claimMP(cfg: AppConfig, a: AuthShape, code: string, prefix: string): Promise<string> {
  const r = await claimRewardMP(cfg, a, code);
  if (r.credit > 0 || r.energy > 0) return prefix + "（+" + r.credit + "c +" + r.energy + "e）";
  return prefix + "（奖励此前已领取）";
}

// runMPMiniChatTask mp mini chat 通用闭环（school_season / Tasks_1/3/6）。
async function runMPMiniChatTask(cfg: AppConfig, a: AuthShape, code: string, withActivityId: boolean): Promise<string> {
  let t = await mpTaskOne(cfg, a, code);
  if (!t) return "mp 口径未下发该任务（活动可能已结束）";
  if (t.claimed) return "已领取";
  if (t.accept_status === "not_accepted" || t.accept_status === "") {
    if (!(await acceptWithVerifyMP(cfg, a, code))) {
      return "accept 未登记生效（上游 200+OK 但未落账形态），待下次重试";
    }
    // accept 后回读真实 target（accept 前 progress 为 null、target=0 的兜底会少报）。
    const t2 = await mpTaskOne(cfg, a, code).catch(() => null);
    if (t2) t = t2;
  }
  const target = t.target > 0 ? t.target : 1;
  if (t.current >= target || t.accept_status === "completed") {
    return await claimMP(cfg, a, code, "已领取奖励");
  }
  const need = target - t.current;
  for (let i = 0; i < need; i++) {
    // 真人节奏：连发会被反作弊判无效整体回滚（2s 连发全灭、45s 间隔全存活）。
    await sleep(mpChatEventGapMs + Math.floor(Math.random() * mpChatJitterMaxMs));
    const conv = "wb2api-mp-" + Date.now() + "-" + i;
    const ev = withActivityId ? schoolSeasonChatEvent(conv) : schoolChatTimesEvents(conv);
    try {
      await reportMPEvent(cfg, a, [ev]);
    } catch (e) {
      return "完成 " + i + "/" + need + " 次上报后中断: " + (e instanceof Error ? e.message : String(e));
    }
  }
  // 回读：两轮各隔 3s（异步计分归账窗口）。
  for (let round = 0; round < 2; round++) {
    await sleep(claimPollGapMs);
    const t2 = await mpTaskOne(cfg, a, code).catch(() => null);
    if (t2) {
      t = t2;
      if (t.claimable || t.claimed || t.current >= target) break;
    }
  }
  if (t.claimed) return "本轮已入账（claimed）";
  if (t.current < target) {
    return "已上报 " + need + " 次但进度未达 " + t.current + "/" + target + "（异步计分未归账，下次重试）";
  }
  return await claimMP(cfg, a, code, "任务点亮并领取奖励");
}

export function runSchoolSeason(cfg: AppConfig, a: AuthShape): Promise<string> {
  return runMPMiniChatTask(cfg, a, "school_season", true);
}
export function runSequentialChat(cfg: AppConfig, a: AuthShape): Promise<string> {
  return runMPMiniChatTask(cfg, a, "Sequential_Tasks_1", false);
}
export function runSequentialChat5(cfg: AppConfig, a: AuthShape): Promise<string> {
  return runMPMiniChatTask(cfg, a, "Sequential_Tasks_3", false);
}
export function runSequentialChat10(cfg: AppConfig, a: AuthShape): Promise<string> {
  return runMPMiniChatTask(cfg, a, "Sequential_Tasks_6", false);
}

// runSequentialEventTask Sequential 链预留任务通用骨架（primary + fallback 双判据）。
async function runSequentialEventTask(
  cfg: AppConfig, a: AuthShape, code: string,
  primary: () => Promise<void>, fallback: (() => Promise<void>) | null,
): Promise<string> {
  let t = await mpTaskOne(cfg, a, code);
  if (!t) return "mp 口径未下发该任务（前置任务未完成或活动未开始）";
  if (t.claimed) return "已领取";
  const target = t.target > 0 ? t.target : 1;
  if (t.current >= target || t.accept_status === "completed") {
    return await claimMP(cfg, a, code, "已领取奖励");
  }
  if (t.accept_status === "not_accepted" || t.accept_status === "") {
    if (!(await acceptWithVerifyMP(cfg, a, code))) {
      return "accept 未登记生效（任务可能处于每日锁定窗口，等解锁后自动重试）";
    }
  }
  try {
    await primary();
  } catch (e) {
    return "判据上报失败: " + (e instanceof Error ? e.message : String(e));
  }
  for (let round = 0; round < 2; round++) {
    await sleep(claimPollGapMs);
    const t2 = await mpTaskOne(cfg, a, code).catch(() => null);
    if (t2) {
      t = t2;
      if (t.claimable || t.claimed || t.current >= target) break;
      if (round === 0 && fallback) {
        try { await fallback(); } catch (e) {
          return "备选判据上报失败: " + (e instanceof Error ? e.message : String(e));
        }
      }
    }
  }
  if (t.claimed) return "本轮已入账（claimed）";
  if (t.current < target) return "已上报但进度未点亮（判据形态待解锁后校正，下次重试）";
  return await claimMP(cfg, a, code, "任务点亮并领取奖励");
}

// runSequentialAutomation Tasks_4「创建定时任务」：PC 同源 automation 事件。
export function runSequentialAutomation(cfg: AppConfig, a: AuthShape): Promise<string> {
  return runSequentialEventTask(cfg, a, "Sequential_Tasks_4", async () => {
    await reportDesktopEvent(cfg, a, [desktopAutomationCreateEvent("wb2api 自动化")]);
  }, null);
}

// runSequentialModelChat Tasks_5「使用 GLM5.2」：mp 模型事件 + PC 活跃 fallback。
export function runSequentialModelChat(cfg: AppConfig, a: AuthShape): Promise<string> {
  return runSequentialEventTask(
    cfg, a, "Sequential_Tasks_5",
    async () => {
      const conv = "wb2api-mp-glm-" + Date.now();
      await reportMPEvent(cfg, a, [miniChatModelEvent(conv, "glm-5.2", "GLM-5.2")]);
    },
    async () => {
      await reportChatActivityModel(cfg, a, "wb2api-mp-glm-" + Date.now(), "", "glm-5.2", "GLM-5.2");
    },
  );
}

// runSequentialPlaybook Tasks_7「体验灵感功能」：PC 事件组 primary + mp 形态 fallback。
export function runSequentialPlaybook(cfg: AppConfig, a: AuthShape): Promise<string> {
  const ms = Date.now();
  return runSequentialEventTask(
    cfg, a, "Sequential_Tasks_7",
    async () => {
      await reportDesktopEvent(cfg, a, desktopPlaybookPromptSequence(
        "wb2api-pb-" + ms, "wb2api-pb-req-" + ms, "pm-gtm-launch-plan", "新产品上市 GTM 发布计划一页纸",
      ));
    },
    async () => {
      await reportMPEvent(cfg, a, miniPlaybookEvents("pm-gtm-launch-plan", "新产品上市 GTM 发布计划一页纸"));
    },
  );
}

// runMiniExpert Tasks_2「小程序选专家对话」：市场真实 id（accept 前解析，防半程态）。
export async function runMiniExpert(cfg: AppConfig, a: AuthShape): Promise<string> {
  const code = "Sequential_Tasks_2";
  let t = await mpTaskOne(cfg, a, code);
  if (!t) return "mp 口径未下发该任务（活动可能已结束）";
  if (t.claimed) return "已领取";
  const target = t.target > 0 ? t.target : 1;
  if (t.current >= target || t.accept_status === "completed") {
    return await claimMP(cfg, a, code, "已领取奖励");
  }
  let experts: MarketExpert[] = [];
  try {
    experts = await marketExpertList(cfg, a, "");
  } catch { /* 拉不到整任务不动作 */ }
  if (experts.length === 0) return "专家市场不可用，跳过以防半程态";
  const e = experts[0];
  const name = e.display_name_zh || e.profession_zh;
  if (t.accept_status === "not_accepted" || t.accept_status === "") {
    if (!(await acceptWithVerifyMP(cfg, a, code))) {
      return "accept 未登记生效（上游 200+OK 但未落账形态），待下次重试";
    }
  }
  try {
    await reportMPEvent(cfg, a, [miniExpertUseEvent(e.expert_id, name, e.expert_type)]);
  } catch (err) {
    return "上报 expert_actual_use 失败: " + (err instanceof Error ? err.message : String(err));
  }
  for (let i = 0; i < 2; i++) {
    await sleep(claimPollGapMs);
    const t2 = await mpTaskOne(cfg, a, code).catch(() => null);
    if (t2) {
      t = t2;
      if (t.claimable || t.claimed || t.current >= target) break;
    }
  }
  if (t.claimed) return "本轮已入账（claimed）";
  if (t.current < target) return "已上报但进度未归账（异步计分，下次重试）";
  return await claimMP(cfg, a, code, "任务点亮并领取奖励");
}

// 保留导出名兼容（防外部误引）：
export { claimReward, claimRewardMP };

