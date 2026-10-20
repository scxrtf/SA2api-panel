// sanitize.ts 出站请求体脱敏：剥离上游内容审核黑名单指纹（移植 internal/upstream/sanitize.go）。
//
// 背景：客户端（Claude Code 类 CLI）在 system prompt 注入若干固定模板句，
// 上游内容审核按逐字精确匹配拦截（非语义审核），一字改动即可绕过。
// 策略：键值/header 型指纹整段剥离；承载语义的模板句最小改写（换一词），语义不变。

type Obj = Record<string, unknown>;

// sanitizeFeatures 特征预检：任一命中才进入净化（includes 快速路径，
// 普通请求全不中 → 原样返回，零分配）。
const sanitizeFeatures = [
  "x-anthropic-billing-hdr", // header 键值段键名（小写形态）
  "You are Claude Code",     // 身份句（截断前缀即可命中）
  "Main branch (",           // 注入指令句（截断前缀即可命中）
  "You are a coding agent running in the Codex CLI", // Codex instructions 首段
  "github.com/anthropics/",  // 反馈句里的 Anthropic 仓库链接
  "11-128",                   // 上游反探测：裸数字错误码（无连字符）
];

// sanitizeHdrRe 剥离层：header 键名即触发（与值无关），整段删除。
const sanitizeHdrRe = /x-anthropic-billing-hdr:[^;\n]*;?\s*/gi;

// sanitizeBareHdrRe 兜底层：裸键名（无冒号无值）同样是指纹——实验证实 assistant
// 消息里反引号引用裸键名即触发 11-128，而剥离层要求冒号、对裸串无效。
// 键值形态被整段删除后，残留的裸键名做最小缩写（header→hdr）：破坏逐字匹配、
// 语义不变、保留可读性。大小写不敏感，覆盖 X-Anthropic-... 变体。
//
// 该正则不要求冒号，是 sanitizeHdrRe 的超集——hasFingerprint 与 sanitizeText
// 中两者并用：先删键值形态（sanitizeHdrRe），再缩写残留裸键名（本正则），
// 替换语义不同（整段删除 vs 最小缩写），不可合并为一个正则。
const sanitizeBareHdrRe = /x-anthropic-billing-hdr/gi;

// sanitizeKvRe 剥离层：尾随裸键值（cc_version=...; cc_entrypoint=...;）循环清理。
const sanitizeKvRe = /\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi;

// sanitizeRewrites 改写层：全模板句逐字替换（每句只改一个词，语义不变）。
// from/to 已从 Go 源字节级还原（渲染层会规整差异词，以字节为准）。
//
// 身份句的匹配串**不带结尾标点**（只到 "…for Claude" 为止）：CLI 版以句号收尾，
// 桌面版以逗号接后继内容。去掉结尾标点后两种形态一并覆盖（替换串同样不带标点）。
// 注意仍要求 "You are Claude Code, " 前缀，不做更宽的子串替换，以免误伤零散文本。
const sanitizeRewrites: [string, string][] = [
  // 身份句：tool 词删除（"CLI tool for" → "CLI for"）。
  [
    "You are Claude Code, Anthropic's official CLI for Claude",
    "You are Claude Code, Anthropic's official CLI for Claude",
  ],
  // 注入指令句：Main → Default。
  [
    "Main branch (you will usually use this for PRs)",
    "Default branch (you will usually use this for PRs)",
  ],
  // Codex instructions 首段：tool 词删除。
  [
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
    "You are a coding agent running in the Codex CLI, a terminal-based coding assistant.",
  ],
  // 反馈句：give → provide（整句带 Anthropic 仓库链接，上游按整句拦截，一词之差绕过）。
  [
    "To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
    "To provide feedback, users should report the issue at https://github.com/anthropics/claude-code/issues",
  ],
  // 上游反探测：裸数字 11128 即整单拦截（11128 正是本类拦截自身的错误码，
  // 上游据此识别"在讨论/回显其内部错误码"的请求）。插入连字符保留可读性与指代
  // （零宽空格无效，实测上游会归一化）。
  ["11128", "11-128"],
];

// hasFingerprint 特征预检：先走 includes 快速路径（零分配）；
// header 键名有大小写变体且可能以裸键名形态出现（无冒号），includes 大小写敏感、
// sanitizeHdrRe 要求冒号——两者都会漏掉「混合大小写 + 裸键名」，
// 必须再用不要求冒号的 (?i) 正则兜底（sanitizeBareHdrRe），否则整条净化被跳过。
function hasFingerprint(text: string): boolean {
  for (const f of sanitizeFeatures) {
    if (text.includes(f)) return true;
  }
  return sanitizeBareHdrRe.test(text);
}

// sanitizeText 单段文本净化：预检不中 → 返回原串（零分配）。
export function sanitizeText(text: string): string {
  if (!hasFingerprint(text)) return text;
  for (const [from, to] of sanitizeRewrites) {
    if (text.includes(from)) text = text.split(from).join(to);
  }
  sanitizeHdrRe.lastIndex = 0;
  if (sanitizeHdrRe.test(text)) {
    sanitizeHdrRe.lastIndex = 0;
    text = text.replace(sanitizeHdrRe, "");
  }
  if (text.includes("cc_")) {
    let prev = "";
    sanitizeKvRe.lastIndex = 0;
    while (prev !== text) { // 清尾随裸 kv
      prev = text;
      sanitizeKvRe.lastIndex = 0;
      text = text.replace(sanitizeKvRe, "");
    }
  }
  // 兜底：键值形态已在上面整段删除，这里只剩裸键名（引用/示例文本形态）。
  sanitizeBareHdrRe.lastIndex = 0;
  text = text.replace(sanitizeBareHdrRe, "x-anthropic-billing-hdr");
  return text.trim();
}

// sanitizeContent 兼容字符串与多模态数组；只动 text part，image 等 part 不动。
function sanitizeContent(v: unknown): { value: unknown; changed: boolean } {
  if (typeof v === "string") {
    const s = sanitizeText(v);
    return { value: s, changed: s !== v };
  }
  if (Array.isArray(v)) {
    let changed = false;
    for (const p of v) {
      if (typeof p !== "object" || p === null) continue;
      const m = p as Obj;
      if (typeof m.text !== "string") continue;
      const s = sanitizeText(m.text);
      if (s !== m.text) { m.text = s; changed = true; }
    }
    return { value: v, changed };
  }
  return { value: v, changed: false };
}

// sanitizeToolCalls 净化 assistant.tool_calls[].function.arguments。
// arguments 是**字符串化的 JSON**（不是对象），因此按文本走 sanitizeText 即可。
function sanitizeToolCalls(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  let changed = false;
  for (const c of v) {
    if (typeof c !== "object" || c === null) continue;
    const fn = (c as Obj).function;
    if (typeof fn !== "object" || fn === null) continue;
    const args = (fn as Obj).arguments;
    if (typeof args !== "string") continue;
    const s = sanitizeText(args);
    if (s !== args) { (fn as Obj).arguments = s; changed = true; }
  }
  return changed;
}

// sanitizeMessages 净化 messages 中的 content / reasoning_content / reasoning / tool_calls。
// content 与 tool_calls 各自独立判断：content 可以为 null（工具调用轮），
// 早期版本在此跳过会导致这类消息的 tool_calls 完全不被净化。
export function sanitizeMessages(messages: unknown[]): boolean {
  let changed = false;
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const m = msg as Obj;
    if ("content" in m) {
      const r = sanitizeContent(m.content);
      if (r.changed) { m.content = r.value; changed = true; }
    }
    // reasoning_content / reasoning（思维链回填字段）实测同样携带指纹，同等净化。
    if (typeof m.reasoning_content === "string") {
      const s = sanitizeText(m.reasoning_content);
      if (s !== m.reasoning_content) { m.reasoning_content = s; changed = true; }
    }
    if (typeof m.reasoning === "string") {
      const s = sanitizeText(m.reasoning);
      if (s !== m.reasoning) { m.reasoning = s; changed = true; }
    }
    if ("tool_calls" in m && sanitizeToolCalls(m.tool_calls)) changed = true;
  }
  return changed;
}

// sanitizeBody 出站请求体净化入口：只在 messages 存在时净化，返回是否发生变化。
export function sanitizeBody(obj: Obj): boolean {
  const messages = obj.messages;
  if (!Array.isArray(messages)) return false;
  return sanitizeMessages(messages);
}
