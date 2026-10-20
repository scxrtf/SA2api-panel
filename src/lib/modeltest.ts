// 模型连通性测试（移植 internal/modeltest + panel/modeltest.go）。
// 固定 prompt 打一次真实流式请求，返回首字延迟/总耗时/输出 tokens/速率等细分指标。
// test_id 幂等：同 id 已在跑返回 409；DELETE 取消（AbortController）。
export const MODEL_TEST_TIMEOUT_MS = 45_000;

export interface ModelTestResult {
  model: string;
  first_token_ms: number;
  total_ms: number;
  output_tokens: number;
  tokens_per_sec: number;
  // 细化指标（P2 新增，老客户端可忽略）：
  gen_ms: number;            // 生成侧耗时 = total - first_token（对齐原作 tok/s 口径分母）
  chunks: number;            // 收到的 SSE data 帧数
  output_chars: number;      // 输出字符总数
  usage_tokens: number | null; // 上游 usage 返回的输出 tokens（无 usage 时为 null）
}

interface TestSession {
  controller: AbortController;
  model: string;
}

const g = globalThis as unknown as { __wbModelTests?: Map<string, TestSession> };
const sessions: Map<string, TestSession> = g.__wbModelTests ?? (g.__wbModelTests = new Map());

// registerTest 注册测试会话；同 id 已在跑返回 false（409）。
export function registerTest(id: string, model: string): AbortController | null {
  if (sessions.has(id)) return null;
  const controller = new AbortController();
  sessions.set(id, { controller, model });
  return controller;
}

export function cancelTest(id: string): void {
  sessions.get(id)?.controller.abort();
}

export function unregisterTest(id: string): void {
  sessions.delete(id);
}

// TestPrompt 固定测试提示词（对齐 Go modeltest.TestPrompt / cursor-byok）：
// 强迫一段可预期长度的纯文本输出，数字序列对任何模型都无需工具/推理，
// 避免思考档位污染速率读数。跨工具读数可比。
export const TEST_PROMPT =
  "Output the numbers 1 through 120 separated by a single space. No commas, no newlines, no explanation.";

// requestBody 固定 prompt（对齐 modeltest.RequestBody：流式 + include_usage）。
export function requestBody(model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: TEST_PROMPT }],
    stream: true,
    stream_options: { include_usage: true },
  });
}

// consumeSSE 读干 SSE 流，统计首字延迟、输出 tokens（delta 计数近似）、
// chunk 帧数、输出字符数与上游 usage（如有）。
export async function consumeSSE(
  stream: ReadableStream<Uint8Array>, signal: AbortSignal,
): Promise<{
  firstTokenMs: number; totalMs: number; outputTokens: number;
  chunks: number; outputChars: number; usageTokens: number | null;
}> {
  const started = Date.now();
  let firstTokenMs = 0;
  let outputTokens = 0;
  let chunks = 0;
  let outputChars = 0;
  let usageTokens: number | null = null;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal.aborted) throw new Error("test cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        chunks++;
        try {
          const obj = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[];
            usage?: { completion_tokens?: number; output_tokens?: number };
          };
          const c = obj.choices?.[0]?.delta?.content ?? "";
          if (c) {
            if (firstTokenMs === 0) firstTokenMs = Date.now() - started;
            outputTokens++;
            outputChars += c.length;
          }
          const u = obj.usage?.completion_tokens ?? obj.usage?.output_tokens;
          if (typeof u === "number" && u > 0) usageTokens = u;
        } catch { /* 非 JSON 行跳过 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const totalMs = Date.now() - started;
  return { firstTokenMs: firstTokenMs || totalMs, totalMs, outputTokens, chunks, outputChars, usageTokens };
}
