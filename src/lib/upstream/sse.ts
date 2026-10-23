// SSE 处理（移植 internal/upstream/sse.go 的核心）：
//  - streamPassthrough：逐帧规范化透传（白名单重建 + error 帧观察 + [DONE] 兜底）
//  - aggregate：把 SSE 流聚合成单个非流式响应（tool_calls 分片合并）

import { MarkupRepair, markupToolCalls } from "./dsml";
import { normalizeUsage, usageCacheHitTokens, usageCacheMissTokens } from "./usage";

export interface StreamStats {
  validFrames: number;
  errorFrame: string; // 上游 error 帧原文（空 = 无）
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  hasUsage: boolean;
  credit: number;
  hasCredit: boolean;
  ttfbMs: number; // 首帧延迟（0 = 无观测）
  cacheHitTokens: number; // 前缀缓存命中（0 = 无观测）
  cacheMissTokens: number;
  hasCache: boolean;
}

type Obj = Record<string, unknown>;

// normalizeFrame 以 OpenAI 流式规范白名单重建帧：剔除上游噪声（空 content/refusal、
// 空 tool_calls 列表、空占位 function_call、顶层未知字段），usage 缺失 → null。
export function normalizeFrame(obj: Obj): Obj {
  const out: Obj = {};
  for (const k of ["id", "object", "created", "model", "system_fingerprint", "service_tier"]) {
    const v = obj[k];
    if (v !== undefined && v !== null) out[k] = v;
  }
  if (!out["object"]) out["object"] = "chat.completion.chunk";
  if (!out["id"]) out["id"] = "chatcmpl-wb2api";
  const chs = obj["choices"];
  if (Array.isArray(chs)) {
    const nchs: Obj[] = [];
    for (const ci of chs) {
      if (!ci || typeof ci !== "object") continue;
      const c = ci as Obj;
      const nc: Obj = {};
      if ("index" in c) nc["index"] = c["index"];
      const delta: Obj = {};
      const d = c["delta"];
      if (d && typeof d === "object") {
        const dm = d as Obj;
        for (const k of ["role", "content", "reasoning_content", "refusal"]) {
          const v = dm[k];
          if (typeof v === "string" && v !== "") delta[k] = v;
        }
        const tcs = dm["tool_calls"];
        if (Array.isArray(tcs) && tcs.length > 0) delta["tool_calls"] = tcs;
        const fc = dm["function_call"];
        if (fc && typeof fc === "object") {
          const fcm = fc as Obj;
          if (fcm["name"] || fcm["arguments"]) delta["function_call"] = fc;
        } else if (fc) {
          delta["function_call"] = fc;
        }
      }
      nc["delta"] = delta;
      const fr = c["finish_reason"];
      nc["finish_reason"] = typeof fr === "string" && fr !== "" ? fr : null;
      nchs.push(nc);
    }
    out["choices"] = nchs;
  }
  const rawUsage = obj["usage"];
  out["usage"] =
    rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)
      ? normalizeUsage(rawUsage as Obj)
      : rawUsage ?? null;
  return out;
}

function usageFromFrame(obj: Obj): Obj | null {
  const u = obj["usage"];
  return u && typeof u === "object" ? (u as Obj) : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function readUsageInto(stats: StreamStats, u: Obj): void {
  stats.promptTokens = num(u["prompt_tokens"]);
  stats.completionTokens = num(u["completion_tokens"]);
  stats.totalTokens = num(u["total_tokens"]) || stats.promptTokens + stats.completionTokens;
  stats.hasUsage = true;
  const c = u["credit"] ?? u["credits"];
  if (typeof c === "number" && c > 0) {
    stats.credit = c;
    stats.hasCredit = true;
  }
  // 缓存命中观测（Go logging.go:220 同口径）：命中读多别名最优；miss 缺失时
  // 按 prompt-hit 推导（推导工具函数与客户端回写共用同一口径）。
  const hit = usageCacheHitTokens(u);
  if (hit !== null) {
    stats.hasCache = true;
    stats.cacheHitTokens = hit;
    const miss = usageCacheMissTokens(u) ?? 0;
    stats.cacheMissTokens = miss;
  }
}


// ─── 标记修复（dsml.go）的流式帧改写助手 ─────────────────────────────────────

// takeFinishReason 取出并删除所有 choice 的 finish_reason，返回第一个非空值。
function takeFinishReason(obj: Obj): string {
  let fr = "";
  const chs = obj["choices"];
  if (!Array.isArray(chs)) return fr;
  for (const ci of chs) {
    if (!ci || typeof ci !== "object") continue;
    const c = ci as Obj;
    const v = c["finish_reason"];
    if (typeof v === "string" && v !== "" && fr === "") fr = v;
    delete c["finish_reason"];
  }
  return fr;
}

// rewriteFinishReason 把 choice 上「已有且为 stop」的 finish_reason 改写成 want。
// 本来就没有 finish_reason 的中间帧一律不动；已有其他值（length/content_filter）
// 也不动。返回是否发生了改写。
function rewriteFinishReason(obj: Obj, want: string): boolean {
  let changed = false;
  const chs = obj["choices"];
  if (!Array.isArray(chs)) return false;
  for (const ci of chs) {
    if (!ci || typeof ci !== "object") continue;
    const c = ci as Obj;
    if (c["finish_reason"] === "stop") {
      c["finish_reason"] = want;
      changed = true;
    }
  }
  return changed;
}

// markupCallFrame 以 src 帧为模板构造一帧只带单个 delta.tool_calls 的 chunk。
function markupCallFrame(src: Obj, idx: number, call: { name: string; arguments: string }): Obj {
  const frame: Obj = {
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { tool_calls: markupToolCalls([call], idx) } }],
  };
  for (const k of ["created", "model"]) {
    const v = src[k];
    if (v !== undefined && v !== null) frame[k] = v;
  }
  return frame;
}

// finishOnlyFrame 构造一帧只带 finish_reason 的收尾 chunk（空 delta）。
function finishOnlyFrame(src: Obj, finish: string): Obj {
  const frame: Obj = {
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: {}, finish_reason: finish }],
  };
  for (const k of ["created", "model"]) {
    const v = src[k];
    if (v !== undefined && v !== null) frame[k] = v;
  }
  return frame;
}
// streamPassthrough 透传上游 SSE（逐帧规范化）。返回 stats；写失败抛错（客户端断连）。
export async function streamPassthrough(
  upstream: ReadableStream<Uint8Array>,
  out: WritableStream<Uint8Array>,
  repair?: MarkupRepair | null,
  hintFn?: (payload: string) => string,
  started = Date.now(),
): Promise<StreamStats> {
  const stats: StreamStats = {
    validFrames: 0, errorFrame: "",
    promptTokens: 0, completionTokens: 0, totalTokens: 0, hasUsage: false,
    credit: 0, hasCredit: false, ttfbMs: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, hasCache: false,
  };
  const reader = upstream.getReader();
  const writer = out.getWriter();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  // 标记修复跨帧状态（见 dsml.go / Go StreamHint）：
  //   synthIdx 本流已还原的调用数（合成 index 从上游最大 index 之后接续）；
  //   maxToolIdx 上游已用过的最大 tool_call index（避免合成 index 撞车）；
  //   toolFinishSent 是否已发出过 finish_reason: tool_calls（流尾兜底用）。
  const repairOn = repair != null && repair.enabled();
  let synthIdx = 0;
  let maxToolIdx = -1;
  let toolFinishSent = false;

  // repairFrame 在透传前跑标记修复，把一帧展开成「可能多帧」：正文帧 + N 个
  // delta.tool_calls 帧 + 收尾 finish_reason 帧。没有命中标记时原样返回入参帧。
  const repairFrame = (obj: Obj): Obj[] => {
    if (!repairOn) return [obj];
    const chs = obj["choices"];
    if (!Array.isArray(chs)) return [obj];
    const calls: { name: string; arguments: string }[] = [];
    for (const ci of chs) {
      if (!ci || typeof ci !== "object") continue;
      const c = ci as Obj;
      const d = c["delta"];
      if (!d || typeof d !== "object") continue;
      const dm = d as Obj;
      const txt = dm["content"];
      if (typeof txt !== "string" || txt === "") continue;
      const { emit, calls: got } = repair!.feed(txt);
      calls.push(...got);
      if (emit === "") {
        delete dm["content"];
      } else {
        dm["content"] = emit;
      }
    }
    if (calls.length === 0) {
      // 本帧没命中标记；但本流此前还原过调用 → 把上游的 stop 收尾改写成 tool_calls。
      if (synthIdx > 0 && rewriteFinishReason(obj, "tool_calls")) {
        toolFinishSent = true;
      }
      return [obj];
    }
    // 命中：finish_reason 必须挪到工具调用帧之后（客户端读到调用前不得认为回合
    // 已结束）；本帧本来没有 finish_reason 时不得补收尾（上游收尾帧随后就到）。
    const fr = takeFinishReason(obj);
    const out: Obj[] = [obj];
    for (const call of calls) {
      const idx = maxToolIdx + 1 + synthIdx;
      synthIdx++;
      out.push(markupCallFrame(obj, idx, call));
    }
    if (fr !== "") {
      const fr2 = fr === "stop" ? "tool_calls" : fr;
      out.push(finishOnlyFrame(obj, fr2));
      toolFinishSent = fr2 === "tool_calls";
    }
    return out;
  };

  // noteToolIdx 维护上游已用过的最大 tool_call index（修复合成帧接续编号用）。
  const noteToolIdx = (obj: Obj) => {
    const chs = obj["choices"];
    if (!Array.isArray(chs)) return;
    for (const ci of chs) {
      if (!ci || typeof ci !== "object") continue;
      const d = (ci as Obj)["delta"];
      if (!d || typeof d !== "object") continue;
      const tcs = (d as Obj)["tool_calls"];
      if (!Array.isArray(tcs)) continue;
      for (const tci of tcs) {
        if (!tci || typeof tci !== "object") continue;
        const v = (tci as Obj)["index"];
        if (typeof v === "number" && v > maxToolIdx) maxToolIdx = v;
      }
    }
  };
  const write = async (payload: string) => {
    await writer.write(enc.encode("data: " + payload + "\n\n"));
  };
  try {
    let doneSeen = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.startsWith("data: [DONE]")) {
          doneSeen = true;
          break;
        }
        if (line.startsWith("data: ")) {
          const payload = line.slice(6);
          let obj: Obj | null = null;
          try {
            obj = JSON.parse(payload) as Obj;
          } catch {
            obj = null;
          }
          if (obj && obj["error"]) {
            if (stats.validFrames === 0) stats.ttfbMs = Math.max(1, Date.now() - started);
            // error 帧：原样透传 + 旁路采集（供账号处置分类）；gateway_hint 附加
            // 网关视角补充说明（hintFn 惰性求值——仅 error 帧才调用，正常流零开销）。
            stats.errorFrame = payload;
            if (hintFn) {
              const hint = hintFn(payload);
              if (hint) {
                const eo = { ...obj };
                const eobj = { ...(obj["error"] as Obj), gateway_hint: hint };
                eo["error"] = eobj;
                await write(JSON.stringify(eo));
                stats.validFrames++;
                continue;
              }
            }
            await write(payload);
            stats.validFrames++;
            continue;
          }
          if (obj) {
            if (stats.validFrames === 0) stats.ttfbMs = Math.max(1, Date.now() - started);
            const u = usageFromFrame(obj);
            if (u) readUsageInto(stats, u);
            noteToolIdx(obj);
            for (const fr of repairFrame(obj)) {
              await write(JSON.stringify(normalizeFrame(fr)));
            }
            stats.validFrames++;
            continue;
          }
          // 非 JSON 帧：原样透传（防御）。
          await write(payload);
          continue;
        }
        if (line !== "") {
          // 注释/其他行原样透传。
          await writer.write(enc.encode(line + "\n"));
        }
      }
      if (doneSeen) break;
    }
    // 标记修复的尾部收尾：流结束时仍未判定的字节一律原文回吐（绝不吞字节，
    // 未闭合的块连起始标记一起交还）；若本流还原过调用、但上游从未给出收尾帧，
    // 补一帧 finish_reason: tool_calls，保证客户端不会把「工具调用回合」读成
    // 「模型只说了话」。
    if (repairOn) {
      const tail = repair!.flush();
      if (tail !== "") {
        const tailObj: Obj = {
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: tail } }],
        };
        await write(JSON.stringify(normalizeFrame(tailObj)));
        stats.validFrames++;
      }
      if (synthIdx > 0 && !toolFinishSent) {
        await write(JSON.stringify(normalizeFrame(finishOnlyFrame({}, "tool_calls"))));
      }
    }
    // 空流兜底：先写 error 帧再补 [DONE]（HTTP 头已发只能 200）。
    if (stats.validFrames === 0) {
      stats.errorFrame = '{"error":{"code":"upstream_parse"}}';
      await write('{"error":{"message":"empty upstream stream","type":"upstream_error","code":"upstream_parse"}}');
    }
    await writer.write(enc.encode("data: [DONE]\n\n"));
  } finally {
    // 关闭 writable 让下游读到 done（releaseLock 不关流，下游会一直挂起）。
    // 客户端断连时 close 抛错，吞掉即可。
    try {
      await writer.close();
    } catch {
      // 忽略。
    }
    try {
      writer.releaseLock();
    } catch {
      // 忽略：writer 可能已因断连关闭。
    }
    reader.cancel().catch(() => undefined);
  }
  return stats;
}

// ─── 非流式聚合 ─────────────────────────────────────────────────────────────

// ─── 工具调用残缺参数丢弃（移植 internal/upstream/truncation.go） ────────────
// SSE 流被截断（连接中断 / finish_reason==length）时，工具调用的 arguments 会只剩
// 半截 JSON。把脏参数原样交给客户端会被解析成非法 JSON 卡死会话——丢弃残缺调用，
// 而非补成 {} 伪造合法外观。

// isTruncatedArguments 判定工具参数字符串是否因分片丢失而残缺（区别于「该工具
// 本就无参数」）：空串/纯空白 → false（合法无参工具）；非空但 JSON 解析失败 →
// true（截断）；能解析（含 null/标量/数组等任何合法 JSON）→ false。
export function isTruncatedArguments(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (trimmed === "") return false;
  try {
    JSON.parse(trimmed);
    return false;
  } catch {
    return true;
  }
}

// dropTruncatedToolCalls 过滤出 arguments 完整的 tool_call（返回新数组）。
// 只依据 isTruncatedArguments 判定，不改动任何保留的调用（正例零改动）。
export function dropTruncatedToolCalls(calls: Obj[]): Obj[] {
  return calls.filter((call) => {
    const fn = call["function"];
    if (!fn || typeof fn !== "object") return true;
    return !isTruncatedArguments((fn as Obj)["arguments"]);
  });
}

function mergeToolCallDelta(merged: Obj, delta: Obj): void {
  for (const k of ["id", "type"]) {
    const v = delta[k];
    if (typeof v === "string" && v !== "") merged[k] = v;
  }
  const df = delta["function"];
  if (df && typeof df === "object") {
    let mf = merged["function"] as Obj | undefined;
    if (!mf || typeof mf !== "object") {
      mf = {};
      merged["function"] = mf;
    }
    const dfn = (df as Obj)["name"];
    if (typeof dfn === "string" && dfn !== "" && !mf["name"]) mf["name"] = dfn;
    const dfa = (df as Obj)["arguments"];
    if (typeof dfa === "string" && dfa !== "") {
      mf["arguments"] = String(mf["arguments"] ?? "") + dfa;
    }
  }
}

// aggregate 把 SSE 流聚合为单个 chat.completion 响应（Go Aggregate 同语义）。
export async function aggregate(upstream: ReadableStream<Uint8Array>): Promise<{ resp: Obj; stats: StreamStats }> {
  const stats: StreamStats = {
    validFrames: 0, errorFrame: "",
    promptTokens: 0, completionTokens: 0, totalTokens: 0, hasUsage: false,
    credit: 0, hasCredit: false, ttfbMs: 0,
    cacheHitTokens: 0, cacheMissTokens: 0, hasCache: false,
  };
  const reader = upstream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: Obj = {};
  let content = "";
  let reasoning = "";
  let role = "";
  let finishReason = "";
  let sawDone = false;
  const toolCalls: Obj[] = [];
  let usageObj: Obj | null = null; // 上游 usage 原对象（出口保留原字段 + 补 total + 归一别名）

  const mergeChunk = (obj: Obj) => {
    for (const k of ["id", "object", "created", "model", "system_fingerprint", "service_tier"]) {
      const v = obj[k];
      if (v !== undefined && v !== null) out[k] = v;
    }
    const chs = obj["choices"];
    if (Array.isArray(chs)) {
      for (const ci of chs) {
        if (!ci || typeof ci !== "object") continue;
        const c = ci as Obj;
        const d = c["delta"];
        if (d && typeof d === "object") {
          const dm = d as Obj;
          if (typeof dm["role"] === "string" && dm["role"]) role = dm["role"] as string;
          if (typeof dm["content"] === "string") content += dm["content"];
          if (typeof dm["reasoning_content"] === "string") reasoning += dm["reasoning_content"];
          const tcs = dm["tool_calls"];
          if (Array.isArray(tcs)) {
            for (const tc of tcs) {
              if (!tc || typeof tc !== "object") continue;
              const t = tc as Obj;
              const idx = num(t["index"]);
              while (toolCalls.length <= idx) toolCalls.push({});
              mergeToolCallDelta(toolCalls[idx], t);
            }
          }
        }
        const fr = c["finish_reason"];
        if (typeof fr === "string" && fr !== "") finishReason = fr;
      }
    }
    const u = usageFromFrame(obj);
    if (u) readUsageInto(stats, u);
    if (u) usageObj = u;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data: [DONE]")) {
        sawDone = true;
        break;
      }
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      let obj: Obj;
      try {
        obj = JSON.parse(payload) as Obj;
      } catch {
        continue;
      }
      if (obj["error"]) {
        stats.errorFrame = payload;
        continue;
      }
      stats.validFrames++;
      mergeChunk(obj);
    }
  }
  if (stats.validFrames === 0) {
    throw new Error(stats.errorFrame ? "upstream error frame: " + stats.errorFrame.slice(0, 200) : "empty upstream stream");
  }
  if (stats.errorFrame) {
    throw new Error("upstream error frame: " + stats.errorFrame.slice(0, 200));
  }
  // 截断丢弃（对齐 Go sse.go：finish_reason==length 或未见 [DONE] 说明流被掐断，
  // 此时末尾 tool_call 的 arguments 很可能残缺，直接丢弃防止客户端执行半残调用）。
  let finalToolCalls = toolCalls;
  if (toolCalls.length > 0 && (finishReason === "length" || !sawDone)) {
    finalToolCalls = dropTruncatedToolCalls(toolCalls);
  }
  const message: Obj = { role: role || "assistant", content };
  if (reasoning) message["reasoning_content"] = reasoning;
  if (finalToolCalls.length > 0) message["tool_calls"] = finalToolCalls;
  out["object"] = "chat.completion";
  out["choices"] = [{ index: 0, message, finish_reason: finishReason || "stop" }];
  out["usage"] = usageObj ? normalizeUsage(usageObj) : null;
  return { resp: out, stats };
}
