import { createHash } from "node:crypto";
import type { KeyIdentity } from "../auth-guard";
import type { GatewayProtocol } from "./contracts";
import { enabled } from "./settings";
import { gatewayStore, type GatewayInput, type GatewayTicket, type WorkspaceStore } from "./store";

type Obj = Record<string, unknown>;
type History = { end: string; prefixes: string[]; lastUser: string; tools: string[]; comparable: boolean };
const MAX_TEXT = 12_000;
const MAX_FRAME = 512 * 1024;
const hash = (...value: string[]) => createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 32);
const obj = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown) => typeof v === "string" ? v : "";
const identifier = (...values: unknown[]) => values.map(text).find((v) => /^[A-Za-z0-9][A-Za-z0-9_~.:/@+-]{0,255}$/.test(v));
const opaque = (value?: string) => value && hash("identifier", value);
const normalized = (value: string) => value.replace(/\r\n/g, "\n").trim();
const readable = (value: string, limit: number) => value.slice(0, limit * 2).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[已隐藏]")
  .replace(/((?:authorization|api[_-]?key|access[_-]?token|secret|password)["']?\s*[:=]\s*["']?)(?:bearer\s+)?[^\s"'\x60,;]+/gi, "$1[已隐藏]")
  .slice(0, limit);
const label = (value: string, limit = 96) => readable(value, limit).replace(/\s+/g, " ").trim();
const step = (base: string, role: string, value: string) => hash(base, role, value);

function content(value: unknown) {
  if (typeof value === "string") return { value: value.slice(0, MAX_TEXT), comparable: value.length <= MAX_TEXT };
  let merged = "";
  const list = arr(value);
  let comparable = list.length <= 64;
  for (const block of list.slice(0, 64)) {
    const p = obj(block);
    if (["text", "input_text", "output_text"].includes(text(p.type))) {
      const part = text(p.text);
      if (merged.length + part.length > MAX_TEXT) comparable = false;
      merged += part.slice(0, Math.max(0, MAX_TEXT - merged.length));
    } else comparable = false;
  }
  return { value: merged, comparable };
}

function buildHistory(body: Obj): History {
  const entries = Array.isArray(body.messages) ? body.messages : typeof body.input === "string" ? [{ role: "user", content: body.input }] : arr(body.input);
  let end = hash("wire-history-v1");
  let comparable = entries.length <= 120;
  let lastUser = "";
  const prefixes: string[] = [];
  const tools: string[] = [];
  for (const item of entries.slice(-120)) {
    const entry = obj(item);
    const role = text(entry.role);
    const kind = text(entry.type);
    if (role === "system" || role === "developer") continue;
    const block = content(entry.content);
    if (role === "assistant" || role === "user") {
      const value = normalized(block.value);
      comparable &&= block.comparable && !arr(entry.tool_calls).length;
      if (value) {
        end = step(end, role, value);
        if (comparable && role === "assistant") prefixes.unshift(end);
      }
      lastUser = role === "user" ? value : "";
      for (const part of arr(entry.content).slice(0, 64)) {
        const result = obj(part);
        const id = result.type === "tool_result" && identifier(result.tool_use_id);
        if (id) { tools.push(opaque(id)!); lastUser = ""; }
      }
    } else if (role === "tool" || ["function_call_output", "custom_tool_call_output"].includes(kind)) {
      const id = identifier(entry.tool_call_id, entry.call_id);
      if (id) tools.push(opaque(id)!);
      comparable = false;
      lastUser = "";
    } else {
      comparable = false;
    }
  }
  return { end, prefixes: prefixes.slice(0, 12), lastUser, tools: Array.from(new Set(tools)).slice(-16), comparable };
}

function identifyClient(req: Request, protocol: GatewayProtocol) {
  const agent = (req.headers.get("user-agent") ?? "").slice(0, 256);
  if (/codex/i.test(agent) || req.headers.has("x-codex-installation-id")) return "Codex";
  if (/claude-code|claude/i.test(agent)) return "Claude Code";
  if (/\bpi-coding-agent\b|^pi\/|(?:\b|_)pi-agent/i.test(agent)) return "Pi";
  if (/mirasim|(claude|kimi)[- ]code/i.test(agent)) return "Mirasim";
  if (/cherry.?studio/i.test(agent)) return "Cherry Studio";
  return protocol === "anthropic" ? "Anthropic 客户端" : "OpenAI 客户端";
}

export function gatewayInput(req: Request, body: Obj, protocol: GatewayProtocol, identity: Pick<KeyIdentity, "name">, storeText = false) {
  const history = buildHistory(body);
  const meta = obj(body.metadata);
  let turnMeta: Obj = {};
  const turnHeader = req.headers.get("x-codex-turn-metadata");
  if (turnHeader && turnHeader.length <= 4096) {
    try { turnMeta = obj(JSON.parse(turnHeader)); } catch { /* optional client metadata */ }
  }
  const client = identifyClient(req, protocol);
  const reported = identifier(req.headers.get("x-wb2a-machine-id"), req.headers.get("x-machine-id"), meta.machine_id);
  const installation = identifier(req.headers.get("x-codex-installation-id"), req.headers.get("x-device-id"));
  const machine = reported ?? installation;
  const principal = identity.name ? hash("principal", identity.name) : "default";
  const address = (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "").trim().slice(0, 128);
  const machineId = machine ? hash("machine", principal, machine) : identity.name ? hash("key", principal) : hash("connection", address, client);
  const machineBasis = machine ? "device" : identity.name ? "key" : "connection";
  const machineLabel = reported ? label(reported) : installation ? `${client} ${machineId.slice(0, 6)}` :
    identity.name ? `密钥归组 ${machineId.slice(0, 6)}` : `未标识连接 ${machineId.slice(0, 6)}`;
  const input: GatewayInput = {
    source: {
      machineId, machineBasis, machineLabel, client, model: label(text(body.model), 140) || "未知模型",
      protocol, correlation: "unlinked", lastAt: Date.now(),
    },
    thread: opaque(identifier(
      req.headers.get("x-wb2a-session-id"), req.headers.get("thread-id"), req.headers.get("session-id"),
      req.headers.get("session_id"), req.headers.get("x-session-id"),
      req.headers.get("x-conversation-id"), req.headers.get("x-codex-conversation-id"),
      turnMeta.thread_id, turnMeta.session_id,
      meta.conversation_id, meta.conversationId, meta.session_id, meta.sessionId, meta.thread_id, meta.threadId,
      body.conversation_id, body.conversationId, body.session_id, body.thread_id, obj(body.conversation).id, body.conversation,
    )),
    parent: opaque(identifier(req.headers.get("x-wb2a-parent-session-id"), meta.parent_session_id, meta.parentSessionId, turnMeta.parent_thread_id)),
    previous: opaque(identifier(body.previous_response_id)),
    prefixes: history.prefixes, toolResults: history.tools,
    prompt: storeText ? readable(history.lastUser, 2800) : "",
  };
  return { input, history };
}

function collector(store: WorkspaceStore, ticket: GatewayTicket, protocol: GatewayProtocol, history: History, storeText: boolean) {
  let answer = "", cumulated = "", replySeen = false, overflow = false;
  let responseId: string | undefined, end: "completed" | "failed" | "interrupted" | undefined;
  let stopped = false;
  const seenTools = new Set<string>();
  const openTools = new Map<number, { id: string; name: string }>();
  const addText = (value: string) => {
    if (!value) return;
    replySeen = true;
    overflow ||= answer.length + value.length > MAX_TEXT;
    answer += value.slice(0, Math.max(0, MAX_TEXT - answer.length));
  };
  const authoritative = (value: string, truncated = false) => {
    if (!value) return;
    replySeen = true;
    overflow = truncated || value.length > MAX_TEXT;
    answer = value.slice(0, MAX_TEXT);
  };
  const tool = (id: string, name: string) => {
    const alias = opaque(identifier(id));
    const safe = label(name);
    if (!alias || !safe || seenTools.has(alias) || seenTools.size >= 40) return;
    seenTools.add(alias);
    try { store.gatewayTool(ticket, alias, safe); } catch { /* observation must not break the gateway */ }
  };
  const responseItems = (items: unknown) => {
    let finishedText = "";
    let truncated = arr(items).length > 80;
    for (const raw of arr(items).slice(0, 80)) {
      const item = obj(raw);
      if (["function_call", "custom_tool_call"].includes(text(item.type))) tool(text(item.call_id) || text(item.id), text(item.name));
      if (item.type === "message" && item.role === "assistant") {
        const block = content(item.content);
        truncated ||= !block.comparable || finishedText.length + block.value.length > MAX_TEXT;
        finishedText += block.value.slice(0, MAX_TEXT - finishedText.length);
      }
    }
    if (finishedText) authoritative(finishedText, truncated);
  };

  function data(raw: string, event?: string) {
    if (raw === "[DONE]") {
      if (protocol === "chat" && !end) end = "completed";
      return;
    }
    let value: Obj;
    try { value = obj(JSON.parse(raw)); } catch { return; }
    const type = text(value.type) || event || "";
    if (value.error || type === "error" || type.endsWith(".failed")) end = "failed";
    if (protocol === "responses" || protocol === "compact") {
      const response = obj(value.response);
      responseId = identifier(response.id, value.id) ?? responseId;
      if (type === "response.output_text.delta") addText(text(value.delta));
      if (type === "response.output_item.added" || type === "response.output_item.done") {
        const item = obj(value.item);
        if (["function_call", "custom_tool_call"].includes(text(item.type))) tool(text(item.call_id) || text(item.id), text(item.name));
        else if (type.endsWith(".done") && item.type === "message" && !answer) addText(content(item.content).value);
      }
      if (type === "response.completed") { responseItems(response.output); if (!end) end = "completed"; }
      else if (type === "response.incomplete") end = "interrupted";
      else if (Array.isArray(value.output)) {
        responseItems(value.output);
        if (value.status === "failed") end = "failed";
        if (value.status === "incomplete") end = "interrupted";
      }
      return;
    }
    if (protocol === "anthropic") {
      responseId = identifier(obj(value.message).id, value.id) ?? responseId;
      const say = (item: Obj) => {
        if (item.type === "tool_use") tool(text(item.id), text(item.name));
        else if (item.type === "text") addText(text(item.text));
      };
      if (type === "content_block_start") say(obj(value.content_block));
      if (type === "content_block_delta" && obj(value.delta).type === "text_delta") addText(text(obj(value.delta).text));
      if (type === "message_stop" && !end) end = "completed";
      if (Array.isArray(value.content)) for (const part of value.content.slice(0, 80)) say(obj(part));
      return;
    }
    responseId = identifier(value.id) ?? responseId;
    const choice = obj(arr(value.choices)[0]);
    const delta = obj(choice.delta);
    const message = obj(choice.message);
    addText(text(delta.content));
    if (message.content) {
      const block = content(message.content);
      authoritative(block.value, !block.comparable);
    }
    for (const rawTool of [...arr(delta.tool_calls), ...arr(message.tool_calls)].slice(0, 32)) {
      const current = obj(rawTool), fn = obj(current.function);
      if (typeof current.index === "number" && current.index >= 0 && current.index < 40) {
        const draft = openTools.get(current.index) ?? { id: "", name: "" };
        draft.id = text(current.id) || draft.id;
        draft.name = (draft.name + text(fn.name)).slice(0, 96);
        openTools.set(current.index, draft);
      } else tool(text(current.id), text(fn.name));
    }
    if (choice.finish_reason && !end) end = "completed";
  }
  function sse(chunk: string) {
    cumulated += chunk;
    const boundary = /\r?\n\r?\n/;
    for (;;) {
      const match = boundary.exec(cumulated);
      if (!match) break;
      const frame = cumulated.slice(0, match.index);
      cumulated = cumulated.slice(match.index + match[0].length);
      if (frame.length <= MAX_FRAME) {
        const lines = frame.split(/\r?\n/);
        const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        const raw = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
        if (raw) data(raw, event);
      }
    }
    if (cumulated.length > MAX_FRAME) cumulated = "";
  }
  function finish(status: "completed" | "failed" | "interrupted" | "cancelled" | undefined, httpStatus?: number) {
    if (stopped) return;
    stopped = true;
    for (const { id, name } of openTools.values()) tool(id, name);
    const outcome = status === "completed" ? end || status : status || end || "interrupted";
    const comparable = history.comparable && !overflow && !seenTools.size && !!normalized(answer);
    try {
      store.finishGateway(ticket, {
        status: outcome, httpStatus, text: storeText ? readable(answer, 6000) : "", hasReply: replySeen,
        response: opaque(responseId), history: comparable && outcome === "completed" ? step(history.end, "assistant", normalized(answer)) : undefined,
        detail: httpStatus ? `HTTP ${httpStatus}` : "连接已中断",
      });
    } catch { /* fail open, never affect the client response */ }
  }
  return { sse, data, finish };
}

export async function observeGateway(
  req: Request, body: Obj, protocol: GatewayProtocol, identity: Pick<KeyIdentity, "name">, send: () => Promise<Response>,
) {
  if (!enabled() || process.env.WB2_WORKSPACE_CAPTURE === "0") return send();
  let observe: ReturnType<typeof collector>;
  try {
    const storeText = process.env.WB2_WORKSPACE_TRACE_TEXT === "1";
    const { input, history } = gatewayInput(req, body, protocol, identity, storeText);
    const store = gatewayStore();
    observe = collector(store, store.beginGateway(input), protocol, history, storeText);
  } catch {
    return send();
  }
  let response: Response;
  try { response = await send(); }
  catch (error) { observe.finish(req.signal.aborted ? "cancelled" : "failed"); throw error; }
  if (!response.ok || !response.body) {
    observe.finish(response.ok ? "completed" : req.signal.aborted || response.status === 499 ? "cancelled" : "failed", response.status);
    return response;
  }
  const stream = /text\/event-stream/i.test(response.headers.get("content-type") ?? "");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let json = "", skipJson = false;
  const aborted = () => observe.finish("cancelled", response.status);
  req.signal.addEventListener("abort", aborted, { once: true });
  if (req.signal.aborted) aborted();
  const close = () => req.signal.removeEventListener("abort", aborted);
  const outgoing = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          try {
            if (stream) observe.sse(decoder.decode() + "\n\n");
            else if (!skipJson) observe.data(json + decoder.decode());
          } catch { /* malformed monitoring input does not affect the stream */ }
          observe.finish(stream ? undefined : "completed", response.status);
          close();
          controller.close();
          return;
        }
        // Never mutate or tee the response. Downstream controls backpressure.
        controller.enqueue(value);
        try {
          if (stream) observe.sse(decoder.decode(value, { stream: true }));
          else if (!skipJson) {
            json += decoder.decode(value, { stream: true });
            if (json.length > MAX_FRAME) { json = ""; skipJson = true; }
          }
        } catch { /* never fail a model response due to monitoring */ }
      } catch (error) {
        observe.finish(req.signal.aborted ? "cancelled" : "interrupted", response.status);
        close(); controller.error(error);
      }
    },
    async cancel(reason) {
      close();
      observe.finish("cancelled", response.status);
      await reader.cancel(reason);
    },
  });
  return new Response(outgoing, { status: response.status, statusText: response.statusText, headers: response.headers });
}
