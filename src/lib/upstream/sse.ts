// SSE 处理（移植 internal/upstream/sse.go 的核心）：
//  - streamPassthrough：逐帧规范化透传（白名单重建 + error 帧观察 + [DONE] 兜底）
//  - aggregate：把 SSE 流聚合成单个非流式响应（tool_calls 分片合并）

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
  out["usage"] = obj["usage"] ?? null;
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
}

// streamPassthrough 透传上游 SSE（逐帧规范化）。返回 stats；写失败抛错（客户端断连）。
export async function streamPassthrough(
  upstream: ReadableStream<Uint8Array>,
  out: WritableStream<Uint8Array>,
): Promise<StreamStats> {
  const stats: StreamStats = {
    validFrames: 0, errorFrame: "",
    promptTokens: 0, completionTokens: 0, totalTokens: 0, hasUsage: false,
    credit: 0, hasCredit: false, ttfbMs: 0,
  };
  const started = Date.now();
  const reader = upstream.getReader();
  const writer = out.getWriter();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
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
            // error 帧：原样透传 + 旁路采集（供账号处置分类）。
            stats.errorFrame = payload;
            await write(payload);
            stats.validFrames++;
            continue;
          }
          if (obj) {
            if (stats.validFrames === 0) stats.ttfbMs = Date.now() - started;
            const u = usageFromFrame(obj);
            if (u) readUsageInto(stats, u);
            await write(JSON.stringify(normalizeFrame(obj)));
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
    // 空流兜底：先写 error 帧再补 [DONE]（HTTP 头已发只能 200）。
    if (stats.validFrames === 0) {
      await write('{"error":{"message":"empty upstream stream","type":"upstream_error","code":"upstream_parse"}}');
    }
    await writer.write(enc.encode("data: [DONE]\n\n"));
  } finally {
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
  };
  const reader = upstream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let out: Obj = {};
  let content = "";
  let reasoning = "";
  let role = "";
  let finishReason = "";
  const toolCalls: Obj[] = [];

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
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line.startsWith("data: [DONE]")) break;
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
  const message: Obj = { role: role || "assistant", content };
  if (reasoning) message["reasoning_content"] = reasoning;
  if (toolCalls.length > 0) message["tool_calls"] = toolCalls;
  out["object"] = "chat.completion";
  out["choices"] = [{ index: 0, message, finish_reason: finishReason || "stop" }];
  out["usage"] = stats.hasUsage
    ? {
        prompt_tokens: stats.promptTokens,
        completion_tokens: stats.completionTokens,
        total_tokens: stats.totalTokens,
        ...(stats.hasCredit ? { credit: stats.credit } : {}),
      }
    : null;
  return { resp: out, stats };
}
