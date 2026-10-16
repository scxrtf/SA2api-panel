import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      const resp = await fetch(p.baseUrl.replace(/\/+$/, "") + "/v1/chat/completions", {
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
      { conversationID: "modeltest-" + testID, conversationRequestID: "modeltest:" + testID, traceID: "modeltest:" + testID },
      controller.signal,
    );
    if (res.status >= 400) {
      return fail(res.status, "upstream http " + res.status + ": " + (res.respBody ?? "").slice(0, 300));
    }
    if (!res.body) return fail(502, "upstream returned no stream");
    const r = await consumeSSE(res.body, controller.signal);
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
