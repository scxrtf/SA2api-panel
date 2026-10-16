// Anthropic Messages API 协议翻译层（移植 internal/server/anthropic.go）。
//
// 边界与 Go 完全一致：
//   - max_tokens / thinking / tool_choice 不透出（上游自行决定生成长度）；
//   - usage 四段仅在客户端声明 anthropic-beta: context-management 时透出；
//   - image 块拒绝（私有管线与 Anthropic base64 块不同构，强转会假阴性）。
//
// 注意缓存别名口径：chat 管线非流式聚合器已应用 normalizeUsageCacheAliases，
// 因此读 prompt_cache_hit_tokens 时兜底读 prompt_tokens_details.cached_tokens
// 与 cache_read_input_tokens（等价于 Go 聚合后的字段形态）。

type Obj = Record<string, unknown>;

export const anthropicContextMgmtBeta = "context-management";

export interface AnthropicRequest {
  model?: string;
  system?: unknown; // string 或 [{type:"text",text:...}]
  messages?: unknown;
  stream?: boolean;
  tools?: unknown;
}

// hasAnthropicBeta 判断请求是否声明了指定前缀的 anthropic-beta 能力
//（同一头可出现多次/逗号分隔，前缀匹配版本化值）。
export function hasAnthropicBeta(req: Request, prefix: string): boolean {
  const headers: string[] = [];
  const raw = req.headers.get("anthropic-beta");
  if (raw) headers.push(raw);
  // Headers.get 已合并逗号分隔多值；逐段切分前缀匹配。
  for (const v of headers) {
    for (const item of v.split(",")) {
      if (item.trim().startsWith(prefix)) return true;
    }
  }
  return false;
}

// anthropicToOpenAI Messages 请求体 → chat.completions 请求体。
export function anthropicToOpenAI(req: AnthropicRequest): Obj {
  const messages: Obj[] = [];

  const sys = anthropicSystemText(req.system);
  if (sys !== "") messages.push({ role: "system", content: sys });

  const raw = Array.isArray(req.messages) ? (req.messages as Obj[]) : [];
  for (let i = 0; i < raw.length; i++) {
    const converted = anthropicMessageToOpenAI(raw[i]);
    messages.push(...converted);
  }
  if (messages.length === 0) {
    throw new AnthropicTranslateError("messages is required");
  }

  const out: Obj = { model: req.model ?? "", messages };
  if (req.stream === true) out["stream"] = true;
  if (Array.isArray(req.tools)) {
    const tools = anthropicToolsToOpenAI(req.tools as Obj[]);
    if (tools.length > 0) out["tools"] = tools;
  }
  return out;
}

export class AnthropicTranslateError extends Error {}

// anthropicSystemText 把 system 字段（string 或 [{type:"text",text}]）展平为纯文本。
function anthropicSystemText(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  const parts: string[] = [];
  for (const b of raw as Obj[]) {
    if (b && typeof b === "object" && typeof b["text"] === "string" && b["text"] !== "") {
      parts.push(b["text"] as string);
    }
  }
  return parts.join("\n\n");
}

// anthropicMessageToOpenAI 转换单条消息，可能展开为多条
//（assistant 的 tool_use 块 → 带 tool_calls 的 assistant 消息；
// user 侧 tool_result 块 → 对应数量的 role=tool 消息，必须先于文本输出）。
function anthropicMessageToOpenAI(m: Obj): Obj[] {
  if (!m || typeof m !== "object") throw new AnthropicTranslateError("invalid message");
  const role = typeof m["role"] === "string" ? (m["role"] as string) : "";
  const content = m["content"];

  if (content === undefined || content === null) {
    if (!role) throw new AnthropicTranslateError("missing role");
    return [{ role, content: "" }];
  }
  if (typeof content === "string") {
    if (!role) throw new AnthropicTranslateError("missing role");
    return [{ role, content }];
  }
  if (!Array.isArray(content)) throw new AnthropicTranslateError("unsupported content form");

  const texts: string[] = [];
  const toolCalls: Obj[] = [];
  const toolResults: Obj[] = [];
  for (let bi = 0; bi < content.length; bi++) {
    const b = content[bi] as Obj;
    if (!b || typeof b !== "object") continue;
    const btype = typeof b["type"] === "string" ? (b["type"] as string) : "";
    switch (btype) {
      case "text": {
        const t = typeof b["text"] === "string" ? (b["text"] as string) : "";
        if (t !== "") texts.push(t);
        break;
      }
      case "image":
        throw new AnthropicTranslateError(
          `content[${bi}]: image blocks are not supported (use the OpenAI endpoint with image_url parts)`,
        );
      case "tool_use": {
        const id = typeof b["id"] === "string" ? (b["id"] as string) : "";
        const name = typeof b["name"] === "string" ? (b["name"] as string) : "";
        const input =
          b["input"] !== undefined && b["input"] !== null ? JSON.stringify(b["input"]) : "{}";
        toolCalls.push({
          id,
          type: "function",
          function: { name, arguments: input },
        });
        break;
      }
      case "tool_result": {
        const msg: Obj = {
          role: "tool",
          content: anthropicToolResultText(b["content"]),
        };
        if (typeof b["tool_use_id"] === "string" && b["tool_use_id"] !== "") {
          msg["tool_call_id"] = b["tool_use_id"];
        }
        toolResults.push(msg);
        break;
      }
      default:
        // 未知块类型（thinking / cache_control 附着块等）→ 跳过，不中断。
        break;
    }
  }

  const out: Obj[] = [];
  out.push(...toolResults);
  if (role === "assistant") {
    const msg: Obj = {
      role: "assistant",
      content: texts.length > 0 ? texts.join("\n\n") : "",
    };
    if (toolCalls.length > 0) msg["tool_calls"] = toolCalls;
    out.push(msg);
  } else if (texts.length > 0 || toolResults.length === 0) {
    out.push({ role: role || "user", content: texts.join("\n\n") });
  }
  if (out.length === 0) {
    throw new AnthropicTranslateError("empty message after conversion");
  }
  return out;
}

// anthropicToolResultText tool_result 的 content 展平为纯文本。
function anthropicToolResultText(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const b of raw as Obj[]) {
      if (b && typeof b === "object" && typeof b["text"] === "string" && b["text"] !== "") {
        parts.push(b["text"] as string);
      }
    }
    if (parts.length > 0) return parts.join("\n\n");
  }
  return JSON.stringify(raw);
}

// anthropicToolsToOpenAI tools 数组 → OpenAI function 工具声明。
function anthropicToolsToOpenAI(raw: Obj[]): Obj[] {
  const out: Obj[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const name = typeof t["name"] === "string" ? (t["name"] as string) : "";
    if (name === "") continue;
    const desc = typeof t["description"] === "string" ? (t["description"] as string) : "";
    const schema =
      t["input_schema"] !== undefined && t["input_schema"] !== null
        ? t["input_schema"]
        : { type: "object" };
    out.push({
      type: "function",
      function: { name, description: desc, parameters: schema },
    });
  }
  return out;
}

// ─── 响应方向：OpenAI → Anthropic ──────────────────────────────────────────

// jsonInt64 宽松提取 JSON 数值。
function jsonInt64(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const f = Number(v);
    if (Number.isFinite(f)) return Math.trunc(f);
  }
  return 0;
}

// bestCacheHit 与 Go normalizeUsageCacheAliases 的取数口径一致：多别名取首个正值。
function bestCacheHit(usage: Obj): number {
  const details = usage["prompt_tokens_details"];
  if (details && typeof details === "object") {
    const v = jsonInt64((details as Obj)["cached_tokens"]);
    if (v > 0) return v;
  }
  for (const key of ["prompt_cache_hit_tokens", "cache_read_input_tokens", "cached_tokens"]) {
    const v = jsonInt64(usage[key]);
    if (v > 0) return v;
  }
  return 0;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

// openaiUsageToAnthropic OpenAI usage → Anthropic usage 字段。
export function openaiUsageToAnthropic(usage: Obj | null, ctxMgmt: boolean): AnthropicUsage {
  const u: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };
  if (!usage) return u;
  u.input_tokens = jsonInt64(usage["prompt_tokens"]);
  u.output_tokens = jsonInt64(usage["completion_tokens"]);
  if (ctxMgmt) {
    const hit = bestCacheHit(usage);
    if (hit > 0) u.cache_read_input_tokens = hit;
    const miss = jsonInt64(usage["prompt_cache_miss_tokens"]);
    if (miss > 0) u.cache_creation_input_tokens = miss;
  }
  return u;
}

function firstString(m: Obj, key: string): string {
  const s = m[key];
  return typeof s === "string" ? s : "";
}

// openaiChoiceToAnthropicContent 从首个 choice 提取 content blocks 与 stop_reason。
function openaiChoiceToAnthropicContent(resp: Obj): { blocks: Obj[]; stopReason: string } {
  const choices = Array.isArray(resp["choices"]) ? (resp["choices"] as Obj[]) : [];
  if (choices.length === 0) {
    return { blocks: [{ type: "text", text: "" }], stopReason: "end_turn" };
  }
  const choice = choices[0];
  const message = (choice["message"] as Obj) ?? {};

  const blocks: Obj[] = [];
  const text = message["content"];
  if (typeof text === "string" && text !== "") {
    blocks.push({ type: "text", text });
  }
  let stopReason = "end_turn";
  const tcs = Array.isArray(message["tool_calls"]) ? (message["tool_calls"] as Obj[]) : [];
  for (const tc of tcs) {
    const fn = (tc["function"] as Obj) ?? {};
    const name = firstString(fn, "name");
    const args = firstString(fn, "arguments");
    let input: unknown = {};
    if (args !== "") {
      try {
        input = JSON.parse(args);
      } catch {
        input = {};
      }
    }
    blocks.push({ type: "tool_use", id: firstString(tc, "id"), name, input });
  }
  if (tcs.length > 0) stopReason = "tool_use";
  if (firstString(choice, "finish_reason") === "length") stopReason = "max_tokens";
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return { blocks, stopReason };
}

// openaiToAnthropicMessage 非流式 OpenAI 响应 → Anthropic message 对象。
export function openaiToAnthropicMessage(resp: Obj, ctxMgmt: boolean): Obj {
  const usage = resp["usage"] && typeof resp["usage"] === "object" ? (resp["usage"] as Obj) : null;
  const { blocks, stopReason } = openaiChoiceToAnthropicContent(resp);
  return {
    id: firstString(resp, "id") || "msg_gateway",
    type: "message",
    role: "assistant",
    model: firstString(resp, "model"),
    content: blocks,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: openaiUsageToAnthropic(usage, ctxMgmt),
  };
}

// ─── 流式：聚合 OpenAI SSE 后重建 Anthropic 事件流 ─────────────────────────

interface ToolCallSlot {
  id: string;
  name: string;
  args: string;
}

export interface OpenAIStreamFrame {
  text: string;
  toolCalls: ToolCallSlot[];
  finish: string;
}

// aggregateOpenAISSE 把 chat.completions SSE 文本聚合为完整输出 + 末帧 usage。
export function aggregateOpenAISSE(body: string): { frame: OpenAIStreamFrame; usage: Obj | null } {
  const frame: OpenAIStreamFrame = { text: "", toolCalls: [], finish: "" };
  let usage: Obj | null = null;
  const calls = new Map<number, ToolCallSlot>();
  const order: number[] = [];

  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") break;
    let chunk: Obj;
    try {
      chunk = JSON.parse(payload) as Obj;
    } catch {
      continue;
    }
    const u = chunk["usage"];
    if (u && typeof u === "object") usage = u as Obj;
    const choices = Array.isArray(chunk["choices"]) ? (chunk["choices"] as Obj[]) : [];
    for (const choice of choices) {
      const fr = choice["finish_reason"];
      if (typeof fr === "string" && fr !== "") frame.finish = fr;
      let delta = choice["delta"] as Obj | undefined;
      if (!delta || typeof delta !== "object") delta = choice["message"] as Obj | undefined;
      if (!delta || typeof delta !== "object") continue;
      const c = delta["content"];
      if (typeof c === "string") frame.text += c;
      const tcs = Array.isArray(delta["tool_calls"]) ? (delta["tool_calls"] as Obj[]) : [];
      for (const tc of tcs) {
        const idx = jsonInt64(tc["index"]);
        let slot = calls.get(idx);
        if (!slot) {
          slot = { id: "", name: "", args: "" };
          calls.set(idx, slot);
          order.push(idx);
        }
        const id = tc["id"];
        if (typeof id === "string" && id !== "") slot.id = id;
        const fn = tc["function"] as Obj | undefined;
        if (fn && typeof fn === "object") {
          const name = fn["name"];
          if (typeof name === "string" && name !== "") slot.name = name;
          const args = fn["arguments"];
          if (typeof args === "string" && args !== "") slot.args += args;
        }
      }
    }
  }
  for (const idx of order) frame.toolCalls.push(calls.get(idx)!);
  return { frame, usage };
}

// buildAnthropicStream 重建 Anthropic SSE 事件序列文本：
//   message_start → [text 块] → [tool_use 块序列] → message_delta(usage) → message_stop
export function buildAnthropicStream(
  frame: OpenAIStreamFrame,
  usage: Obj | null,
  ctxMgmt: boolean,
): string {
  const au = openaiUsageToAnthropic(usage, ctxMgmt);
  const startUsage: AnthropicUsage = { ...au, output_tokens: 0 };
  const chunks: string[] = [];
  const emit = (event: string, v: Obj) => {
    chunks.push(`event: ${event}\ndata: ${JSON.stringify(v)}\n\n`);
  };

  emit("message_start", {
    type: "message_start",
    message: {
      id: "msg_gateway",
      type: "message",
      role: "assistant",
      model: "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: startUsage,
    },
  });

  let idx = 0;
  const stopBlock = () => {
    emit("content_block_stop", { type: "content_block_stop", index: idx });
    idx++;
  };

  if (frame.text !== "") {
    emit("content_block_start", {
      type: "content_block_start",
      index: idx,
      content_block: { type: "text", text: "" },
    });
    emit("content_block_delta", {
      type: "content_block_delta",
      index: idx,
      delta: { type: "text_delta", text: frame.text },
    });
    stopBlock();
  }

  let stopReason = "end_turn";
  for (const tc of frame.toolCalls) {
    emit("content_block_start", {
      type: "content_block_start",
      index: idx,
      content_block: { type: "tool_use", id: tc.id, name: tc.name, input: {} },
    });
    emit("content_block_delta", {
      type: "content_block_delta",
      index: idx,
      delta: { type: "input_json_delta", partial_json: tc.args },
    });
    stopBlock();
    stopReason = "tool_use";
  }
  if (frame.finish === "length") stopReason = "max_tokens";

  emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: au,
  });
  emit("message_stop", { type: "message_stop" });
  return chunks.join("");
}

// anthropicErrorType 按 HTTP 状态映射 Anthropic 错误类型。
export function anthropicErrorType(status: number): string {
  if (status === 401 || status === 403) return "authentication_error";
  if (status === 429) return "rate_limit_error";
  if (status === 413) return "request_too_large";
  if (status >= 500) return "api_error";
  return "invalid_request_error";
}

// writeAnthropicError Anthropic 协议错误形态：{"type":"error","error":{...}}。
export function anthropicError(status: number, errType: string, msg: string): Response {
  return Response.json(
    { type: "error", error: { type: errType, message: msg } },
    { status },
  );
}
