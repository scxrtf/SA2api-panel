// 请求日志详情：集中处理大字段裁剪、图片脱敏和出站参数差异。

// 单行日志体积上限：requestMessages + responseMessage 各自受 MAX_MESSAGE_CHARS 约束，
// errorDetail 受 MAX_VALUE_CHARS 约束。原 320K/80K 会让单行 TOAST 逼近 700KB，
// 16500 行就能吃掉 1.4GB 磁盘（Supabase 免费档直接触发只读）。
//
// 预算口径（2026-11-11 修正）：
// - 每条消息有独立上限 PER_MESSAGE_CHARS（60K），长消息不会被共享预算挤掉；
// - 整个 messages 数组另有总量上限 MAX_MESSAGE_CHARS（160K），但分配从「最新一轮」
//   往回给：先保住最近的用户提问与助手回复，最早的历史消息先被压缩/丢弃，
//   并显式插入一条 role:"log" 的占位说明，面板据此区分系统占位与真实 system 消息。
const MAX_MESSAGE_ITEMS = 200;
const PER_MESSAGE_CHARS = 60_000;
const MAX_MESSAGE_CHARS = 160_000;
const MAX_VALUE_CHARS = 40_000;
const MAX_OVERRIDE_ITEMS = 200;
const MAX_OVERRIDE_VALUE_CHARS = 4_000;
const MAX_DEPTH = 12;

// 对话正文（requestMessages / responseMessage）始终落库：面板「请求日志」对话
// 记录区块依赖这两列。单行体积已由 MAX_MESSAGE_CHARS（120K）+ 图片脱敏兜底，
// 保留清理任务（retention）负责按保留期置空旧行控制磁盘。
export function logDialogEnabled(): boolean {
  return process.env.REQUEST_LOG_DIALOG !== "0";
}

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

// sanitizeOne：用独立状态裁剪单条消息，返回消息与其实际占用的字符数。
// 上限取 perMessage 与共享池剩余两者的较小值。
function sanitizeOne(
  value: unknown,
  poolRemaining: number,
  perMessage: number,
): { out: unknown; used: number; truncated: boolean } {
  const cap = Math.max(0, Math.min(perMessage, poolRemaining));
  const state: ClipState = { remaining: cap, truncated: false };
  const out = sanitizeValue(value, state, new WeakSet());
  return { out, used: cap - state.remaining, truncated: state.truncated };
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
  if (Array.isArray(value)) {
    const items = value.slice(-MAX_MESSAGE_ITEMS); // 保最新 MAX_MESSAGE_ITEMS 条
    const droppedByCount = value.length - items.length;
    // 两遍分配：先按原序给每条一个独立上限并累计用量；超出总量时从最早的
    // 消息开始回收，保证尾部（最近一轮对话）完整。
    const parts = items.map((m) => sanitizeOne(m, PER_MESSAGE_CHARS, PER_MESSAGE_CHARS));
    let total = parts.reduce((s, p) => s + p.used, 0);
    let droppedChars = 0;
    let startIndex = 0;
    while (total > MAX_MESSAGE_CHARS && startIndex < parts.length - 1) {
      total -= parts[startIndex].used;
      droppedChars += parts[startIndex].used;
      startIndex++;
    }
    const out: unknown[] = [];
    const droppedMsgs = droppedByCount + startIndex;
    if (droppedMsgs > 0 || droppedChars > 0) {
      out.push({
        role: "log",
        content: `[日志] 早期 ${droppedMsgs} 条消息未记录` +
          (droppedChars > 0 ? `（释放 ${droppedChars} 字符预算给最近对话）` : ""),
      });
    }
    let anyTruncated = false;
    for (let i = startIndex; i < parts.length; i++) {
      if (parts[i].truncated) anyTruncated = true;
      out.push(parts[i].out);
    }
    if (anyTruncated) {
      out.push({ role: "log", content: `[日志] 部分消息超过单条 ${PER_MESSAGE_CHARS} 字符上限，正文内已标注截断` });
    }
    return out;
  }
  if (value === undefined || value === null) return [];
  const one = sanitizeOne(value, MAX_MESSAGE_CHARS, MAX_MESSAGE_CHARS);
  return [{ role: "unknown", content: one.out }];
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
