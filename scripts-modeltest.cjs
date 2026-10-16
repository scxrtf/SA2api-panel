const fs = require("fs");
const path = require("path");

// 先写 src/lib/modeltest.ts（测试会话注册表 + SSE 消费）
const lib = String.raw`
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
`;
fs.writeFileSync("src/lib/modeltest.ts", lib.trimStart(), "utf8");
console.log("modeltest.ts written");

const head = `import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
`;

const files = {};

files["src/app/api/panel/model_probes/route.ts"] = head + `
// GET 模型探测历史（对齐 modelProbes）。
// Go 版读探测结果文件（模型探针外部工具写入）；Next.js 版无该文件机制，
// 返回空集合作兼容占位（前端「探测历史」区块显示为空而非报错）。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  return ok({ probes: {}, exists: false });
}
`;

files["src/app/api/panel/models/test/route.ts"] = head + `
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { authShapeOf } from "@/lib/login";
import { chatStream } from "@/lib/upstream/client";
import {
  registerTest, unregisterTest, requestBody, consumeSSE, MODEL_TEST_TIMEOUT_MS,
  type ModelTestResult,
} from "@/lib/modeltest";
import { randomUUID } from "crypto";

// POST 执行一次连通性测试（同步阻塞至完成/超时/取消，最长 45s；对齐 modelTest）。
// body: {model:"cn:glm-5.2"|"artex:xxx"|"glm-5.2", test_id?:uuid, uid?:string}
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let body: { model?: string; test_id?: string; uid?: string };
  try { body = await req.json(); } catch { return fail(400, "parse body failed"); }
  const model = (body.model ?? "").trim();
  if (!model) return fail(400, "model is required");
  const testID = body.test_id?.trim() || randomUUID();

  const controller = registerTest(testID, model);
  if (!controller) return fail(409, "test already running: " + testID);
  const timeout = setTimeout(() => controller.abort(), MODEL_TEST_TIMEOUT_MS);
  try {
    // 解析前缀：cn: / global: / 供应商名: / 无前缀（默认 cn）。
    let realm = "cn";
    let providerName = "";
    let bare = model;
    const ci = model.indexOf(":");
    if (ci > 0) {
      const prefix = model.slice(0, ci);
      if (prefix === "cn" || prefix === "global") {
        realm = prefix;
        bare = model.slice(ci + 1);
      } else {
        providerName = prefix;
        bare = model.slice(ci + 1);
      }
    }

    if (providerName) {
      // 供应商直连通道。
      const p = await prisma.provider.findUnique({ where: { name: providerName } });
      if (!p) return fail(404, "provider not registered: " + providerName);
      const resp = await fetch(p.baseUrl.replace(/\\/+$/, "") + "/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + p.apiKey },
        body: requestBody(bare),
        signal: controller.signal,
      });
      if (resp.status >= 400) {
        const raw = await resp.text();
        return fail(resp.status, "upstream http " + resp.status + ": " + raw.slice(0, 300));
      }
      if (!resp.body) return fail(502, "upstream returned no stream");
      const r = await consumeSSE(resp.body, controller.signal);
      return ok({ result: toResult(bare, r) });
    }

    // CodeBuddy 池通道：指定 uid 或按 realm 取第一个可用号。
    const where = body.uid
      ? { uid: body.uid }
      : { realm, accessToken: { not: "" }, state: { is: { disabled: false, paused: false } } };
    const acct = await prisma.account.findFirst({ where, include: { state: true } });
    if (!acct || acct.accessToken === "") {
      return fail(503, "no available account for realm " + realm);
    }
    const cfg = await getConfig();
    const res = await chatStream(
      cfg, authShapeOf(acct), requestBody(bare), "",
      { conversationRequestID: "modeltest:" + testID },
    );
    if (res.status >= 400) {
      return fail(res.status, "upstream http " + res.status + ": " + res.body.slice(0, 300));
    }
    if (!res.stream) return fail(502, "upstream returned no stream");
    const r = await consumeSSE(res.stream, controller.signal);
    return ok({ result: toResult(bare, r) });
  } catch (e) {
    if (controller.signal.aborted) {
      return new Response(JSON.stringify({ ok: false, error: "test cancelled" }), {
        status: 499, headers: { "Content-Type": "application/json" },
      });
    }
    return fail(502, e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timeout);
    unregisterTest(testID);
  }
}

function toResult(model: string, r: { firstTokenMs: number; totalMs: number; outputTokens: number }): ModelTestResult {
  return {
    model,
    first_token_ms: r.firstTokenMs,
    total_ms: r.totalMs,
    output_tokens: r.outputTokens,
    tokens_per_sec: r.totalMs > 0 ? Math.round((r.outputTokens / r.totalMs) * 1000 * 10) / 10 : 0,
  };
}
`;

files["src/app/api/panel/models/test/[id]/route.ts"] = head + `
import { cancelTest } from "@/lib/modeltest";

// DELETE 取消进行中的测试（幂等：未知 id 也返回 ok；对齐 modelTestCancel）。
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { id } = await ctx.params;
  cancelTest(id);
  return ok();
}
`;

for (const [p, c] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, c.trimStart(), "utf8");
  console.log("written", p);
}
