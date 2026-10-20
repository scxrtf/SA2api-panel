// dsml.ts 上游正文里的「模型原生工具调用标记」修复层（移植 internal/upstream/dsml.go）。
//
// 背景：本网关背后的 WorkBuddy 上游最终由 DeepSeek 系模型出结果，它的工具调用原生
// 语法不是 OpenAI 的 JSON tool_calls，而是一段带全角竖线分隔符的标记文本：
//
//   <PIPE>DSML<PIPE> calls>
//   <PIPE>DSML<PIPE> invoke name="exec_command">
//   <PIPE>DSML<PIPE> parameter name="cmd" string="true">ls -la<PIPE>DSML<PIPE> parameter>
//   </PIPE>DSML<PIPE> invoke>
//   </PIPE>DSML<PIPE> calls>
//
// （上面用 <PIPE> 占位，真实分隔符是两个 U+FF5C 全角竖线，见 markupPipe 常量。）
//
// 上游只在请求**声明了 tools** 时才把这段标记解析成结构化 tool_calls。一旦某次请求
// 没带上 tools（客户端一次性 exec 探测、auto-review 复核回合、或任何 tools 中途丢失
// 的请求），模型仍然想调工具，于是这段标记以纯文本落进 content。下游没有任何一层
// 认识它：Codex 只执行 Responses API 的结构化 function_call 条目，于是把标记当成
// 普通助手文本写进会话历史，回合直接结束、工具一次都没跑。
//
// 本文件是最后一道防线：在出站响应（流式与非流式）里识别这段标记，还原成标准的
// tool_calls / delta.tool_calls。
//
// 判定分两级：
//   严格判定（名单非空）：块内每个 invoke 的工具名都必须在名单里。
//   弱判定（名单为空）：只要求块结构完美闭合、块内不夹带正文，且每个工具名形如
//     合法标识符（markupToolNameRe）。
//
// 两级判定共同的硬性前提（任一不满足即原文透出）：
//   - 标记块完整闭合，块内除 invoke/parameter 与空白外没有夹带其他正文；
//   - 本回合上游没有给出任何结构化 tool_calls（不覆盖真实调用）；
//   - 非流式路径额外要求 finish_reason 为 stop。
//
// 任何一条不满足 → 原文逐字节原样透出。修复层绝不吞字节：所有「拿不准」的分支都
// 走回吐路径。

// markupPipe 是模型原生工具调用标记的分隔符：两个全角竖线 U+FF5C。
const markupPipe = "｜｜";

// 标记块与内层元素的起止标记。结束标记一律比同名开始标记多一个 '/'。
const markupOpen = "<" + markupPipe + "DSML" + markupPipe + " calls>";
const markupClose = "</" + markupPipe + "DSML" + markupPipe + " calls>";
const markupInvokeClose = "</" + markupPipe + "DSML" + markupPipe + " invoke>";
const markupParamClose = "</" + markupPipe + "DSML" + markupPipe + " parameter>";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 开始标记公共前缀（转义后供正则复用）。
const markupTagPrefix = escapeRegExp("<" + markupPipe + "DSML" + markupPipe);

// markupInvokeRe 匹配 invoke 头；markupParamRe 匹配 parameter 头（string 属性可选，
// 缺省按 JSON 解析取值）。
const markupInvokeRe = new RegExp(markupTagPrefix + String.raw`\s+invoke\s+name="([^"]*)"\s*>`, "g");
const markupParamRe = new RegExp(
  markupTagPrefix + String.raw`\s+parameter\s+name="([^"]*)"(?:\s+string="(true|false)")?\s*>`,
  "g",
);

// markupToolNameRe 工具名合理形态（弱判定兜底，挡住 <tool_name>、NAME 之类占位符）。
const markupToolNameRe = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;

// markupMaxBlockBytes 单次标记块累积上限：超过仍未闭合 → 判定「这不是标记」，
// 立即原文回吐并退出块态，避免无限缓冲。
const markupMaxBlockBytes = 256 * 1024;

// MarkupCall 一次从正文里还原出来的工具调用。
export interface MarkupCall {
  name: string;
  arguments: string; // JSON 对象文本
}

type Obj = Record<string, unknown>;

// MarkupRepair 流式与非流式共用的标记修复状态机。
// 非并发安全：一条响应流一个实例。
export class MarkupRepair {
  private allowed: Set<string>;
  private allowUnknown: boolean;
  private hold = ""; // 已确认可能属于标记、但还不足以判定的尾部缓冲
  private inBlock = false; // 已消费掉 markupOpen，正在块内部累积
  private seen = 0; // 识别到的标记块数（含被拒绝的）
  private rejected = 0; // 识别到但未转换的块数
  private converted = 0; // 已还原的调用数

  // allowed 为请求体里提取到的工具名集合（可能为空——tools 声明丢失是常态）；
  // allowUnknown 为 true 时启用弱判定（名单为空也尝试修复）。
  constructor(allowed: Set<string> | null, allowUnknown: boolean) {
    this.allowed = allowed ?? new Set();
    this.allowUnknown = allowUnknown;
  }

  enabled(): boolean {
    return this.allowed.size > 0 || this.allowUnknown;
  }
  convertedCount(): number {
    return this.converted;
  }
  seenCount(): number {
    return this.seen;
  }
  rejectedCount(): number {
    return this.rejected;
  }

  // feed 吃进一段正文增量，返回「应作为正文透出的部分」与「还原出来的工具调用」。
  // 不变量：所有 feed 入参拼接后 = 所有返回正文 + flush() + 被转换掉的标记块原文。
  feed(text: string): { emit: string; calls: MarkupCall[] } {
    if (!this.enabled()) return { emit: text, calls: [] };
    let s = this.hold + text;
    this.hold = "";
    let emit = "";
    const calls: MarkupCall[] = [];
    for (;;) {
      if (!this.inBlock) {
        const i = markupStartCandidate(s);
        if (i < 0) {
          emit += s;
          break;
        }
        if (s.length - i < markupOpen.length) {
          // 起点被截断在增量边界：留到下一片再判定。
          emit += s.slice(0, i);
          this.hold = s.slice(i);
          break;
        }
        emit += s.slice(0, i);
        s = s.slice(i + markupOpen.length);
        this.inBlock = true;
        continue;
      }
      const k = s.indexOf(markupClose);
      if (k < 0) {
        if (s.length > markupMaxBlockBytes) {
          // 超长未闭合：不是标记，原文回吐并退出块态。
          emit += markupOpen + s;
          this.inBlock = false;
          break;
        }
        this.hold = s;
        break;
      }
      const inner = s.slice(0, k);
      s = s.slice(k + markupClose.length);
      this.inBlock = false;
      this.seen++;
      const got = parseMarkupBlock(inner, this.allowed);
      if (got) {
        calls.push(...got);
        this.converted += got.length;
        continue;
      }
      // 块内不是纯调用：原文回吐，绝不吞字节。
      this.rejected++;
      emit += markupOpen + inner + markupClose;
    }
    return { emit, calls };
  }

  // flush 在响应流结束时调用：把仍未判定的尾部缓冲原文交还；未闭合的块连同
  // 起始标记一起回吐——上游发了什么就透出什么。
  flush(): string {
    if (!this.enabled()) return "";
    let out = this.hold;
    if (this.inBlock) out = markupOpen + this.hold;
    this.hold = "";
    this.inBlock = false;
    return out;
  }
}

// markupStartCandidate 返回 s 中最早的「可能是 markupOpen 起点」的下标。
function markupStartCandidate(s: string): number {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "<") continue;
    const rest = s.slice(i);
    if (rest.length >= markupOpen.length) {
      if (rest.startsWith(markupOpen)) return i;
      continue;
    }
    if (markupOpen.startsWith(rest)) return i;
  }
  return -1;
}

// parseMarkupBlock 解析 calls 块内部。成功要求：块内除 invoke 与空白外没有别的字节；
// 每个 invoke 闭合；参数列表合法；工具名判定通过（严格名单或弱形态检查）。
function parseMarkupBlock(inner: string, allowed: Set<string>): MarkupCall[] | null {
  const strict = allowed.size > 0;
  const out: MarkupCall[] = [];
  let pos = 0;
  markupInvokeRe.lastIndex = 0;
  for (;;) {
    markupInvokeRe.lastIndex = 0;
    const re = new RegExp(markupInvokeRe.source);
    const loc = re.exec(inner.slice(pos));
    if (!loc) break;
    if (inner.slice(pos, pos + loc.index).trim() !== "") return null; // invoke 前夹带正文
    const name = loc[1];
    const bodyStart = pos + loc.index + loc[0].length;
    const end = inner.indexOf(markupInvokeClose, bodyStart);
    if (end < 0) return null; // invoke 未闭合
    const body = inner.slice(bodyStart, end);
    pos = end + markupInvokeClose.length;
    const args = parseMarkupParams(body);
    if (args === null) return null;
    if (strict) {
      if (!allowed.has(name)) return null; // 工具名不在名单 → 不认，原文透出
    } else if (!markupToolNameRe.test(name)) {
      return null; // 弱判定：名字不像工具名 → 不认
    }
    out.push({ name, arguments: args });
  }
  if (out.length === 0) return null;
  if (inner.slice(pos).trim() !== "") return null; // 最后一个 invoke 之后夹带正文
  return out;
}

// parseMarkupParams 解析一个 invoke 内部的 parameter 列表，产出 JSON 对象文本。
// string="true" 按原文字符串处理；其余先按 JSON 解析，失败退化为字符串——参数值
// 永远不丢。无参数 → "{}"。
function parseMarkupParams(body: string): string | null {
  const args: Obj = {};
  let pos = 0;
  for (;;) {
    const re = new RegExp(markupParamRe.source);
    const loc = re.exec(body.slice(pos));
    if (!loc) break;
    if (body.slice(pos, pos + loc.index).trim() !== "") return null;
    const name = loc[1];
    const isString = loc[2] === "true";
    const valStart = pos + loc.index + loc[0].length;
    const end = body.indexOf(markupParamClose, valStart);
    if (end < 0) return null;
    const raw = body.slice(valStart, end);
    pos = end + markupParamClose.length;
    if (isString) {
      args[name] = raw;
      continue;
    }
    try {
      args[name] = JSON.parse(raw.trim());
    } catch {
      args[name] = raw;
    }
  }
  if (body.slice(pos).trim() !== "") return null;
  try {
    return JSON.stringify(args);
  } catch {
    return null;
  }
}
// ToolNameAllowlist 从客户端请求体里收集「可用于判定工具调用」的工具名集合。
// 两个来源都要（二者会分别缺失）：
//   1. 本请求声明的工具：tools[].function.name、Responses 风格裸 tools[].name、
//      旧版 functions[].name；
//   2. 会话历史里出现过的工具：messages[].tool_calls[].function.name 与旧版
//      messages[].function_call.name。
// 两个来源都为空 → 返回 null（由调用方决定是否启用弱判定）。
export function toolNameAllowlist(body: string): Set<string> | null {
  let req: Obj;
  try {
    req = JSON.parse(body) as Obj;
  } catch {
    return null;
  }
  const names = new Set<string>();
  const addStr = (v: unknown) => {
    if (typeof v === "string" && v !== "") names.add(v);
  };
  if (Array.isArray(req["tools"])) {
    for (const t of req["tools"] as unknown[]) {
      if (!t || typeof t !== "object") continue;
      const tm = t as Obj;
      const fn = tm["function"];
      if (fn && typeof fn === "object") {
        addStr((fn as Obj)["name"]);
        continue;
      }
      addStr(tm["name"]);
    }
  }
  if (Array.isArray(req["functions"])) {
    for (const f of req["functions"] as unknown[]) {
      if (!f || typeof f !== "object") continue;
      addStr((f as Obj)["name"]);
    }
  }
  if (Array.isArray(req["messages"])) {
    for (const m of req["messages"] as unknown[]) {
      if (!m || typeof m !== "object") continue;
      const mm = m as Obj;
      if (Array.isArray(mm["tool_calls"])) {
        for (const tc of mm["tool_calls"] as unknown[]) {
          if (!tc || typeof tc !== "object") continue;
          const fn = (tc as Obj)["function"];
          if (fn && typeof fn === "object") addStr((fn as Obj)["name"]);
        }
      }
      const fc = mm["function_call"];
      if (fc && typeof fc === "object") addStr((fc as Obj)["name"]);
    }
  }
  return names.size > 0 ? names : null;
}

// markupMessageToolCalls 把还原出来的调用转成**非流式** message.tool_calls 数组
// （非流式形态不带 index——index 是流式 delta 的分片归属标记）。
export function markupMessageToolCalls(calls: MarkupCall[]): Obj[] {
  return calls.map((call, i) => ({
    id: markupCallID(i),
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }));
}

// markupToolCalls 把还原出来的调用转成**流式** delta.tool_calls 数组。
// base 是首个 index（流式路径用它避开上游已用过的 index）。index 为 number
// （JS 无 int/float 之分，JSON 序列化等价 Go 的 float64）。
export function markupToolCalls(calls: MarkupCall[], base: number): Obj[] {
  return calls.map((call, i) => ({
    index: base + i,
    id: markupCallID(base + i),
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }));
}

// markupCallID 生成形态接近 OpenAI 的 tool_call id；序号参与其中，保证同一条
// 响应里多个调用的 id 互不相同。
let markupCallSeq = 0;
function markupCallID(idx: number): string {
  markupCallSeq = (markupCallSeq + 1) & 0xffff;
  return `call_${Date.now()}_${process.hrtime.bigint() % 1000000n}_${markupCallSeq}_${idx}`;
}

// repairAggregatedResponse 在非流式聚合响应里把正文中的标记还原为 tool_calls。
// 只在「该 choice 没有结构化 tool_calls」且「finish_reason 为 stop」时生效
// （前者保证不覆盖真实调用，后者保证正文没有被 max_tokens 截断）。
export function repairAggregatedResponse(
  resp: Obj,
  allowed: Set<string> | null,
  allowUnknown: boolean,
): MarkupRepair {
  const r = new MarkupRepair(allowed, allowUnknown);
  if (!r.enabled()) return r;
  const choices = resp["choices"];
  if (!Array.isArray(choices)) return r;
  for (const ci of choices) {
    if (!ci || typeof ci !== "object") continue;
    const c = ci as Obj;
    const msg = c["message"];
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Obj;
    const tcs = m["tool_calls"];
    if (Array.isArray(tcs) && tcs.length > 0) continue;
    if (c["finish_reason"] !== "stop") continue;
    const text = m["content"];
    if (typeof text !== "string" || text === "" || !text.includes(markupPipe)) continue;
    const { emit, calls } = r.feed(text);
    const tail = r.flush();
    if (calls.length === 0) continue;
    m["content"] = emit + tail;
    m["tool_calls"] = markupMessageToolCalls(calls);
    c["finish_reason"] = "tool_calls";
  }
  return r;
}
