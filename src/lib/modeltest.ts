// 模型连通性测试（移植 internal/modeltest + panel/modeltest.go）。
// 固定 prompt 打一次真实流式请求，返回首字延迟/总耗时/输出 tokens/速率。
// test_id 幂等：同 id 已在跑返回 409；DELETE 取消（AbortController）。
export const MODEL_TEST_TIMEOUT_MS = 45_000;

export interface ModelTestResult {
  model: string;
  first_token_ms: number;
  total_ms: number;
  output_tokens: number;
  tokens_per_sec: number;
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

// requestBody 固定 prompt（对齐 modeltest.RequestBody）。
export function requestBody(model: string): string {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: "hi" }],
    stream: true,
    max_tokens: 32,
  });
}

// consumeSSE 读干 SSE 流，统计首字延迟与输出 tokens（content delta 计数近似）。
export async function consumeSSE(
  stream: ReadableStream<Uint8Array>, signal: AbortSignal,
): Promise<{ firstTokenMs: number; totalMs: number; outputTokens: number }> {
  const started = Date.now();
  let firstTokenMs = 0;
  let outputTokens = 0;
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
        try {
          const obj = JSON.parse(data) as {
            choices?: { delta?: { content?: string } }[];
          };
          const c = obj.choices?.[0]?.delta?.content ?? "";
          if (c) {
            if (firstTokenMs === 0) firstTokenMs = Date.now() - started;
            outputTokens++;
          }
        } catch { /* 非 JSON 行跳过 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  const totalMs = Date.now() - started;
  return { firstTokenMs: firstTokenMs || totalMs, totalMs, outputTokens };
}
