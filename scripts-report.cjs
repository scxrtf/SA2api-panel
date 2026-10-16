const fs = require("fs");
const content = String.raw`
// 对话活跃上报（移植 internal/upstream/report.go）：POST {billingBase}/v2/report。
// 照抄客户端 chat_request_send 事件形状（含全字段，勿用最小 3 字段，防上游加严）。
// 事件必须带 userId（=账号 uid），缺失则服务端 200 但静默丢弃。
// 一条上报同时点亮 growth 连登 + 解锁 first_buddy 任务（领养前置）。
// 风控口径：每号每天 1 次即可（activity_hours 单时点），不做多时点高频上报。
import type { AppConfig } from "../config";
import { billingBase, billingHeaders, type AuthShape } from "./client";

const REPORT_TIMEOUT_MS = 15_000;

async function reportJSON(cfg: AppConfig, a: AuthShape, body: unknown): Promise<void> {
  const resp = await fetch(billingBase(a) + "/v2/report", {
    method: "POST",
    headers: billingHeaders(cfg, a),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    cache: "no-store",
  });
  const raw = await resp.text();
  if (resp.status >= 400) {
    throw new Error("http " + resp.status + ": " + raw.slice(0, 200));
  }
  let env: { code?: number; msg?: string };
  try { env = JSON.parse(raw) as typeof env; } catch { return; }
  if (env.code != null && env.code !== 0) {
    throw new Error("code=" + env.code + " msg=" + (env.msg ?? ""));
  }
}

// reportChatActivity 上报一条 chat_request_send（默认 deepseek-v4-flash 模型口径）。
export async function reportChatActivity(
  cfg: AppConfig, a: AuthShape, conversationID: string, requestID: string,
): Promise<void> {
  return reportChatActivityModel(cfg, a, conversationID, requestID, "deepseek-v4-flash", "DeepSeek V4 Flash");
}

// reportChatActivityModel 同上，但可指定上报携带的模型（对齐 Model_chat_* 任务）。
export async function reportChatActivityModel(
  cfg: AppConfig, a: AuthShape,
  conversationID: string, requestID: string,
  modelID: string, modelName: string,
): Promise<void> {
  if (!requestID) requestID = conversationID;
  if (!modelID) modelID = "deepseek-v4-flash";
  if (!modelName) modelName = modelID;
  const now = Date.now();
  const ev = {
    eventCode: "chat_request_send",
    timestamp: now,
    reportDelay: 0,
    mode: "craft",
    conversationId: conversationID,
    requestId: requestID,
    inputLength: 12,
    requestModelId: modelID,
    requestModelName: modelName,
    isPlan: false,
    isAutoExecuteTerminal: false,
    isAutoModify: false,
    codebaseEnable: false,
    maxToken: 0,
    maxSteps: 0,
    temperature: 0,
    maxRetries: 0,
    mentionContexts: [] as unknown[],
    knowledgeId: [] as unknown[],
    knowledgeName: [] as unknown[],
    codebaseId: "",
    mentionContextCount: 0,
    command: "",
    presentAt: now,
    traceId: "",
    rootRequestId: requestID,
    parentConversationId: conversationID,
    agentName: "default",
    agentType: "conversation",
    userId: a.uid,
  };
  await reportJSON(cfg, a, [ev]);
}
`;
fs.writeFileSync("src/lib/upstream/report.ts", content.trimStart(), "utf8");
console.log("report.ts written");
