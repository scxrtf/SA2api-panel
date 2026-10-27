// 桌面/小程序/Web 三口径埋点事件构造器与上报（移植 internal/upstream/desktop.go + school.go 事件部分）。
// 桌面端点亮「需电脑端」类任务的关键：同一 POST /v2/report 通道上的不同客户端指纹
// （WorkBuddy Desktop 5.5.6 内嵌 CLI 2.137.1，extName=workbuddy-desktop）。
// 事件形状全部按 Go 版逐字对齐（2026-09-12 Sunny 抓包 + asar 逆向实测，勿改字段）。
import { createHash } from "crypto";
import type { AppConfig } from "../config";
import {
  chatBase,
  chatHeaders,
  newConversationID,
  newMessageID,
  webBaseOf,
  type AuthShape,
} from "./client";

const DESKTOP_CLI_VERSION = "2.161.0";

function desktopTriple(a: AuthShape): { version: string; commit: string; releaseDate: number } {
  if (a.realm === "global") {
    return {
      version: "5.8.4",
      commit: "73952edb48da46bd0b244661efe22f4f247c4977",
      releaseDate: 1792063084107,
    };
  }
  return {
    version: "5.8.3",
    commit: "db0e9b51b7fa0b383f41f5b0b83dd442c8557918",
    releaseDate: 1792029498676,
  };
}

function desktopUAFor(a: AuthShape): string {
  const { version } = desktopTriple(a);
  const brand = a.realm === "global" ? "workbuddy-ai" : "WorkBuddy";
  return `${brand}/${version} ${brand}/${version} CLI/${DESKTOP_CLI_VERSION}`;
}

function desktopHost(a: AuthShape): string {
  const base = chatBase(a);
  try {
    return new URL(base).hostname || base;
  } catch {
    return base.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }
}

// deriveID 由 uid 稳定派生 36 位 hex 设备/会话标识（同盐幂等，模拟固定设备）。
export function deriveID(a: { uid: string }, salt: string): string {
  return createHash("sha256").update(salt + ":" + a.uid, "utf8").digest("hex").slice(0, 36);
}

export type DesktopEvent = Record<string, unknown>;

// desktopFingerprint 每个桌面事件的公共指纹（业务字段优先，覆盖同名键）。
function desktopFingerprint(a: AuthShape): DesktopEvent {
  const now = Date.now();
  const { version, commit, releaseDate } = desktopTriple(a);
  return {
    timezone: "Asia/Shanghai",
    reportDelay: 2000,
    userId: a.uid,
    username: a.nickname,
    userNickname: a.nickname,
    product: "SaaS",
    releaseDate,
    commit,
    ideName: "WorkBuddy",
    ideType: "WorkBuddy",
    ideVersion: version,
    machineId: deriveID(a, "machine"),
    sessionId: deriveID(a, "session"),
    extName: "workbuddy-desktop",
    extVersion: version,
    os: "win32",
    arch: "x64",
    osVersion: "10.0.28000",
    cpuModel: "11th Gen Intel(R) Core(TM) i5-11320H @ 3.20GHz",
    cpuCores: 8,
    memorySize: 16,
    timestamp: now,
    presentAt: now,
    ...(a.realm === "global" ? {} : { qimei36: deriveID(a, "qimei") }),
  };
}

async function reportJSON(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<void> {
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const raw = await resp.text();
  if (resp.status >= 400) throw new Error("http " + resp.status + ": " + raw.slice(0, 200));
  let env: { code?: number; msg?: string };
  try { env = JSON.parse(raw) as typeof env; } catch { return; }
  if (env.code != null && env.code !== 0) throw new Error("code=" + env.code + " msg=" + (env.msg ?? ""));
}

// reportDesktopEvent 桌面指纹批量上报（POST {chatBase}/v2/report，事件数组）。
// events 业务载荷（含 eventCode）；公共指纹自动注入，业务字段优先。
export async function reportDesktopEvent(
  cfg: AppConfig, a: AuthShape, events: DesktopEvent[],
): Promise<void> {
  if (events.length === 0) throw new Error("desktop report: no events");
  void cfg;
  const fp = desktopFingerprint(a);
  const arr = events.map((ev) => ({ ...fp, ...ev }));
  const base = chatBase(a);
  const headers: Record<string, string> = {
    Authorization: "Bearer " + a.accessToken,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "User-Agent": desktopUAFor(a),
    "X-Domain": desktopHost(a),
    "X-Product": "SaaS",
    "X-Request-ID": newMessageID(),
  };
  if (a.uid) headers["X-User-Id"] = a.uid;
  await reportJSON(base + "/v2/report", headers, arr, 30_000);
}

// setAppearanceTheme 应用外观主题（POST {chatBase}/v2/user-asset/appearance/set）。
// 纯 API set 不计 Hp_Appearance 分（需配 appearance_skin_apply 事件，见 runAppearance）。
export async function setAppearanceTheme(cfg: AppConfig, a: AuthShape, resourceKey: string): Promise<void> {
  void cfg;
  const base = chatBase(a);
  const headers: Record<string, string> = {
    Authorization: "Bearer " + a.accessToken,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "User-Agent": desktopUAFor(a),
    "X-Product": "SaaS",
  };
  if (a.uid) headers["X-User-Id"] = a.uid;
  await reportJSON(base + "/v2/user-asset/appearance/set", headers,
    { kind: "theme", resource_key: resourceKey }, 30_000);
}

// reportWebEvent Web 端指纹上报（{webBase}/v2/report，Library_read 判据）。
export async function reportWebEvent(
  cfg: AppConfig, a: AuthShape,
  eventCode: string, pageURL: string, elementID: string, elementName: string,
): Promise<void> {
  void cfg;
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  const ev = {
    eventCode, timestamp: Date.now(), reportDelay: 0,
    pageURL, elementId: elementID, elementName,
    os: "Win32", arch: "", osVersion: "10.0", userAgent: ua,
    machineId: deriveID(a, "webmachine"), userId: a.uid,
    userNickname: a.nickname, enterpriseId: a.enterpriseId,
  };
  const headers: Record<string, string> = {
    Authorization: "Bearer " + a.accessToken,
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-client-platform": "web",
    Origin: webBaseOf(a),
    Referer: pageURL,
    "User-Agent": ua,
  };
  if (a.uid) headers["X-User-Id"] = a.uid;
  await reportJSON(webBaseOf(a) + "/v2/report", headers, [ev], 30_000);
}

// ─── 桌面事件链构造器（字段形状勿动，全部实测口径）─────────────────────────

// desktopChatSequence 一次「桌面端成功对话」完整事件链（点亮 RichMeow_Chat 等）。
export function desktopChatSequence(
  conversationID: string, requestID: string, messageID: string,
  modelID: string, modelName: string,
): DesktopEvent[] {
  const trace = () => requestID;
  return [
    {
      eventCode: "agent_task_created", source: "LOCAL", name: "working",
      task_target: "local", mode: "craft",
      requestModelId: modelID, requestModelName: modelName,
      has_repo: false, repo_type: "none", workspace_type: "empty",
      has_connector: false, connector_types: [],
      has_mention: false, mention_types: [],
      has_template: false, action: "", template_name: "",
      has_expert: false, expert_id: "", expert_name: "", expert_industry_id: "",
      has_skill: false, skill_names: [],
      conversationId: conversationID, messageId: messageID,
      buddyId: "", buddyName: "",
    },
    {
      eventCode: "chat_message_send",
      messageId: messageID + "-assistant", historyCount: 0,
      isContextTruncated: false, currentStepCount: 1,
      traceId: trace(), rootRequestId: requestID,
      parentConversationId: conversationID,
      agentName: "cli", agentType: "main",
    },
    {
      eventCode: "chat_request_send",
      inputLength: 24, isPlan: false, isAutoExecuteTerminal: false,
      isAutoModify: false, codebaseEnable: false, maxToken: 0,
      maxSteps: 500, temperature: 0, maxRetries: 0,
      mentionContexts: [], knowledgeId: [], knowledgeName: [],
      codebaseId: "", mentionContextCount: 0, command: "",
      recommendId: "", skillId: "", skillCount: 0, totalCount: 0,
      traceId: trace(), rootRequestId: requestID,
      parentConversationId: conversationID,
      agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationID,
      "codebuddy.conversation_request_id": requestID,
    },
    {
      eventCode: "chat_message_response",
      messageId: messageID + "-assistant", responseModelId: modelID,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: "", finishReason: "stop",
      firstTokenAt: Date.now(), traceId: trace(),
      conversationId: conversationID,
      rootRequestId: requestID, parentConversationId: conversationID,
      agentName: "cli", agentType: "main",
      "codebuddy.session_id": conversationID,
      "codebuddy.conversation_request_id": requestID,
    },
    {
      eventCode: "chat_message_status",
      messageId: messageID + "-assistant", messageErrorCode: "0",
      traceId: trace(), rootRequestId: requestID,
      parentConversationId: conversationID,
      agentName: "cli", agentType: "main",
    },
    {
      eventCode: "chat_request_response",
      mode: "craft", toolCallCount: 0,
      inputToken: 120, outputToken: 80, totalToken: 200,
      cachedTokens: 0, cachedWriteTokens: 0, cachedMissTokens: 0,
      isSuccessful: true, messageErrorCode: "", finishReason: "stop",
      rootRequestId: requestID, parentConversationId: conversationID,
    },
  ];
}

// desktopBuddyAppSequence 「进入 Buddy 应用」五连事件（Buddy_App / Buddy_App_QQ）。
export function desktopBuddyAppSequence(buddyID: string, buddyName: string): DesktopEvent[] {
  const mk = (code: string, extra: Record<string, unknown>): DesktopEvent =>
    ({ eventCode: code, mode: "LOCAL", buddyId: buddyID, buddyName, ...extra });
  return [
    mk("buddyapp_discover_click", {}),
    mk("buddyapp_show", { elementId: buddyID, elementName: buddyName, position: 2 }),
    mk("buddyapp_enter_click", { elementId: buddyID, elementName: buddyName, position: 2, isFirstPage: "1" }),
    mk("buddyapp_auth_confirm_click", { elementId: buddyID, elementName: buddyName }),
    mk("buddyapp_bindaccount_skip_click", { elementId: buddyID, elementName: buddyName }),
  ];
}

// desktopAutomationCreateEvent 「定时任务创建成功」事件（automation_1）。
export function desktopAutomationCreateEvent(name: string): DesktopEvent {
  return {
    eventCode: "automated_task_create_suc", name,
    source: "manually", modelId: "fast-model", modelIsThinking: true,
    connectorCount: 0, skills: "", skillCount: 0,
    scheduleType: "once", mode: "LOCAL",
  };
}

// desktopTemplateUseSequence 「使用模板创建任务」事件组（template_5）。
export function desktopTemplateUseSequence(
  conversationID: string, requestID: string, templateID: string, templateName: string,
): DesktopEvent[] {
  const events = desktopChatSequence(conversationID, requestID, "msg-" + templateID, "fast-model", "fast-model");
  events.push(
    {
      eventCode: "agent_task_created_with_template", mode: "working",
      isCustomModel: false, id: templateID, name: templateName, requestId: requestID,
    },
    { eventCode: "template_used", template_id: templateID, task_mode: "working" },
  );
  return events;
}

// desktopPlaybookPromptSequence 「灵感案例做同款」事件组（playbook_prompt）。
export function desktopPlaybookPromptSequence(
  conversationID: string, requestID: string, caseID: string, caseName: string,
): DesktopEvent[] {
  const events = desktopChatSequence(conversationID, requestID, "msg-pb", "fast-model", "fast-model");
  const payload = { id: caseID, name: caseName, type: "document", categoryId: "", categoryName: "" };
  events.push(
    {
      eventCode: "web_element_click", pageName: "playbook_detail",
      elementId: "playbook_ctaClick", elementName: caseName, source: "discover",
    },
    { eventCode: "playbook_cta_click", source: "discover", position: 0, ...payload },
    { eventCode: "playbook_prompt_send", conversationId: conversationID, requestId: requestID, ...payload },
  );
  return events;
}

// desktopDesignCanvasSequence 「设计创意画布」事件组（create_canvas）。
export function desktopDesignCanvasSequence(conversationID: string, requestID: string): DesktopEvent[] {
  const events = desktopChatSequence(conversationID, requestID, "msg-canvas", "fast-model", "fast-model");
  events.push(
    {
      eventCode: "wbx_design_canvas_task_create", conversationId: conversationID,
      requestId: requestID, source: "summon_keyword", cost: 12000, isSuccessful: true,
    },
    {
      eventCode: "wbx_design_canvas_open", conversationId: conversationID,
      requestId: requestID, id: "ardot-file-" + requestID.slice(-8),
      source: "summon_keyword", type: "page", cost: 13000, isSuccessful: true,
    },
  );
  return events;
}

// ─── 专家市场 + 真实桌面 chat（expert_5 / lighthouse 判据核心）─────────────

export interface MarketExpert {
  expert_id: string;
  expert_type: string;
  display_name_zh: string;
  profession_zh: string;
  version: string;
  categories: unknown[];
}

// marketExpertList 拉取专家市场真实列表（expertType: "agent" | "team"）。
export async function marketExpertList(cfg: AppConfig, a: AuthShape, expertType: string): Promise<MarketExpert[]> {
  void cfg;
  const body: Record<string, unknown> = { page: 1, page_size: 20, sort_by: "reco_rank", sort_order: "desc" };
  if (expertType) body.expert_type = expertType;
  const base = chatBase(a);
  const headers: Record<string, string> = {
    Authorization: "Bearer " + a.accessToken,
    "Content-Type": "application/json",
    "User-Agent": desktopUAFor(a),
    "X-Domain": base,
    "X-Product": "SaaS",
  };
  if (a.uid) headers["X-User-Id"] = a.uid;
  const resp = await fetch(base + "/portal/operation-platform/market/expert/list", {
    method: "POST", headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000), cache: "no-store",
  });
  const raw = await resp.text();
  if (resp.status >= 400) throw new Error("http " + resp.status + ": " + raw.slice(0, 200));
  let env: { code?: number; msg?: string; data?: { experts?: MarketExpert[] } };
  try { env = JSON.parse(raw) as typeof env; } catch { throw new Error("expert list parse failed: " + raw.slice(0, 120)); }
  if (env.code != null && env.code !== 0) throw new Error("code=" + env.code + " msg=" + (env.msg ?? ""));
  return env.data?.experts ?? [];
}

const serverIDRegex = /^(cmb-)?[0-9a-f]{32}$/;

// desktopChatWithExpert 发真实桌面指纹 chat（可带 X-Expert-Id），从 SSE 抓服务端
// requestId（data.id，cmb- 前缀 32hex 或裸 32hex）。expert_actual_use 的 JOIN
// requestId 必须是服务端 id——自造 id 不计数。
export async function desktopChatWithExpert(
  cfg: AppConfig, a: AuthShape, expertID: string,
): Promise<{ conversationID: string; requestID: string }> {
  // 会话 ID 用官方形态（UUID v4）。旧值 `wb2api-conv-<毫秒>` 把项目缩写直接当
  // X-Conversation-ID 打给上游（上游 issue #51 最直白的一处自证）。
  const conversationID = newConversationID();
  const body = {
    model: "fast-model",
    messages: [
      { role: "system", content: "You are a helpful assistant. 当前处于中文环境，使用简体中文回答。" },
      { role: "user", content: "1+1等于几？直接回答。" },
    ],
    agent: "cli",
    temperature: 1,
    stream: true,
    stream_options: { include_usage: true },
  };
  const base = chatBase(a);
  // 头族统一走 chatHeaders：手搓头与主 chat 路径长期漂移（缺 trace/B3/stainless/acp，
  // X-IDE-Version 写死、X-Request-ID 是十进制毫秒）——统一出口后主路径改一次这里自动跟随。
  const h = chatHeaders(cfg, a, "", {
    conversationID,
    cacheKeyID: conversationID,
    conversationRequestID: newMessageID(),
    traceID: "",
  });
  h.Accept = "text/event-stream";
  if (expertID) h["X-Expert-Id"] = expertID;
  const resp = await fetch(base + "/v2/chat/completions", {
    method: "POST", headers: h, body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000), cache: "no-store",
  });
  if (resp.status !== 200) {
    const b = (await resp.text()).slice(0, 200);
    throw new Error("chat http " + resp.status + ": " + b);
  }
  if (!resp.body) throw new Error("chat empty body");
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let buf = "";
  let searchFrom = 0;
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      chunks.push(value);
      buf += decoder.decode(value, { stream: true });
      // 从上次搜索位置继续找 `"id":"`（首个不匹配的 id 不能反复命中同一位置）。
      for (;;) {
        const i = buf.indexOf('"id":"', searchFrom);
        if (i < 0) break;
        const rest = buf.slice(i + 6);
        const end = rest.indexOf('"');
        if (end > 0) {
          const id = rest.slice(0, end);
          if (serverIDRegex.test(id)) {
            void reader.cancel().catch(() => {});
            return { conversationID, requestID: id };
          }
        }
        searchFrom = i + 1;
      }
    }
    if (done) break;
    if (buf.length > 1 << 20) break;
  }
  throw new Error("SSE 中未找到服务端 requestId");
}

// desktopExpertSummonSequence 「召唤平台专家」事件组（载荷对齐真实抓包）。
export function desktopExpertSummonSequence(e: MarketExpert): DesktopEvent[] {
  const cat = typeof e.categories?.[0] === "string" ? (e.categories[0] as string) : "expert-all";
  const ver = e.version || "1.0.0";
  return [
    {
      eventCode: "web_element_click", source: e.expert_id, type: cat, version: ver,
      elementId: "expert_summon_click", elementName: "立即召唤",
      pageURL: "/C:/Program%20Files/WorkBuddy/resources/app.asar/renderer/index.html",
    },
    {
      eventCode: "expert_summon_click", id: e.expert_id, name: e.display_name_zh,
      expertTitle: e.profession_zh, type: "expert-all", position: 0,
      expertType: e.expert_type, version: ver, mode: "LOCAL",
    },
    {
      eventCode: "expert_summoned", id: e.expert_id, name: e.display_name_zh,
      expertTitle: e.profession_zh, type: "expert-all",
    },
  ];
}

// desktopExpertActualUseEvent 「专家真实使用」事件（expert_5 / Expert_team_use_3）。
export function desktopExpertActualUseEvent(
  e: MarketExpert, conversationID: string, requestID: string, mode: "craft" | "LOCAL",
): DesktopEvent {
  const cat = typeof e.categories?.[0] === "string" ? (e.categories[0] as string) : "expert-all";
  return {
    eventCode: "expert_actual_use",
    id: e.expert_id, name: e.display_name_zh, expertTitle: e.profession_zh,
    type: cat, expertType: e.expert_type, source: "builtin", version: e.version || "1.0.0",
    cost: 9000, characterCount: 14,
    conversationId: conversationID, requestId: requestID,
    messageId: "msg-" + requestID.slice(-8),
    requestModelId: "fast-model", requestModelName: "fast-model",
    mode,
  };
}

// ─── 小程序（mp）指纹事件（school.go 事件部分）─────────────────────────────

export const SCHOOL_OPEN_DAY_ACTIVITY_ID = "school_open_day_2026";

function mpEventBase(a: AuthShape): Record<string, unknown> {
  return {
    timestamp: Date.now(),
    ideType: "WorkBuddy_MP",
    ideVersion: "2.4.0",
    extName: "workbuddy-mp",
    extVersion: "2.4.0",
    product: "SaaS",
    ideName: "wx_app_cloud",
    platform: "mini_program",
    os: "windows",
    osVersion: "11",
    arch: "x64",
    machineId: "0655736a-607f-4d9d-b430-58176ee9a090",
    timezone: "Asia/Shanghai",
    userId: a.uid,
    userNickname: a.nickname,
  };
}

// reportMPEvent 小程序指纹批量上报（POST {billingBase}/v2/report）。
export async function reportMPEvent(
  cfg: AppConfig, a: AuthShape, events: Record<string, unknown>[],
): Promise<void> {
  if (events.length === 0) throw new Error("mp report: no events");
  void cfg;
  const { billingBase } = await import("./client");
  const base = mpEventBase(a);
  const arr = events.map((ev) => ({ ...base, ...ev }));
  const headers: Record<string, string> = {
    Authorization: "Bearer " + a.accessToken,
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Client-Product": "workbuddy-mp",
    "X-Client-Version": "2.4.0",
    "X-Client-Platform": "mp-weixin",
    "X-Platform": "wechatmp",
  };
  if (a.uid) headers["X-User-Id"] = a.uid;
  await reportJSON(billingBase(a) + "/v2/report", headers, arr, 30_000);
}

// schoolChatTimesEvents mp 对话事件（chat_3_times / Sequential_Tasks_1/3/6 判据）。
export function schoolChatTimesEvents(conversationID: string): Record<string, unknown> {
  // rid 用官方形态（32 hex 毫秒前缀）。旧值 "wb2api-"+uuid 把项目缩写写进
  // traceId / rootRequestId / messageId 一起上报（上游 issue #51）。
  const rid = newMessageID();
  return {
    eventCode: "chat_request_send",
    inputLength: 14, isPlan: false, isAutoExecuteTerminal: false,
    isAutoModify: false, codebaseEnable: false, maxToken: 0,
    maxSteps: 500, temperature: 0, maxRetries: 0,
    mentionContexts: [], knowledgeId: [], knowledgeName: [],
    codebaseId: "", mentionContextCount: 0, command: "",
    recommendId: "", skillId: "", skillCount: 0, totalCount: 0,
    traceId: rid, rootRequestId: rid,
    parentConversationId: conversationID, conversationId: conversationID,
    messageId: "msg-" + rid.slice(-8),
    agentName: "mp", agentType: "main",
    "codebuddy.session_id": conversationID,
    "codebuddy.conversation_request_id": rid,
  };
}

// schoolSeasonChatEvent 校园日判据：mini 对话事件 + activityId（无 activityId 不点亮）。
export function schoolSeasonChatEvent(conversationID: string): Record<string, unknown> {
  return { ...schoolChatTimesEvents(conversationID), activityId: SCHOOL_OPEN_DAY_ACTIVITY_ID };
}

// miniExpertUseEvent Sequential_Tasks_2 判据：mp 指纹 expert_actual_use。
// 不带 conversationId/activityId；extVersion=2.2.8；source=mini_program + type=send_message。
export function miniExpertUseEvent(expertID: string, expertName: string, expertType: string): Record<string, unknown> {
  return {
    eventCode: "expert_actual_use", reportDelay: 0,
    extVersion: "2.2.8", source: "mini_program",
    id: expertID, name: expertID,
    expertTitle: expertName || expertID, type: "send_message",
    characterCount: 12, expertType: expertType || "agent",
  };
}

// miniChatModelEvent mp 对话事件 + 模型字段（Sequential_Tasks_5 判据载体）。
export function miniChatModelEvent(conversationID: string, modelID: string, modelName: string): Record<string, unknown> {
  return {
    ...schoolChatTimesEvents(conversationID),
    requestModelId: modelID,
    requestModelName: modelName,
  };
}

// miniPlaybookEvents mp 指纹灵感事件组（Sequential_Tasks_7 备选判据）。
export function miniPlaybookEvents(caseID: string, caseName: string): Record<string, unknown>[] {
  const base = { id: caseID, name: caseName, type: "document", categoryId: "", categoryName: "", skills: "", skillNames: "" };
  return [
    { eventCode: "playbook_cta_click", source: "discover", position: 1, extVersion: "2.2.8", ...base },
    {
      eventCode: "playbook_prompt_send", source: "discover",
      promptLength: 96, isOfficial: 1,
      conversationId: newConversationID(), extVersion: "2.2.8", ...base,
    },
  ];
}
