// 供应商响应只观测，不规范化/改写内容，也不推断 CodeBuddy 积分。
import { usageTokensFromResponse, usageCacheHitTokens, usageCacheMissTokens } from "./upstream/usage";

export class ProviderObservation {
  promptTokens = 0;
  completionTok = 0;
  totalTokens = 0;
  cacheHitTok = 0;
  cacheMissTok = 0;
  ttfbMs = 0;
  errKind = "";
  errorBody = "";
  rawBody = "";
  responseRole = "";
  responseContent = "";
  responseReasoning = "";
  responseToolCalls: Record<string, unknown>[] = [];
  finishReason = "";
  private sawByte = false;
  private valid = false;
  private finished = false;
  private decoder = new TextDecoder();
  private buffer = "";
  private data: string[] = [];

  constructor(private started: number) {}

  private mergeToolCall(merged: Record<string, unknown>, delta: Record<string, unknown>): void {
    for (const key of ["id", "type"]) {
      const value = delta[key];
      if (typeof value === "string" && value && !merged[key]) merged[key] = value;
    }
    const fn = delta.function;
    if (!fn || typeof fn !== "object" || Array.isArray(fn)) return;
    let target = merged.function;
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      target = {};
      merged.function = target;
    }
    const out = target as Record<string, unknown>;
    const next = fn as Record<string, unknown>;
    if (typeof next.name === "string" && next.name && !out.name) out.name = next.name;
    if (typeof next.arguments === "string" && next.arguments) {
      out.arguments = String(out.arguments ?? "") + next.arguments;
    }
  }

  private observeMessage(message: Record<string, unknown>): void {
    if (typeof message.role === "string" && message.role) this.responseRole = message.role;
    if (typeof message.content === "string") this.responseContent += message.content;
    if (typeof message.reasoning_content === "string") {
      this.responseReasoning += message.reasoning_content;
    }
    if (Array.isArray(message.tool_calls)) {
      for (let i = 0; i < message.tool_calls.length; i++) {
        const call = message.tool_calls[i];
        if (!call || typeof call !== "object" || Array.isArray(call)) continue;
        while (this.responseToolCalls.length <= i) this.responseToolCalls.push({});
        const source = call as Record<string, unknown>;
        const target = this.responseToolCalls[i];
        for (const [key, value] of Object.entries(source)) {
          if (key !== "function") target[key] = value;
        }
        if (source.function && typeof source.function === "object"
          && !Array.isArray(source.function)) {
          const fn = source.function as Record<string, unknown>;
          const existing = target.function && typeof target.function === "object"
            && !Array.isArray(target.function)
            ? target.function as Record<string, unknown>
            : {};
          for (const key of ["name", "arguments"]) {
            if (typeof fn[key] === "string" && (!existing[key] || key === "arguments")) {
              existing[key] = key === "arguments"
                ? String(existing[key] ?? "") + fn[key]
                : fn[key];
            }
          }
          target.function = existing;
        }
      }
    }
  }

  private observeDelta(delta: Record<string, unknown>): void {
    if (typeof delta.role === "string" && delta.role) this.responseRole = delta.role;
    if (typeof delta.content === "string") this.responseContent += delta.content;
    if (typeof delta.reasoning_content === "string") {
      this.responseReasoning += delta.reasoning_content;
    }
    if (!Array.isArray(delta.tool_calls)) return;
    for (const call of delta.tool_calls) {
      if (!call || typeof call !== "object" || Array.isArray(call)) continue;
      const source = call as Record<string, unknown>;
      const rawIndex = source.index;
      const index = typeof rawIndex === "number" && Number.isFinite(rawIndex) && rawIndex >= 0
        ? Math.floor(rawIndex)
        : 0;
      while (this.responseToolCalls.length <= index) this.responseToolCalls.push({});
      this.mergeToolCall(this.responseToolCalls[index], source);
    }
  }

  json(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const obj = value as Record<string, unknown>;
    this.valid = true;
    if (obj.error) {
      this.errKind = "provider_error";
      this.errorBody = JSON.stringify(obj);
    }
    if (Array.isArray(obj.choices)) {
      for (const choice of obj.choices) {
        if (!choice || typeof choice !== "object" || Array.isArray(choice)) continue;
        const item = choice as Record<string, unknown>;
        if (item.message && typeof item.message === "object" && !Array.isArray(item.message)) {
          this.observeMessage(item.message as Record<string, unknown>);
        }
        if (item.delta && typeof item.delta === "object" && !Array.isArray(item.delta)) {
          this.observeDelta(item.delta as Record<string, unknown>);
        }
        if (typeof item.finish_reason === "string" && item.finish_reason) {
          this.finished = true;
          this.finishReason = item.finish_reason;
        }
      }
    }
    if (obj.usage && typeof obj.usage === "object" && !Array.isArray(obj.usage)) {
      const { pt, ct, tt } = usageTokensFromResponse(obj);
      this.promptTokens = pt;
      this.completionTok = ct;
      this.totalTokens = tt;
      this.cacheHitTok = usageCacheHitTokens(obj.usage as Record<string, unknown>) ?? 0;
      this.cacheMissTok = usageCacheMissTokens(obj.usage as Record<string, unknown>) ?? 0;
    }
  }

  private dispatch(): void {
    const payload = this.data.join("\n").trim();
    this.data = [];
    if (payload === "[DONE]") { this.finished = true; return; }
    if (!payload) return;
    try { this.json(JSON.parse(payload)); } catch { /* 非 JSON 数据不参与统计。 */ }
  }

  private line(line: string): void {
    if (!line) this.dispatch();
    else if (line.startsWith("data:")) this.data.push(line.slice(5).replace(/^ /, ""));
  }

  chunk(value: Uint8Array): void {
    if (value.byteLength && !this.sawByte) {
      this.sawByte = true;
      this.ttfbMs = Math.max(1, Date.now() - this.started);
    }
    this.buffer += this.decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      this.line(this.buffer.slice(0, idx).replace(/\r$/, ""));
      this.buffer = this.buffer.slice(idx + 1);
    }
  }

  end(): void {
    this.buffer += this.decoder.decode();
    if (this.buffer) this.line(this.buffer.replace(/\r$/, ""));
    this.buffer = "";
    this.dispatch();
    if (!this.errKind && (!this.valid || !this.finished)) {
      this.errKind = this.valid ? "provider_stream_incomplete" : "provider_empty_stream";
      this.errorBody ||= this.valid ? "provider stream ended before finish_reason" : "provider returned an empty stream";
    }
  }
}

// 与客户端同一路读取：无 tee 后台继续消费、无整段响应缓冲；断开会取消上游。
export function observeProviderStream(
  body: ReadableStream<Uint8Array>,
  stats: ProviderObservation,
  finish: () => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (cancelled) return;
        if (done) {
          stats.end();
          await finish();
          controller.close();
        } else {
          stats.chunk(value);
          controller.enqueue(value);
        }
      } catch (e) {
        if (cancelled) return;
        stats.errKind ||= "provider_stream_error";
        stats.errorBody ||= e instanceof Error ? e.stack || e.message : String(e);
        await reader.cancel(e).catch(() => undefined);
        await finish();
        controller.error(e);
      }
    },
    async cancel(reason) {
      cancelled = true;
      stats.errKind ||= "client_cancelled";
      // 先释放网络连接，不能被慢数据库拖住上游取消。
      await reader.cancel(reason).catch(() => undefined);
      await finish();
    },
  }, { highWaterMark: 0 });
}
