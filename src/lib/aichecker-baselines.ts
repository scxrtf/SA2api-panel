// 自建 / 导入指纹基准的持久层。
// 官方快照只有 7 个模型，无法覆盖用户实际接入的模型；这里把「本渠道实测分布」
// 或外部导出的基准 JSON 存进 Setting 表（每基准一行，避免并发读改写丢数据），
// 之后可与官方基准一起参与横向比对。
import { prisma } from "@/lib/db";
import {
  DIST_LENGTH, normalizeBaseline,
  type Baseline, type BaselineStats,
} from "@/lib/aichecker";
import { BASELINE_ID_RE } from "@/lib/aichecker-official";

const KEY_PREFIX = "aichecker.baseline.";
const LABEL_MAX = 60;

export interface CustomBaselineMeta {
  id: string;
  label: string;
  createdAt: string;
  model: string;
}

export interface CustomBaselineRecord extends CustomBaselineMeta {
  data: Baseline;
}

// 列表：只返回元信息，避免把 355 桶分布全部塞进下拉列表响应。
export async function listCustomBaselines(): Promise<CustomBaselineMeta[]> {
  const rows = await prisma.setting.findMany({
    where: { key: { startsWith: KEY_PREFIX } },
    select: { key: true, value: true },
  });
  const out: CustomBaselineMeta[] = [];
  for (const row of rows) {
    const rec = parseRecord(row.key, row.value);
    if (rec) out.push({ id: rec.id, label: rec.label, createdAt: rec.createdAt, model: rec.model });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getCustomBaseline(id: string): Promise<CustomBaselineRecord | null> {
  if (!BASELINE_ID_RE.test(id)) return null;
  const row = await prisma.setting.findUnique({ where: { key: KEY_PREFIX + id } });
  if (!row) return null;
  return parseRecord(row.key, row.value);
}

export async function putCustomBaseline(rec: CustomBaselineRecord): Promise<void> {
  const value = JSON.stringify(rec);
  await prisma.setting.upsert({
    where: { key: KEY_PREFIX + rec.id },
    create: { key: KEY_PREFIX + rec.id, value },
    update: { value },
  });
}

export async function deleteCustomBaseline(id: string): Promise<boolean> {
  if (!BASELINE_ID_RE.test(id)) return false;
  const r = await prisma.setting.deleteMany({ where: { key: KEY_PREFIX + id } });
  return r.count > 0;
}

// makeBaselineID 从模型名生成安全 id：裸模型名 + MMDDHHmm（Asia/Shanghai）。
// 8 位数字后缀同时能被 pickBaselineForModel 识别为「同日快照」，下次测同一模型可自动选中。
export function makeBaselineID(model: string, taken: Set<string>): string {
  const bare = (model.includes(":") ? model.slice(model.indexOf(":") + 1) : model).trim().toLowerCase();
  const slug = bare
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 50) || "custom";
  let at = Date.now() + 8 * 3600_000;
  for (let i = 0; i < 60; i++) {
    const id = `${slug}-${stamp(at)}`;
    if (!taken.has(id) && BASELINE_ID_RE.test(id)) return id;
    at += 60_000;
  }
  return `${slug}-${Date.now().toString(36).replace(/[^a-z0-9]/g, "").slice(-6)}`;
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes());
}

// statsFromDistribution 由频率分布反推展示/匹配所需统计量。
// 众数参与匹配得分；其余字段仅用于报告展示，用分布近似足够。
export function statsFromDistribution(distribution: number[], samples?: number): Required<BaselineStats> {
  const total = distribution.reduce((s, v) => s + v, 0);
  let mean = 0, peak = -1, mode = 1, min = 0, max = 0, unique = 0;
  for (let i = 0; i < distribution.length; i++) {
    const value = i + 1;
    const p = distribution[i] / total;
    mean += value * p;
    if (distribution[i] > peak) { peak = distribution[i]; mode = value; }
    if (distribution[i] > 0) {
      if (min === 0) min = value;
      max = value;
      unique++;
    }
  }
  let variance = 0;
  for (let i = 0; i < distribution.length; i++) {
    variance += ((i + 1) - mean) ** 2 * (distribution[i] / total);
  }
  let cumulative = 0, median = 1;
  for (let i = 0; i < distribution.length; i++) {
    cumulative += distribution[i] / total;
    if (cumulative >= 0.5) { median = i + 1; break; }
  }
  const n = Math.max(0, Math.floor(samples ?? 0));
  return {
    mean,
    median,
    stdDev: Math.sqrt(variance),
    min: min || 1,
    max: max || DIST_LENGTH,
    unique,
    mode,
    modeCount: n > 0 ? Math.max(1, Math.round((peak / total) * n)) : 1,
  };
}

// buildFromDistribution 用一次真实鉴别的 355 桶频率生成基准数据。
export function buildFromDistribution(input: {
  label: string; model?: string; distribution: unknown; samples?: number;
}): { data: Baseline } | { error: string } {
  const label = cleanLabel(input.label);
  if (!label) return { error: "基准名称不能为空" };
  const distribution = cleanDistribution(input.distribution);
  if (!distribution) return { error: `distribution 必须是 ${DIST_LENGTH} 个非负数字，且总和大于 0` };
  const stats = statsFromDistribution(distribution, input.samples);
  const model = (input.model ?? "").trim().slice(0, 120);
  return {
    data: {
      name: label,
      model,
      apiType: "openai",
      timestamp: new Date().toISOString(),
      iterations: Math.max(0, Math.floor(input.samples ?? 0)),
      distribution,
      stats,
    },
  };
}

// buildFromImport 校验外部导出的基准 JSON（上游格式为单元素数组）。
export function buildFromImport(raw: unknown, label?: string): { data: Baseline } | { error: string } {
  const data = normalizeBaseline(raw);
  if (!data) return { error: "基准 JSON 结构不合法（需要 355 桶 distribution 与 stats.mean/stdDev/median）" };
  const finalLabel = cleanLabel(label ?? data.name);
  if (!finalLabel) return { error: "基准名称不能为空" };
  return { data: { ...data, name: finalLabel } };
}

export function cleanLabel(v: string): string {
  return v.trim().replace(/\s+/g, " ").slice(0, LABEL_MAX);
}

function cleanDistribution(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length !== DIST_LENGTH) return null;
  const out: number[] = [];
  let sum = 0;
  for (const v of raw) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
    out.push(v);
    sum += v;
  }
  return sum > 0 ? out : null;
}

function parseRecord(key: string, value: string): CustomBaselineRecord | null {
  const id = key.slice(KEY_PREFIX.length);
  if (!BASELINE_ID_RE.test(id)) return null;
  try {
    const rec = JSON.parse(value) as Partial<CustomBaselineRecord>;
    if (rec.id !== id || typeof rec.label !== "string" || typeof rec.createdAt !== "string") return null;
    const data = normalizeBaseline(rec.data);
    if (!data) return null;
    return { id, label: cleanLabel(rec.label) || id, createdAt: rec.createdAt, model: data.model, data };
  } catch {
    return null;
  }
}
