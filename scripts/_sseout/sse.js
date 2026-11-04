"use strict";
// SSE 处理（移植 internal/upstream/sse.go 的核心）：
//  - streamPassthrough：逐帧规范化透传（白名单重建 + error 帧观察 + [DONE] 兜底）
//  - aggregate：把 SSE 流聚合成单个非流式响应（tool_calls 分片合并）
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamPassthroughError = void 0;
exports.normalizeFrame = normalizeFrame;
exports.streamPassthrough = streamPassthrough;
exports.isTruncatedArguments = isTruncatedArguments;
exports.dropTruncatedToolCalls = dropTruncatedToolCalls;
exports.aggregate = aggregate;
const dsml_1 = require("./dsml");
const usage_1 = require("./usage");
class StreamPassthroughError extends Error {
    constructor(cause, stats) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.name = cause instanceof Error ? cause.name : "StreamPassthroughError";
        this.stats = stats;
    }
}
exports.StreamPassthroughError = StreamPassthroughError;
// normalizeFrame 以 OpenAI 流式规范白名单重建帧：剔除上游噪声（空 content/refusal、
// 空 tool_calls 列表、空占位 function_call、顶层未知字段），usage 缺失 → null。
function normalizeFrame(obj) {
    const out = {};
    for (const k of ["id", "object", "created", "model", "system_fingerprint", "service_tier"]) {
        const v = obj[k];
        if (v !== undefined && v !== null)
            out[k] = v;
    }
    if (!out["object"])
        out["object"] = "chat.completion.chunk";
    if (!out["id"])
        out["id"] = "chatcmpl-wb2api";
    const chs = obj["choices"];
    if (Array.isArray(chs)) {
        const nchs = [];
        for (const ci of chs) {
            if (!ci || typeof ci !== "object")
                continue;
            const c = ci;
            const nc = {};
            if ("index" in c)
                nc["index"] = c["index"];
            const delta = {};
            const d = c["delta"];
            if (d && typeof d === "object") {
                const dm = d;
                // 思维链别名归一：部分上游只发 delta.reasoning / delta.thinking，
                // 直接丢弃会让 Codex 等客户端看不到思维链——统一回填 reasoning_content。
                if ((dm["reasoning_content"] === undefined || dm["reasoning_content"] === null) &&
                    typeof dm["reasoning"] === "string" && dm["reasoning"] !== "") {
                    dm["reasoning_content"] = dm["reasoning"];
                }
                if ((dm["reasoning_content"] === undefined || dm["reasoning_content"] === null) &&
                    typeof dm["thinking"] === "string" && dm["thinking"] !== "") {
                    dm["reasoning_content"] = dm["thinking"];
                }
                for (const k of ["role", "content", "reasoning_content", "reasoning", "thinking", "refusal"]) {
                    const v = dm[k];
                    if (typeof v === "string" && v !== "")
                        delta[k] = v;
                }
                const tcs = dm["tool_calls"];
                if (Array.isArray(tcs) && tcs.length > 0)
                    delta["tool_calls"] = tcs;
                const fc = dm["function_call"];
                if (fc && typeof fc === "object") {
                    const fcm = fc;
                    if (fcm["name"] || fcm["arguments"])
                        delta["function_call"] = fc;
                }
                else if (fc) {
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
            ? (0, usage_1.normalizeUsage)(rawUsage)
            : rawUsage ?? null;
    return out;
}
function usageFromFrame(obj) {
    const u = obj["usage"];
    return u && typeof u === "object" ? u : null;
}
function num(v) {
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
}
function readUsageInto(stats, u) {
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
    const hit = (0, usage_1.usageCacheHitTokens)(u);
    if (hit !== null) {
        stats.hasCache = true;
        stats.cacheHitTokens = hit;
        const miss = (0, usage_1.usageCacheMissTokens)(u) ?? 0;
        stats.cacheMissTokens = miss;
    }
}
function mergeObservedToolCall(merged, delta) {
    for (const k of ["id", "type"]) {
        const v = delta[k];
        if (typeof v === "string" && v !== "" && !merged[k])
            merged[k] = v;
    }
    const df = delta["function"];
    if (!df || typeof df !== "object")
        return;
    let mf = merged["function"];
    if (!mf || typeof mf !== "object") {
        mf = {};
        merged["function"] = mf;
    }
    const name = df["name"];
    if (typeof name === "string" && name !== "" && !mf["name"])
        mf["name"] = name;
    const args = df["arguments"];
    if (typeof args === "string" && args !== "") {
        mf["arguments"] = String(mf["arguments"] ?? "") + args;
    }
}
function observeAssistantFrame(stats, obj) {
    const choices = obj["choices"];
    if (!Array.isArray(choices))
        return;
    for (const choice of choices) {
        if (!choice || typeof choice !== "object")
            continue;
        const item = choice;
        const delta = item["delta"];
        if (delta && typeof delta === "object") {
            const d = delta;
            if (typeof d["role"] === "string" && d["role"])
                stats.assistantRole = d["role"];
            if (typeof d["content"] === "string")
                stats.assistantContent += d["content"];
            // 思维链别名旁路采集：reasoning_content 优先，缺失时收 reasoning / thinking。
            const rc = (typeof d["reasoning_content"] === "string" && d["reasoning_content"]) ||
                (typeof d["reasoning"] === "string" && d["reasoning"]) ||
                (typeof d["thinking"] === "string" && d["thinking"]) ||
                "";
            if (rc)
                stats.assistantReasoning += rc;
            const toolCalls = d["tool_calls"];
            if (Array.isArray(toolCalls)) {
                for (const call of toolCalls) {
                    if (!call || typeof call !== "object")
                        continue;
                    const tc = call;
                    const idx = num(tc["index"]);
                    while (stats.assistantToolCalls.length <= idx)
                        stats.assistantToolCalls.push({});
                    mergeObservedToolCall(stats.assistantToolCalls[idx], tc);
                }
            }
        }
        const finish = item["finish_reason"];
        if (typeof finish === "string" && finish)
            stats.finishReason = finish;
    }
}
// ─── 标记修复（dsml.go）的流式帧改写助手 ─────────────────────────────────────
// takeFinishReason 取出并删除所有 choice 的 finish_reason，返回第一个非空值。
function takeFinishReason(obj) {
    let fr = "";
    const chs = obj["choices"];
    if (!Array.isArray(chs))
        return fr;
    for (const ci of chs) {
        if (!ci || typeof ci !== "object")
            continue;
        const c = ci;
        const v = c["finish_reason"];
        if (typeof v === "string" && v !== "" && fr === "")
            fr = v;
        delete c["finish_reason"];
    }
    return fr;
}
// rewriteFinishReason 把 choice 上「已有且为 stop」的 finish_reason 改写成 want。
// 本来就没有 finish_reason 的中间帧一律不动；已有其他值（length/content_filter）
// 也不动。返回是否发生了改写。
function rewriteFinishReason(obj, want) {
    let changed = false;
    const chs = obj["choices"];
    if (!Array.isArray(chs))
        return false;
    for (const ci of chs) {
        if (!ci || typeof ci !== "object")
            continue;
        const c = ci;
        if (c["finish_reason"] === "stop") {
            c["finish_reason"] = want;
            changed = true;
        }
    }
    return changed;
}
// markupCallFrame 以 src 帧为模板构造一帧只带单个 delta.tool_calls 的 chunk。
function markupCallFrame(src, idx, call) {
    const frame = {
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { tool_calls: (0, dsml_1.markupToolCalls)([call], idx) } }],
    };
    for (const k of ["created", "model"]) {
        const v = src[k];
        if (v !== undefined && v !== null)
            frame[k] = v;
    }
    return frame;
}
// finishOnlyFrame 构造一帧只带 finish_reason 的收尾 chunk（空 delta）。
function finishOnlyFrame(src, finish) {
    const frame = {
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
    };
    for (const k of ["created", "model"]) {
        const v = src[k];
        if (v !== undefined && v !== null)
            frame[k] = v;
    }
    return frame;
}
// streamPassthrough 透传上游 SSE（逐帧规范化）。返回 stats；写失败抛错（客户端断连）。
async function streamPassthrough(upstream, out, repair, hintFn, started = Date.now()) {
    const stats = {
        validFrames: 0, errorFrame: "",
        assistantRole: "", assistantContent: "", assistantReasoning: "",
        assistantToolCalls: [], finishReason: "",
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
    const repairFrame = (obj) => {
        if (!repairOn)
            return [obj];
        const chs = obj["choices"];
        if (!Array.isArray(chs))
            return [obj];
        const calls = [];
        for (const ci of chs) {
            if (!ci || typeof ci !== "object")
                continue;
            const c = ci;
            const d = c["delta"];
            if (!d || typeof d !== "object")
                continue;
            const dm = d;
            const txt = dm["content"];
            if (typeof txt !== "string" || txt === "")
                continue;
            const { emit, calls: got } = repair.feed(txt);
            calls.push(...got);
            if (emit === "") {
                delete dm["content"];
            }
            else {
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
        const out = [obj];
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
    const noteToolIdx = (obj) => {
        const chs = obj["choices"];
        if (!Array.isArray(chs))
            return;
        for (const ci of chs) {
            if (!ci || typeof ci !== "object")
                continue;
            const d = ci["delta"];
            if (!d || typeof d !== "object")
                continue;
            const tcs = d["tool_calls"];
            if (!Array.isArray(tcs))
                continue;
            for (const tci of tcs) {
                if (!tci || typeof tci !== "object")
                    continue;
                const v = tci["index"];
                if (typeof v === "number" && v > maxToolIdx)
                    maxToolIdx = v;
            }
        }
    };
    const write = async (payload) => {
        await writer.write(enc.encode("data: " + payload + "\n\n"));
    };
    try {
        let doneSeen = false;
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
                const line = buf.slice(0, idx).replace(/\r$/, "");
                buf = buf.slice(idx + 1);
                if (line.startsWith("data: [DONE]")) {
                    doneSeen = true;
                    break;
                }
                if (line.startsWith("data: ")) {
                    const payload = line.slice(6);
                    let obj = null;
                    try {
                        obj = JSON.parse(payload);
                    }
                    catch {
                        obj = null;
                    }
                    if (obj && obj["error"]) {
                        if (stats.validFrames === 0)
                            stats.ttfbMs = Math.max(1, Date.now() - started);
                        // error 帧：原样透传 + 旁路采集（供账号处置分类）；gateway_hint 附加
                        // 网关视角补充说明（hintFn 惰性求值——仅 error 帧才调用，正常流零开销）。
                        stats.errorFrame = payload;
                        if (hintFn) {
                            const hint = hintFn(payload);
                            if (hint) {
                                const eo = { ...obj };
                                const eobj = { ...obj["error"], gateway_hint: hint };
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
                        if (stats.validFrames === 0)
                            stats.ttfbMs = Math.max(1, Date.now() - started);
                        const u = usageFromFrame(obj);
                        if (u)
                            readUsageInto(stats, u);
                        noteToolIdx(obj);
                        for (const fr of repairFrame(obj)) {
                            const normalized = normalizeFrame(fr);
                            observeAssistantFrame(stats, normalized);
                            await write(JSON.stringify(normalized));
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
            if (doneSeen)
                break;
        }
        // 标记修复的尾部收尾：流结束时仍未判定的字节一律原文回吐（绝不吞字节，
        // 未闭合的块连起始标记一起交还）；若本流还原过调用、但上游从未给出收尾帧，
        // 补一帧 finish_reason: tool_calls，保证客户端不会把「工具调用回合」读成
        // 「模型只说了话」。
        if (repairOn) {
            const tail = repair.flush();
            if (tail !== "") {
                const tailObj = {
                    object: "chat.completion.chunk",
                    choices: [{ index: 0, delta: { content: tail } }],
                };
                const normalized = normalizeFrame(tailObj);
                observeAssistantFrame(stats, normalized);
                await write(JSON.stringify(normalized));
                stats.validFrames++;
            }
            if (synthIdx > 0 && !toolFinishSent) {
                const normalized = normalizeFrame(finishOnlyFrame({}, "tool_calls"));
                observeAssistantFrame(stats, normalized);
                await write(JSON.stringify(normalized));
            }
        }
        // 空流兜底：先写 error 帧再补 [DONE]（HTTP 头已发只能 200）。
        if (stats.validFrames === 0) {
            stats.errorFrame = '{"error":{"code":"upstream_parse"}}';
            await write('{"error":{"message":"empty upstream stream","type":"upstream_error","code":"upstream_parse"}}');
        }
        await writer.write(enc.encode("data: [DONE]\n\n"));
    }
    catch (e) {
        throw new StreamPassthroughError(e, stats);
    }
    finally {
        // 关闭 writable 让下游读到 done（releaseLock 不关流，下游会一直挂起）。
        // 客户端断连时 close 抛错，吞掉即可。
        try {
            await writer.close();
        }
        catch {
            // 忽略。
        }
        try {
            writer.releaseLock();
        }
        catch {
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
function isTruncatedArguments(raw) {
    if (typeof raw !== "string")
        return false;
    const trimmed = raw.trim();
    if (trimmed === "")
        return false;
    try {
        JSON.parse(trimmed);
        return false;
    }
    catch {
        return true;
    }
}
// dropTruncatedToolCalls 过滤出 arguments 完整的 tool_call（返回新数组）。
// 只依据 isTruncatedArguments 判定，不改动任何保留的调用（正例零改动）。
function dropTruncatedToolCalls(calls) {
    return calls.filter((call) => {
        const fn = call["function"];
        if (!fn || typeof fn !== "object")
            return true;
        return !isTruncatedArguments(fn["arguments"]);
    });
}
function mergeToolCallDelta(merged, delta) {
    for (const k of ["id", "type"]) {
        const v = delta[k];
        if (typeof v === "string" && v !== "")
            merged[k] = v;
    }
    const df = delta["function"];
    if (df && typeof df === "object") {
        let mf = merged["function"];
        if (!mf || typeof mf !== "object") {
            mf = {};
            merged["function"] = mf;
        }
        const dfn = df["name"];
        if (typeof dfn === "string" && dfn !== "" && !mf["name"])
            mf["name"] = dfn;
        const dfa = df["arguments"];
        if (typeof dfa === "string" && dfa !== "") {
            mf["arguments"] = String(mf["arguments"] ?? "") + dfa;
        }
    }
}
// aggregate 把 SSE 流聚合为单个 chat.completion 响应（Go Aggregate 同语义）。
async function aggregate(upstream) {
    const stats = {
        validFrames: 0, errorFrame: "",
        assistantRole: "", assistantContent: "", assistantReasoning: "",
        assistantToolCalls: [], finishReason: "",
        promptTokens: 0, completionTokens: 0, totalTokens: 0, hasUsage: false,
        credit: 0, hasCredit: false, ttfbMs: 0,
        cacheHitTokens: 0, cacheMissTokens: 0, hasCache: false,
    };
    const reader = upstream.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const out = {};
    let content = "";
    let reasoning = "";
    let role = "";
    let finishReason = "";
    let sawDone = false;
    const toolCalls = [];
    let usageObj = null; // 上游 usage 原对象（出口保留原字段 + 补 total + 归一别名）
    const mergeChunk = (obj) => {
        for (const k of ["id", "object", "created", "model", "system_fingerprint", "service_tier"]) {
            const v = obj[k];
            if (v !== undefined && v !== null)
                out[k] = v;
        }
        const chs = obj["choices"];
        if (Array.isArray(chs)) {
            for (const ci of chs) {
                if (!ci || typeof ci !== "object")
                    continue;
                const c = ci;
                const d = c["delta"];
                if (d && typeof d === "object") {
                    const dm = d;
                    if (typeof dm["role"] === "string" && dm["role"])
                        role = dm["role"];
                    if (typeof dm["content"] === "string")
                        content += dm["content"];
                    // 思维链别名归一：reasoning_content / reasoning / thinking 全部计入聚合，
                    // 出口 message.reasoning_content 必有完整思维链，非流式客户端可见。
                    if (typeof dm["reasoning_content"] === "string")
                        reasoning += dm["reasoning_content"];
                    else if (typeof dm["reasoning"] === "string")
                        reasoning += dm["reasoning"];
                    else if (typeof dm["thinking"] === "string")
                        reasoning += dm["thinking"];
                    const tcs = dm["tool_calls"];
                    if (Array.isArray(tcs)) {
                        for (const tc of tcs) {
                            if (!tc || typeof tc !== "object")
                                continue;
                            const t = tc;
                            const idx = num(t["index"]);
                            while (toolCalls.length <= idx)
                                toolCalls.push({});
                            mergeToolCallDelta(toolCalls[idx], t);
                        }
                    }
                }
                const fr = c["finish_reason"];
                if (typeof fr === "string" && fr !== "")
                    finishReason = fr;
            }
        }
        const u = usageFromFrame(obj);
        if (u)
            readUsageInto(stats, u);
        if (u)
            usageObj = u;
    };
    for (;;) {
        const { done, value } = await reader.read();
        if (done)
            break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (line.startsWith("data: [DONE]")) {
                sawDone = true;
                break;
            }
            if (!line.startsWith("data: "))
                continue;
            const payload = line.slice(6);
            let obj;
            try {
                obj = JSON.parse(payload);
            }
            catch {
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
    const message = { role: role || "assistant", content };
    if (reasoning)
        message["reasoning_content"] = reasoning;
    if (finalToolCalls.length > 0)
        message["tool_calls"] = finalToolCalls;
    stats.assistantRole = String(message["role"] ?? "assistant");
    stats.assistantContent = content;
    stats.assistantReasoning = reasoning;
    stats.assistantToolCalls = finalToolCalls;
    stats.finishReason = finishReason || "stop";
    out["object"] = "chat.completion";
    out["choices"] = [{ index: 0, message, finish_reason: finishReason || "stop" }];
    out["usage"] = usageObj ? (0, usage_1.normalizeUsage)(usageObj) : null;
    // hadToolCalls 必须在残缺参数过滤之前保留：否则调用被丢弃后，上层会把一次
    // 工具截断误认成普通正文截断，再发一次续写。缺少 [DONE] 同理是传输中断，
    // 不是模型正常达到输出上限。
    return { resp: out, stats, sawDone, hadToolCalls: toolCalls.length > 0 };
}
