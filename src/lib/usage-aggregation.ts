import { currentModelRate } from "@/lib/upstream/modelCatalog";

export type SeriesDim = "key" | "model" | "account" | "provider" | "realm";

export interface UsageAggRow {
  dimension: string;
  key: string;
  realm: string;
  extra: string;
  bucket: string;
  eventAt: Date | string | null;
  requests: number | string | bigint;
  errors: number | string | bigint;
  prompt: number | string | bigint;
  completion: number | string | bigint;
  total: number | string | bigint;
  credit: number | string;
  creditSamples: number | string | bigint;
  creditTokens: number | string | bigint;
  cacheHit: number | string | bigint;
  cacheMiss: number | string | bigint;
  latSum: number | string | bigint;
  latSamples: number | string | bigint;
  tpsSum: number | string;
  tpsSamples: number | string | bigint;
}

export interface Agg {
  requests: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  credits: number;
  credit_samples: number;
  credit_tokens: number;
  credits_per_1m_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  cache_hit_rate: number;
  avg_latency_ms: number;
  avg_tokens_per_second: number;
}

interface KeyedAgg { key: string; realm?: string; extra?: string; agg: Agg }
interface CreditAgg {
  key: string; realm?: string; nickname?: string; rate?: string;
  requests: number; credits: number; credit_samples: number; credit_tokens: number;
  credits_per_1m_tokens: number;
  cache_hit_tokens: number; cache_miss_tokens: number; cache_hit_rate: number;
}

const num = (v: number | string | bigint): number => Number(v);
// PostgreSQL text 拒绝 NUL；chr(1) 只在数据库内临时拼接，返回前端前还原。
const chrPlaceholder = String.fromCharCode(1);

export class AggAcc {
  requests = 0; errors = 0;
  prompt = 0; completion = 0; total = 0;
  credits = 0; creditSamples = 0; creditTokens = 0;
  cacheHit = 0; cacheMiss = 0;
  latSum = 0; latSamples = 0;
  tpsSum = 0; tpsSamples = 0;

  add(r: UsageAggRow): void {
    this.requests += num(r.requests);
    this.errors += num(r.errors);
    this.prompt += num(r.prompt);
    this.completion += num(r.completion);
    this.total += num(r.total);
    this.credits += num(r.credit);
    this.creditSamples += num(r.creditSamples);
    this.creditTokens += num(r.creditTokens);
    this.cacheHit += num(r.cacheHit);
    this.cacheMiss += num(r.cacheMiss);
    this.latSum += num(r.latSum);
    this.latSamples += num(r.latSamples);
    this.tpsSum += num(r.tpsSum);
    this.tpsSamples += num(r.tpsSamples);
  }

  finish(): Agg {
    return {
      requests: this.requests,
      errors: this.errors,
      prompt_tokens: this.prompt,
      completion_tokens: this.completion,
      total_tokens: this.total,
      credits: this.credits,
      credit_samples: this.creditSamples,
      credit_tokens: this.creditTokens,
      credits_per_1m_tokens: this.creditTokens > 0 ? this.credits / this.creditTokens * 1_000_000 : 0,
      cache_hit_tokens: this.cacheHit,
      cache_miss_tokens: this.cacheMiss,
      cache_hit_rate: this.cacheHit + this.cacheMiss > 0 ? this.cacheHit / (this.cacheHit + this.cacheMiss) * 100 : 0,
      avg_latency_ms: this.latSamples > 0 ? this.latSum / this.latSamples : 0,
      avg_tokens_per_second: this.tpsSamples > 0 ? this.tpsSum / this.tpsSamples : 0,
    };
  }
}

class CreditAcc {
  requests = 0; credits = 0; samples = 0; tokens = 0;
  cacheHit = 0; cacheMiss = 0;
  add(r: UsageAggRow): void {
    this.requests += num(r.requests);
    this.credits += num(r.credit);
    this.samples += num(r.creditSamples);
    this.tokens += num(r.creditTokens);
    this.cacheHit += num(r.cacheHit);
    this.cacheMiss += num(r.cacheMiss);
  }
  finish(key: string, rate = ""): CreditAgg {
    return {
      key, rate,
      requests: this.requests,
      credits: this.credits,
      credit_samples: this.samples,
      credit_tokens: this.tokens,
      credits_per_1m_tokens: this.tokens > 0 ? this.credits / this.tokens * 1_000_000 : 0,
      cache_hit_tokens: this.cacheHit,
      cache_miss_tokens: this.cacheMiss,
      cache_hit_rate: this.cacheHit + this.cacheMiss > 0 ? this.cacheHit / (this.cacheHit + this.cacheMiss) * 100 : 0,
    };
  }
}

function rowsFor(rows: UsageAggRow[], dimension: string): UsageAggRow[] {
  return rows.filter((r) => r.dimension === dimension);
}

function keyed(rows: UsageAggRow[], dimension: string): KeyedAgg[] {
  return rowsFor(rows, dimension).map((r) => {
    const acc = new AggAcc(); acc.add(r);
    return {
      key: r.key.replaceAll(chrPlaceholder, "\x00"),
      ...(r.realm ? { realm: r.realm } : {}),
      ...(r.extra ? { extra: r.extra } : {}),
      agg: acc.finish(),
    };
  }).sort((a, b) =>
    b.agg.total_tokens - a.agg.total_tokens ||
    b.agg.requests - a.agg.requests ||
    a.key.localeCompare(b.key),
  );
}

function composite(rows: UsageAggRow[], dimension: string): KeyedAgg[] {
  return keyed(rows, dimension).sort((a, b) =>
    (a.realm ?? "").localeCompare(b.realm ?? "") ||
    b.agg.total_tokens - a.agg.total_tokens ||
    a.key.localeCompare(b.key),
  );
}

function credits(rows: UsageAggRow[], dimension: string): CreditAgg[] {
  return rowsFor(rows, dimension).map((r) => {
    const acc = new CreditAcc(); acc.add(r);
    return acc.finish(r.key.replaceAll(chrPlaceholder, "\x00"), r.extra);
  }).sort((a, b) => b.credits - a.credits || b.credit_tokens - a.credit_tokens || a.key.localeCompare(b.key));
}

function creditModels(rows: UsageAggRow[]): CreditAgg[] {
  const merged = new Map<string, CreditAcc>();
  for (const r of rowsFor(rows, "credit_by_model")) {
    // 空倍率使用当前目录回填；供应商记录保持空倍率，与原接口一致。
    const rate = r.extra || (r.realm.startsWith("provider:") ? "" : currentModelRate(r.realm, canonicalModel(r.key)));
    const key = r.key + "\x00" + rate;
    if (!merged.has(key)) merged.set(key, new CreditAcc());
    merged.get(key)!.add(r);
  }
  return [...merged.entries()].map(([k, acc]) => {
    const split = k.indexOf("\x00");
    return acc.finish(k.slice(0, split), k.slice(split + 1));
  }).sort((a, b) => b.credits - a.credits || b.credit_tokens - a.credit_tokens || a.key.localeCompare(b.key));
}

function timestamp(bucket: string, dayScope: boolean): number {
  return Date.parse(dayScope ? bucket + "T00:00:00+08:00" : bucket + ":00:00+08:00");
}

function point(r: UsageAggRow, dayScope: boolean) {
  const acc = new AggAcc(); acc.add(r);
  return {
    t: timestamp(r.bucket, dayScope),
    scope: dayScope ? "day" : "hour",
    label: r.bucket.slice(5),
    ...acc.finish(),
  };
}

function first(rows: UsageAggRow[], dimension: string): Agg {
  const acc = new AggAcc();
  const row = rows.find((r) => r.dimension === dimension);
  if (row) acc.add(row);
  return acc.finish();
}

export interface SnapshotOptions {
  dayScope: boolean;
  groupDim: SeriesDim | "";
  windowFrom: string;
  windowTo: string;
  generated?: Date;
}

export function buildUsageSnapshot(
  rows: UsageAggRow[],
  nicks: Map<string, string>,
  options: SnapshotOptions,
) {
  const byAccount = keyed(rows, "by_account");
  for (const row of byAccount) row.extra = nicks.get(row.key) ?? "";
  const creditByAccount = credits(rows, "credit_by_account");
  for (const row of creditByAccount) row.nickname = nicks.get(row.key) ?? "";
  const series = rowsFor(rows, "series")
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map((r) => point(r, options.dayScope));

  let seriesGroup: unknown = null;
  if (options.groupDim) {
    const groups = new Map<string, {
      key: string; label: string; realm?: string; rows: UsageAggRow[];
    }>();
    for (const r of rowsFor(rows, "series_group")) {
      if (!groups.has(r.key)) {
        groups.set(r.key, {
          key: r.key,
          label: options.groupDim === "account" ? nicks.get(r.key) || r.key.slice(0, 8) || "(未知)" : r.key,
          ...(r.realm ? { realm: r.realm } : {}),
          rows: [],
        });
      }
      groups.get(r.key)!.rows.push(r);
    }
    seriesGroup = {
      dim: options.groupDim,
      scope: options.dayScope ? "day" : "hour",
      groups: [...groups.values()].map((g) => {
        const points = g.rows.sort((a, b) => a.bucket.localeCompare(b.bucket))
          .map((r) => point(r, options.dayScope));
        return {
          key: g.key,
          label: g.label,
          realm: g.realm,
          prompt_tokens: points.reduce((n, p) => n + p.prompt_tokens, 0),
          completion_tokens: points.reduce((n, p) => n + p.completion_tokens, 0),
          total_tokens: points.reduce((n, p) => n + p.total_tokens, 0),
          requests: points.reduce((n, p) => n + p.requests, 0),
          points,
        };
      }).sort((a, b) =>
        b.total_tokens - a.total_tokens || b.requests - a.requests || a.label.localeCompare(b.label),
      ),
    };
  }

  const totalRow = rows.find((r) => r.dimension === "totals");
  const since = totalRow?.eventAt ? new Date(totalRow.eventAt).toISOString() : "";
  return {
    totals: first(rows, "totals"),
    provider_totals: first(rows, "provider_totals"),
    by_realm: keyed(rows, "by_realm"),
    by_account: byAccount,
    by_model: keyed(rows, "by_model"),
    by_key: keyed(rows, "by_key"),
    by_pool_model: keyed(rows, "by_pool_model"),
    by_pool_key: keyed(rows, "by_pool_key"),
    by_pool_key_model: composite(rows, "by_pool_key_model"),
    by_provider: keyed(rows, "by_provider"),
    by_provider_model: composite(rows, "by_provider_model"),
    by_key_model: composite(rows, "by_key_model"),
    credit_by_account: creditByAccount,
    credit_by_model: creditModels(rows),
    credit_by_key: credits(rows, "credit_by_key"),
    series,
    series_group: seriesGroup,
    buckets: first(rows, "totals").requests,
    since,
    window_from: options.windowFrom,
    window_to: options.windowTo,
    generated: (options.generated ?? new Date()).toISOString(),
  };
}

function canonicalModel(model: string): string {
  const trimmed = model.trim();
  const withoutRealm = trimmed.replace(/^(cn:|global:)/, "");
  return withoutRealm || "（未知模型）";
}
