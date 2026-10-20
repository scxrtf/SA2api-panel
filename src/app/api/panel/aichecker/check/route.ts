import { panelAuth, ok, fail, jsonify } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 采样 iterations 次（默认 100），并发上限 10，单次采样上限 120s；
// 无有效样本且连续失败时提前止损，正常 100 次 / 并发 5 约 1-3 分钟。
export const maxDuration = 600;

import { randomUUID } from "crypto";
import { registerTest, cancelTest, unregisterTest } from "@/lib/modeltest";
import { BASELINE_ID_RE, loadOfficialBaselines } from "@/lib/aichecker-official";
import { listCustomBaselines } from "@/lib/aichecker-baselines";
import { loadBaseline } from "@/lib/aichecker-baseline-loader";
import {
  MIN_SAMPLES, DEFAULT_ITERATIONS,
  buildPrompt, calculateDistribution, calculateStats, calculateSimilarity,
  quickVerdict, scoreToPct, resolveChannel, sampleOnce,
  type Baseline,
} from "@/lib/aichecker";

// POST 一键鉴别（对齐 hlwy-ai-checker 自动模式 startQuickCheck）：
// 下载官方基准 → 对待测渠道并发采样 → 与全部官方基准横向比对出报告。
// body: {model:"cn:glm-5.2"|"artex:xxx"|任意名, baseline:"gpt-6-astra",
//        iterations?:100, concurrency?:5, anti_target?:false,
//        base_url?/api_key?（显式外站通道，缺省走池/供应商）, check_id?:uuid, uid?:string}
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let body: {
    model?: string; baseline?: string; iterations?: number; concurrency?: number;
    anti_target?: boolean; base_url?: string; api_key?: string; check_id?: string; uid?: string;
  };
  try { body = await req.json(); } catch { return fail(400, "parse body failed"); }
  const model = (body.model ?? "").trim();
  const baselineID = (body.baseline ?? "").trim();
  if (!model) return fail(400, "model is required");
  if (!baselineID || !BASELINE_ID_RE.test(baselineID)) return fail(400, "baseline 缺失或不合法");
  const iterations = Math.max(MIN_SAMPLES, Math.min(500, Math.floor(body.iterations ?? DEFAULT_ITERATIONS)));
  const concurrency = Math.max(1, Math.min(10, Math.floor(body.concurrency ?? 5)));
  const checkID = body.check_id?.trim() || randomUUID();

  const controller = registerTest(checkID, model);
  if (!controller) return fail(409, "check already running: " + checkID);
  try {
    // 步骤 1：下载所选官方基准 + 其余基准（横向比对用；失败不阻塞主流程）。
    // 直接读本地快照 / DB / 上游，绝不自请求本面板 API。
    const claimed = await loadBaseline(baselineID);
    if (!claimed) return fail(502, `无法下载基准「${baselineID}」`);
    const others = await loadOtherBaselines(req.url, baselineID);

    // 步骤 2：并发采样（对齐上游 runWithConcurrency 语义：固定 worker 数抢任务）。
    const ch = resolveChannel({ model, base_url: body.base_url, api_key: body.api_key, uid: body.uid });
    const results: number[] = [];
    const errors: string[] = [];
    let next = 0;
    let unsupported = false;
    const worker = async () => {
      while (next < iterations && !controller.signal.aborted) {
        next++;
        try {
          const n = await sampleOnce(ch, buildPrompt(body.anti_target === true), controller.signal, checkID);
          if (n !== null) results.push(n);
          else pushErr(errors, "返回内容无法解析为 1-355 的数字");
        } catch (e) {
          if (controller.signal.aborted) return;
          const msg = e instanceof Error ? e.message : String(e);
          pushErr(errors, msg);
          // 连续多个样本都只出思考/空正文 → 该模型无法完成数字指纹采样，
          // 提前止损，避免 100 次采样全部空转（单次最长 120s）。
          if (results.length === 0 && errors.length >= Math.max(3, concurrency) &&
              errors.every((x) => /思考|空正文|max_tokens|超时/.test(x))) {
            unsupported = true;
            controller.abort();
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, iterations) }, worker));

    // 中止时也用已有样本出报告（对齐上游：≥40 即出）。
    if (results.length < MIN_SAMPLES) {
      return fail(422,
        `仅获得 ${results.length} 个有效样本（至少 ${MIN_SAMPLES} 个），无法出报告。` +
        (unsupported ? " 该模型无法稳定输出正文（思考不可关闭），不适合做指纹采样。" : "") +
        (errors.length ? ` 最近错误: ${errors[0]}` : ""));
    }

    // 步骤 3：报告——与所选基准算相似度，并与全部官方基准横向比对。
    const distribution = calculateDistribution(results);
    const stats = calculateStats(results);
    const similarity = calculateSimilarity(distribution, claimed.data.distribution, stats, claimed.data.stats);
    const matches: { id: string; name: string; claimed: boolean; score: number; sim?: typeof similarity }[] = [
      { id: baselineID, name: claimed.data.name, claimed: true, score: scoreToPct(similarity.overallScore), sim: similarity },
      ...others.map((o) => ({
        id: o.id, name: o.data.name, claimed: false,
        score: scoreToPct(calculateSimilarity(distribution, o.data.distribution, stats, o.data.stats).overallScore),
      })),
    ].sort((a, b) => b.score - a.score);
    const bestOther = matches.find((m) => !m.claimed)?.score;
    const verdict = quickVerdict(
      similarity.overallScore,
      bestOther !== undefined && matches.length > 1 ? bestOther / 100 : null,
    );

    return jsonify({
      ok: true,
      check_id: checkID,
      result: {
        model, baseline: baselineID, verdict,
        baseline_name: claimed.data.name,
        baseline_distribution: claimed.data.distribution,
        score: scoreToPct(similarity.overallScore),
        similarity,
        stats,
        distribution,
        samples: results.length,
        requested: iterations,
        failed: errors.length,
        errors: errors.slice(0, 10),
        matches: matches.map((m) => ({ id: m.id, name: m.name, claimed: m.claimed, score: m.score })),
      },
    });
  } finally {
    unregisterTest(checkID);
  }
}

// DELETE 取消进行中的鉴别（复用测试会话 AbortController 表）。
export async function DELETE(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return fail(400, "id is required");
  cancelTest(id);
  return ok({ cancelled: id });
}

function pushErr(errors: string[], msg: string) {
  errors.push(msg.slice(0, 200));
  if (errors.length > 50) errors.shift();
}

// loadOtherBaselines 由本地清单 + 自建清单拼出候选，再走统一 loader。
// 任何一路失败都不阻塞主流程：横向比对只是报告里的附加信息。
async function loadOtherBaselines(reqURL: string, exclude: string): Promise<{ id: string; data: Baseline }[]> {
  const ids = new Set<string>();
  try {
    for (const b of await loadOfficialBaselines(reqURL)) ids.add(b.id);
  } catch { /* 官方清单缺失时仍可只用自建基准 */ }
  try {
    for (const b of await listCustomBaselines()) ids.add(b.id);
  } catch { /* DB 未就绪时只比对官方基准 */ }
  ids.delete(exclude);

  const loaded = await Promise.all([...ids]
    .filter((id) => BASELINE_ID_RE.test(id))
    .map(async (id) => {
      const found = await loadBaseline(id, { allowUpstream: false });
      return found ? { id, data: found.data } : null;
    }));
  return loaded.filter((x): x is { id: string; data: Baseline } => x !== null);
}

