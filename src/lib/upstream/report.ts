// 对话活跃上报：POST {chatBase}/v2/report，使用官方 Node RPC 请求头族。
import type { AppConfig } from "../config";
import { chatBase, newConversationID, newTraceID, rpcUserAgent, type AuthShape } from "./client";
import { desktopFingerprint } from "./desktop";
import { officialEgress } from "./official-egress";

const REPORT_TIMEOUT_MS = 15_000;

export function reportHeaders(cfg: AppConfig, a: AuthShape): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    "X-Request-ID": newTraceID(),
    "X-Product": "SaaS",
    "User-Agent": rpcUserAgent(cfg, a),
    Authorization: "Bearer " + a.accessToken,
    "X-Domain": new URL(chatBase(a)).host,
  };
  if (a.uid) headers["X-User-Id"] = a.uid;
  return headers;
}

async function reportJSON(cfg: AppConfig, a: AuthShape, body: unknown): Promise<void> {
  const resp = await officialEgress(chatBase(a) + "/v2/report", {
    method: "POST",
    headers: reportHeaders(cfg, a),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  });
  const raw = await resp.text();
  if (resp.status >= 400) throw new Error("http " + resp.status + ": " + raw.slice(0, 200));
  let env: { code?: number; msg?: string };
  try { env = JSON.parse(raw) as typeof env; } catch { return; }
  if (env.code != null && env.code !== 0) throw new Error("code=" + env.code + " msg=" + (env.msg ?? ""));
}

export async function reportChatActivity(
  cfg: AppConfig, a: AuthShape, conversationID: string, requestID: string,
): Promise<void> {
  return reportChatActivityModel(cfg, a, conversationID, requestID, "deepseek-v4.1-flash", "DeepSeek-V4.1-Flash");
}

export async function reportChatActivityModel(
  cfg: AppConfig, a: AuthShape,
  conversationID: string, requestID: string,
  modelID: string, modelName: string,
): Promise<void> {
  if (!requestID) requestID = conversationID;
  if (!modelID) modelID = "deepseek-v4.1-flash";
  if (!modelName) modelName = modelID;
  const now = Date.now();
  const traceId = newTraceID();
  const ev = {
    ...desktopFingerprint(a),
    eventCode: "chat_request_send", timestamp: now,
    mode: "craft", conversationId: conversationID, requestId: requestID,
    inputLength: 12, requestModelId: modelID, requestModelName: modelName,
    isPlan: false, isAutoExecuteTerminal: false, isAutoModify: false,
    codebaseEnable: false, mentionContexts: [] as unknown[], knowledgeId: [] as unknown[],
    knowledgeName: [] as unknown[], codebaseId: "", mentionContextCount: 0,
    command: "", presentAt: now, traceId, rootRequestId: requestID,
    parentConversationId: conversationID, agentName: "cli", agentType: "main",
    source: "work", isMaxMode: true, inputAttemptId: newConversationID(),
    vcsType: "unknown", vcsRepo: "", vcsBranchName: "", vcsRevId: "",
    recommendId: "", skillId: "", buddyId: "", buddyName: "",
    "codebuddy.session_id": conversationID,
    "codebuddy.conversation_request_id": requestID,
    userId: a.uid,
  };
  await reportJSON(cfg, a, [ev]);
}
