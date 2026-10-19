// 模型输出上限探测（移植 scripts/probe_max_tokens.py 为面板内一键探测，结果落库 ModelProbe）。
// 判据对齐原作：「强制长输出 + 阶梯上探」区分两种停止——
//   finish=length 且 输出 < 请求  → 上游截断（钳制），输出值即真实上限
//   finish=length 且 输出 = 请求  → 支持至少这么多，继续上探更高阶梯
//   finish=stop   且 输出 < 请求  → 模型主动收尾，不可作判据，强化提示重试
// 结果五态之三：clamped（钳制）/ at_least（≥下界）/ inconclusive（未测出）。
import { prisma } from "@/lib/db";

export const PROBE_TIMEOUT_MS = 300_000; // 单请求上限 5 分钟
export const PROBE_SOURCE = "panel-probe";

// 阶梯档位（对齐脚本默认 tiers 40000,100000：足够识别常见 32K/48K/64K 钳制）。
export const DEFAULT_TIERS = [40_000, 100_000];

export interface ProbeVerdict {
  measured: number | null;
  verdict: "clamped" | "at_least" | "inconclusive";
  note: string;
  elapsed_s: number;
}

// longPrompt 强制长输出提示：目标值与档位量级相当（约 max_tokens/3 个数字，
// 每数字行约 2~3 token，留余量防提前写完）。目标过大模型会判断"不可能完成"而提前收尾。
export function longPrompt(maxTokens: number): string {
  const target = Math.max(2000, Math.min(200000, Math.floor(maxTokens / 3)));
  return (
    `请从 1 开始，每行输出一个数字，依次递增，一直数到 ${target}。` +
    "严格只输出数字本身，每行一个；不要解释、不要总结、不要省略、不要合并、不要提前结束。"
  );
}

// 强化版（第一次被模型主动收尾时使用，仍保持量级匹配）。
export function longPromptHard(maxTokens: number): string {
  const target = Math.max(2000, Math.min(200000, Math.floor(maxTokens / 3)));
  return (
    `Count from 1 to ${target}, one number per line, incrementing by 1. ` +
    "Output digits only, one per line. Do not summarize, do not explain, " +
    "do not skip numbers, do not stop early — you must reach the target."
  );
}

export function probeRequestBody(model: string, maxTokens: number, prompt: string): string {
  return JSON.stringify({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
  });
}

export interface ProbeOnceResult {
  out: number | null;      // usage.completion_tokens
  reasoning: number | null;
  finish: string | null;   // length | stop | ...
  err: string | null;
}

// consumeProbeSSE 读干 SSE 流，取 finish_reason 与 usage（探测只关心统计，不关心正文）。
export async function consumeProbeSSE(
  stream: ReadableStream<Uint8Array>, signal: AbortSignal,
): Promise<{ out: number | null; reasoning: number | null; finish: string | null }> {
  let out: number | null = null;
  let reasoning: number | null = null;
  let finish: string | null = null;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal.aborted) throw new Error("probe cancelled");
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const obj = JSON.parse(data) as {
            usage?: {
              completion_tokens?: number;
              completion_tokens_details?: { reasoning_tokens?: number };
            };
            choices?: { finish_reason?: string | null }[];
          };
          const u = obj.usage;
          if (u && typeof u.completion_tokens === "number") {
            out = u.completion_tokens;
            const det = u.completion_tokens_details;
            if (det && typeof det.reasoning_tokens === "number") reasoning = det.reasoning_tokens;
          }
          for (const c of obj.choices ?? []) {
            if (c && c.finish_reason) finish = c.finish_reason;
          }
        } catch { /* 非 JSON 行跳过 */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { out, reasoning, finish };
}

export interface ProbeRunState {
  maxFull: number | null;
  evidence: string[];
}

export type TierStep =
  | { kind: "terminal"; verdict: ProbeVerdict["verdict"]; measured: number | null; note: string }
  | { kind: "retry"; maxFull: number | null }     // 强化提示重试本档
  | { kind: "next"; maxFull: number | null }      // 满额通过，上探下一档
  | { kind: "abort"; note: string };              // 请求失败/异常，中止本模型

// judgeTier 单档判据：out/finish + 已累计的 maxFull → 终态 / 重试 / 上探 / 中止。
export function judgeTier(
  tier: number, attempt: number, retries: number,
  out: number | null, finish: string | null,
  maxFull: number | null, evidence: string[],
): TierStep {
  if (finish === "length" && out !== null) {
    if (out < tier) {
      // 上游截断：输出值即真实上限（可信）。上一档满额过则语义是"≥out 附近被钳"。
      const prev = maxFull;
      evidence.push(`要 ${tier} 只给 ${out}（finish=length）`);
      const note = prev && out < prev
        ? `≈${out}（钳制；上一档满额 ${prev}，取值 ${out}）`
        : "钳制";
      return { kind: "terminal", verdict: "clamped", measured: out, note: `${note}· ${evidence.join("；")}` };
    }
    evidence.push(`tier=${tier}: 输出满额 ${out}（支持≥${tier}）`);
    return { kind: "next", maxFull: out };
  }
  if (finish === "stop") {
    evidence.push(`tier=${tier} #${attempt}: finish=stop（模型主动收尾，输出 ${out}）`);
    const nf = out !== null ? Math.max(maxFull ?? 0, out) : maxFull;
    if (attempt >= retries) {
      // 已满额通过的档位仍然有效：结论是"≥maxFull"，不是"无结论"。
      if (nf) {
        return {
          kind: "terminal", verdict: "at_least", measured: nf,
          note: `≥${nf}（模型主动收尾，未测到钳制点）· ${evidence.join("；")}`,
        };
      }
      return { kind: "terminal", verdict: "inconclusive", measured: null, note: "模型主动停止（未能测出上限，非钳制）" };
    }
    return { kind: "retry", maxFull: nf };
  }
  evidence.push(`tier=${tier}: 异常返回 out=${out} finish=${finish}`);
  return { kind: "abort", note: evidence.join("；") };
}

// evaluateProbe 汇总一次阶梯上探的中间态为面板契约终态。
// probeOnce 的循环在 route 内（要过 chatStream / provider 两条通道），此处只做判定。
export function verdictFromState(
  st: ProbeRunState, allFailed: boolean, elapsedS: number, aborted = false,
): ProbeVerdict {
  if (aborted) {
    if (st.maxFull) {
      return {
        measured: st.maxFull, verdict: "at_least",
        note: `未测完（中止；已知至少 ≥${st.maxFull}）· ${st.evidence.join("；")}`,
        elapsed_s: elapsedS,
      };
    }
    return { measured: null, verdict: "inconclusive", note: "未测完（中止）· " + st.evidence.join("；"), elapsed_s: elapsedS };
  }
  if (allFailed) {
    return { measured: null, verdict: "inconclusive", note: "全部请求失败（模型/账号不可用，无结论）", elapsed_s: elapsedS };
  }
  if (st.maxFull) {
    return {
      measured: st.maxFull, verdict: "at_least",
      note: `≥${st.maxFull}（最高档位仍满额，未触顶）· ${st.evidence.join("；")}`,
      elapsed_s: elapsedS,
    };
  }
  return { measured: null, verdict: "inconclusive", note: st.evidence.join("；") || "未测出", elapsed_s: elapsedS };
}

// saveProbe 落库（合并语义：未重测的模型保留旧记录，上游改限后重跑即覆盖）。
export async function saveProbe(
  key: string, claimed: number | null, v: ProbeVerdict,
): Promise<void> {
  await prisma.modelProbe.upsert({
    where: { key },
    create: {
      key, claimed, measured: v.measured, verdict: v.verdict,
      note: v.note, source: PROBE_SOURCE, testedAt: new Date(),
    },
    update: {
      claimed, measured: v.measured, verdict: v.verdict,
      note: v.note, source: PROBE_SOURCE, testedAt: new Date(),
    },
  });
}

// listProbes 读全量探测结果（对齐 Go modelProbes 响应契约）。
export async function listProbes(): Promise<{
  probes: Record<string, {
    claimed: number | null; measured: number | null; verdict: string;
    note: string; tested_at: string; source: string;
  }>;
  exists: boolean; updated_at: string | null;
}> {
  const rows = await prisma.modelProbe.findMany({ orderBy: { updatedAt: "desc" } });
  const probes: Record<string, {
    claimed: number | null; measured: number | null; verdict: string;
    note: string; tested_at: string; source: string;
  }> = {};
  let updatedAt: string | null = null;
  for (const r of rows) {
    probes[r.key] = {
      claimed: r.claimed, measured: r.measured, verdict: r.verdict,
      note: r.note, tested_at: r.testedAt.toISOString(), source: r.source,
    };
    if (!updatedAt) updatedAt = r.updatedAt.toISOString();
  }
  return { probes, exists: rows.length > 0, updated_at: updatedAt };
}
