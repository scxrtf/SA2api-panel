import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 探测可能跨多档×重试，单请求最长 5 分钟；整体时长由 tiers×retries 决定。
export const maxDuration = 600;

import { randomUUID } from "crypto";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { authShapeOf } from "@/lib/login";
import { chatStream } from "@/lib/upstream/client";
import { registerTest, cancelTest, unregisterTest } from "@/lib/modeltest";
import {
  DEFAULT_TIERS, PROBE_TIMEOUT_MS, judgeTier, verdictFromState, saveProbe,
  longPrompt, longPromptHard, probeRequestBody, consumeProbeSSE,
  type ProbeVerdict, type ProbeRunState,
} from "@/lib/modelprobe";

// POST 面板内一键探测模型真实输出上限（对齐 scripts/probe_max_tokens.py，结果落库 ModelProbe）。
// body: {model:"cn:glm-5.2"|"artex:xxx", tiers?:[40000,100000], retries?:2, probe_id?:uuid, uid?:string}
// 阶梯上探 × 判据与脚本一致；同步阻塞至出结论（单模型最坏 tiers×retries 次长输出）。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let body: { model?: string; tiers?: number[]; retries?: number; probe_id?: string; uid?: string };
  try { body = await req.json(); } catch { return fail(400, "parse body failed"); }
  const model = (body.model ?? "").trim();
  if (!model) return fail(400, "model is required");
  const tiers = (Array.isArray(body.tiers) && body.tiers.length > 0 ? body.tiers : DEFAULT_TIERS)
    .map((n) => Math.floor(n)).filter((n) => n > 0).sort((a, b) => a - b);
  if (tiers.length === 0) return fail(400, "tiers invalid");
  const retries = Math.max(1, Math.min(4, Math.floor(body.retries ?? 2)));
  const probeID = body.probe_id?.trim() || randomUUID();

  // 复用测试会话注册：同 id 幂等 409，DELETE 取消走同一 AbortController 表。
  const controller = registerTest(probeID, model);
  if (!controller) return fail(409, "probe already running: " + probeID);
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS * tiers.length * retries);
  try {
    // 解析前缀（与 models/test 一致）：cn:/global:/供应商名:/无前缀（默认 cn）。
    let realm = "cn";
    let providerName = "";
    let bare = model;
    const ci = model.indexOf(":");
    if (ci > 0) {
      const prefix = model.slice(0, ci);
      if (prefix === "cn" || prefix === "global") { realm = prefix; bare = model.slice(ci + 1); }
      else { providerName = prefix; bare = model.slice(ci + 1); }
    }

    // 解析探测通道（一次性，探针全程用同一通道，避免中途换号污染判据）。
    let provider: { baseUrl: string; apiKey: string } | null = null;
    if (providerName) {
      const p = await prisma.provider.findUnique({ where: { name: providerName } });
      if (!p) return fail(404, "provider not registered: " + providerName);
      provider = { baseUrl: p.baseUrl, apiKey: p.apiKey };
    }
    const cfg = await getConfig();
    let acct: Awaited<ReturnType<typeof prisma.account.findFirst>> | null = null;
    if (!provider) {
      const where = body.uid
        ? { uid: body.uid }
        : { realm, accessToken: { not: "" }, state: { is: { disabled: false, paused: false } } };
      acct = await prisma.account.findFirst({ where, include: { state: true } });
      if (!acct || acct.accessToken === "") return fail(503, "no available account for realm " + realm);
    }

    // 单次强制长输出请求（流式，带 usage）。
    const probeOnce = async (tier: number, prompt: string): Promise<{ out: number | null; reasoning: number | null; finish: string | null; err: string | null }> => {
      try {
        let bodyStream: ReadableStream<Uint8Array> | null = null;
        if (provider) {
          const resp = await fetch(provider.baseUrl.replace(/\/+$/, "") + "/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: "Bearer " + provider.apiKey },
            body: probeRequestBody(bare, tier, prompt),
            signal: controller.signal,
          });
          if (resp.status >= 400) {
            const raw = await resp.text();
            return { out: null, reasoning: null, finish: null, err: `HTTP ${resp.status}: ${raw.slice(0, 300)}` };
          }
          bodyStream = resp.body;
        } else {
          const res = await chatStream(
            cfg, authShapeOf(acct!), probeRequestBody(bare, tier, prompt), "",
            { conversationID: "probe-" + probeID, conversationRequestID: "probe:" + probeID, traceID: "probe:" + probeID },
            controller.signal,
          );
          if (res.status >= 400) {
            return { out: null, reasoning: null, finish: null, err: `HTTP ${res.status}: ${(res.respBody ?? "").slice(0, 300)}` };
          }
          bodyStream = res.body ?? null;
        }
        if (!bodyStream) return { out: null, reasoning: null, finish: null, err: "upstream returned no stream" };
        const r = await consumeProbeSSE(bodyStream, controller.signal);
        return { ...r, err: null };
      } catch (e) {
        return { out: null, reasoning: null, finish: null, err: e instanceof Error ? e.message : String(e) };
      }
    };

    // 阶梯上探（判据与脚本一致）。
    const st: ProbeRunState = { maxFull: null, evidence: [] };
    const started = Date.now();
    let allFailed = true;
    let aborted = false;
    let final: ProbeVerdict | null = null;
    outer:
    for (const tier of tiers) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        const prompt = attempt === 1 ? longPrompt(tier) : longPromptHard(tier);
        const r = await probeOnce(tier, prompt);
        if (controller.signal.aborted) { aborted = true; break outer; }
        if (r.err) {
          st.evidence.push(`tier=${tier} 请求失败: ${r.err.slice(0, 120)}`);
          continue outer; // 本档请求失败即换下一档（对齐脚本 break 内层）
        }
        allFailed = false;
        const step = judgeTier(tier, attempt, retries, r.out, r.finish, st.maxFull, st.evidence);
        if (step.kind === "terminal") {
          final = { measured: step.measured, verdict: step.verdict, note: step.note, elapsed_s: 0 };
          break outer;
        }
        if (step.kind === "retry") { st.maxFull = step.maxFull; continue; }
        if (step.kind === "next") { st.maxFull = step.maxFull; continue outer; }
        break; // abort：换下一档重试
      }
    }
    const elapsedS = Math.round(((Date.now() - started) / 1000) * 10) / 10;
    const verdict = final ?? verdictFromState(st, allFailed, elapsedS, aborted);
    verdict.elapsed_s = verdict.elapsed_s || elapsedS;

    // 落库（合并语义）。
    await saveProbe(model, null, verdict);
    return ok({ probe_id: probeID, result: { model, ...verdict } });
  } finally {
    clearTimeout(timeout);
    unregisterTest(probeID);
  }
}

// DELETE 取消进行中的探测（复用测试会话的 AbortController）。
export async function DELETE(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return fail(400, "id is required");
  cancelTest(id);
  return ok({ cancelled: id });
}
