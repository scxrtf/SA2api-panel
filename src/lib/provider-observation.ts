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
  private sawByte = false;
  private valid = false;
  private finished = false;
  private decoder = new TextDecoder();
  private buffer = "";
  private data: string[] = [];

  constructor(private started: number) {}

  json(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const obj = value as Record<string, unknown>;
    this.valid = true;
    if (obj.error) this.errKind = "provider_error";
    if (Array.isArray(obj.choices) && obj.choices.some((c) => c?.finish_reason)) this.finished = true;
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
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          stats.end();
          await finish();
          controller.close();
        } else {
          stats.chunk(value);
          controller.enqueue(value);
        }
      } catch (e) {
        stats.errKind ||= "provider_stream_error";
        await finish();
        await reader.cancel(e).catch(() => undefined);
        controller.error(e);
      }
    },
    async cancel(reason) {
      stats.errKind ||= "client_cancelled";
      await finish();
      await reader.cancel(reason).catch(() => undefined);
    },
  }, { highWaterMark: 0 });
}
