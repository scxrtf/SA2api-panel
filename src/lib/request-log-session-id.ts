import { createHash } from "node:crypto";

type Obj = Record<string, unknown>;

function object(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
}

function identifier(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string" || value.length > 256) continue;
    const id = value.trim();
    if (/^[A-Za-z0-9][A-Za-z0-9_~.:/@+-]{0,255}$/.test(id)) return id;
  }
}

function parseObject(value: unknown): Obj {
  if (typeof value !== "string" || value.length > 4096 || !value.trimStart().startsWith("{")) return {};
  try { return object(JSON.parse(value)); } catch { return {}; }
}

/** Only explicit session markers: a user ID, request ID or cache key is not a conversation. */
export function requestLogSessionId(headers: Headers, body: Obj, keyName: string): string | undefined {
  const meta = object(body.metadata);
  const turn = parseObject(headers.get("x-codex-turn-metadata"));
  // Claude Code can include its session ID in a structured or legacy metadata.user_id.
  const claude = parseObject(meta.user_id);
  const legacy = typeof meta.user_id === "string" && meta.user_id.length <= 512
    ? /^user_[A-Za-z0-9-]+_account_[A-Za-z0-9-]*_session_([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i.exec(meta.user_id)?.[1]
    : undefined;
  const id = identifier(
    headers.get("x-wb2a-session-id"), turn.thread_id, turn.session_id,
    headers.get("x-conversation-id"), headers.get("x-codex-conversation-id"), headers.get("x-thread-id"),
    meta.conversation_id, meta.conversationId, body.conversation_id, body.conversationId,
    object(body.conversation).id, body.conversation,
    headers.get("session_id"), headers.get("x-session-id"),
    meta.session_id, meta.sessionId, meta.thread_id, meta.threadId,
    body.session_id, body.sessionId, body.thread_id, body.threadId,
    claude.session_id, claude.sessionId, legacy,
  );
  // Keep upstream account/model changes inside a session, but isolate gateway key owners.
  if (id) return createHash("sha256").update(JSON.stringify(["request-log-session-v1", keyName, id])).digest("hex").slice(0, 32);
}
