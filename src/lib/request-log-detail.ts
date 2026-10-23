// 请求日志详情：集中处理大字段裁剪、图片脱敏和出站参数差异。

const MAX_MESSAGE_ITEMS = 200;
const MAX_MESSAGE_CHARS = 320_000;
const MAX_VALUE_CHARS = 80_000;
const MAX_OVERRIDE_ITEMS = 200;
const MAX_OVERRIDE_VALUE_CHARS = 4_000;
const MAX_DEPTH = 12;

export interface ParameterOverride {
  path: string;
  before: unknown;
  after: unknown;
}

export interface AttemptDetail {
  attempt: number;
  uid?: string;
  provider?: string;
  status: number;
  ok: boolean;
  errKind: string;
  durationMs: number;
  ttfbMs?: number;
  error?: string;
}

interface ClipState {
  remaining: number;
  truncated: boolean;
}

function clipText(value: string, state?: ClipState, limit = MAX_VALUE_CHARS): string {
  const room = state ? Math.max(0, state.remaining) : limit;
  const max = Math.min(limit, room);
  if (value.length <= max) {
    if (state) state.remaining -= value.length;
    return value;
  }
  if (state) {
    state.remaining = 0;
    state.truncated = true;
  }
  const omitted = value.length - max;
  return value.slice(0, max) + `\n…[已截断 ${omitted} 字符]`;
}

function dataImageSummary(value: string): string | null {
  if (!value.startsWith("data:") || !value.includes(";base64,")) return null;
  const comma = value.indexOf(",");
  const header = comma >= 0 ? value.slice(0, comma) : "data:image";
  const size = comma >= 0 ? value.length - comma - 1 : value.length;
  return `${header},…[base64 ${size} 字符]`;
}

function sanitizeValue(
  value: unknown,
  state: ClipState,
  seen: WeakSet<object>,
  depth = 0,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return clipText(dataImageSummary(value) ?? value, state);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return "[层级过深]";
  if (seen.has(value)) return "[循环引用]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_MESSAGE_ITEMS).map((item) =>
      sanitizeValue(item, state, seen, depth + 1));
    if (value.length > MAX_MESSAGE_ITEMS) {
      out.push(`…[另有 ${value.length - MAX_MESSAGE_ITEMS} 项]`);
    }
    return out;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries.slice(0, MAX_MESSAGE_ITEMS)) {
    if (item === undefined) continue;
    out[key] = sanitizeValue(item, state, seen, depth + 1);
    if (state.remaining <= 0) break;
  }
  if (entries.length > MAX_MESSAGE_ITEMS) {
    out["_truncated"] = `另有 ${entries.length - MAX_MESSAGE_ITEMS} 个字段`;
  }
  return out;
}

function clippedValue(value: unknown): unknown {
  const state: ClipState = { remaining: MAX_OVERRIDE_VALUE_CHARS, truncated: false };
  const out = sanitizeValue(value, state, new WeakSet());
  return state.truncated ? out : out;
}

function equalValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function requestMessagesForLog(value: unknown): unknown[] {
  const state: ClipState = { remaining: MAX_MESSAGE_CHARS, truncated: false };
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_MESSAGE_ITEMS).map((message) =>
      sanitizeValue(message, state, new WeakSet()));
    if (value.length > MAX_MESSAGE_ITEMS) {
      out.push({ role: "system", content: `[另有 ${value.length - MAX_MESSAGE_ITEMS} 条消息未记录]` });
    }
    if (state.truncated) out.push({ role: "system", content: "[对话内容过长，日志已截断]" });
    return out;
  }
  if (value === undefined || value === null) return [];
  return [{ role: "unknown", content: sanitizeValue(value, state, new WeakSet()) }];
}

export function assistantMessageForLog(input: {
  content?: unknown;
  reasoningContent?: unknown;
  toolCalls?: unknown;
  role?: unknown;
}): Record<string, unknown> | null {
  const content = typeof input.content === "string" ? input.content : "";
  const reasoning = typeof input.reasoningContent === "string" ? input.reasoningContent : "";
  const toolCalls = Array.isArray(input.toolCalls) ? input.toolCalls : [];
  if (!content && !reasoning && toolCalls.length === 0) return null;
  const state: ClipState = { remaining: MAX_MESSAGE_CHARS, truncated: false };
  const out: Record<string, unknown> = {
    role: typeof input.role === "string" && input.role ? input.role : "assistant",
    content: clipText(content, state),
  };
  if (reasoning) out["reasoning_content"] = clipText(reasoning, state);
  if (toolCalls.length > 0) {
    out["tool_calls"] = sanitizeValue(toolCalls, state, new WeakSet());
  }
  if (state.truncated) out["_truncated"] = true;
  return out;
}

export function responseMessageFromObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const toolCalls = Array.isArray(obj["tool_calls"]) ? obj["tool_calls"] : [];
  return assistantMessageForLog({
    role: obj["role"],
    content: obj["content"],
    reasoningContent: obj["reasoning_content"],
    toolCalls,
  });
}

export function parameterOverrides(
  before: unknown,
  after: unknown,
): ParameterOverride[] {
  const out: ParameterOverride[] = [];
  const walk = (a: unknown, b: unknown, path: string) => {
    if (out.length >= MAX_OVERRIDE_ITEMS) return;
    if (equalValue(a, b)) return;
    const aObj = a && typeof a === "object" && !Array.isArray(a);
    const bObj = b && typeof b === "object" && !Array.isArray(b);
    if (aObj && bObj) {
      const aa = a as Record<string, unknown>;
      const bb = b as Record<string, unknown>;
      for (const key of new Set([...Object.keys(aa), ...Object.keys(bb)])) {
        walk(aa[key], bb[key], path ? `${path}.${key}` : key);
        if (out.length >= MAX_OVERRIDE_ITEMS) break;
      }
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        walk(a[i], b[i], `${path}[${i}]`);
        if (out.length >= MAX_OVERRIDE_ITEMS) break;
      }
      return;
    }
    out.push({
      path: path || "$",
      before: clippedValue(a),
      after: clippedValue(b),
    });
  };
  walk(before, after, "$");
  if (out.length >= MAX_OVERRIDE_ITEMS) {
    out[MAX_OVERRIDE_ITEMS - 1] = {
      path: "…",
      before: "",
      after: `参数差异超过 ${MAX_OVERRIDE_ITEMS} 项，已截断`,
    };
  }
  return out;
}

export function failureDetail(input: {
  status: number;
  code: string;
  kind?: string;
  message?: string;
  upstream?: string;
  hint?: string;
  stage?: string;
  modelBlock?: string;
}): string {
  const lines = [
    `状态: ${input.status}${input.code ? " " + input.code : ""}`,
  ];
  if (input.kind) lines.push(`错误类型: ${input.kind}`);
  if (input.stage) lines.push(`失败阶段: ${input.stage}`);
  if (input.message?.trim()) lines.push(`网关信息: ${input.message.trim()}`);
  if (input.modelBlock?.trim()) lines.push(`模型冷却: ${input.modelBlock.trim()}`);
  if (input.hint?.trim()) lines.push(`排错提示: ${input.hint.trim()}`);
  if (input.upstream?.trim()) {
    lines.push("", "上游原始响应:", clipText(input.upstream, undefined, 80_000));
  }
  return lines.join("\n");
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.stack && error.stack !== error.message
      ? `${error.name}: ${error.message}\n${error.stack}`
      : `${error.name}: ${error.message}`;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
