import { Prisma } from "@prisma/client";
import type { SeriesDim, UsageAggRow } from "./usage-aggregation";
import { dal } from "./dal";

export interface UsageQuery {
  since: Date | null;
  until: Date | null;
  dayScope: boolean;
  groupDim: SeriesDim | "";
}

interface QueryRunner {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
}

function useCloudbaseRest(): boolean {
  const v = (process.env.USE_CLOUDBASE_REST ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// ─── CloudBase 应用层聚合 ────────────────────────────────────────────────
// PostgREST 没有 GROUP BY / UNION；拉窗口行到 Node 端按同一口径聚合。
// 实测窗口行数（7d≈5.4k、24h≈3k）在可承受范围；usage 路由本就有 20s TTL 缓存。

type RawUsageRow = {
  id: string; at: Date; uid: string; model: string; realm: string; provider: string;
  promptTokens: number; completionTok: number; totalTokens: number; credit: number;
  hasCredit: boolean; cacheHitTok: number; cacheMissTok: number; latencyMs: number;
  tps: number; keyName: string; modelRate: string; ok: boolean;
};

function shanghaiBucket(at: Date, dayScope: boolean): string {
  const t = new Date(at.getTime() + 8 * 3600_000); // 转 Asia/Shanghai 墙钟
  const y = t.getUTCFullYear(), m = String(t.getUTCMonth() + 1).padStart(2, "0"), d = String(t.getUTCDate()).padStart(2, "0");
  if (dayScope) return `${y}-${m}-${d}`;
  return `${y}-${m}-${d}T${String(t.getUTCHours()).padStart(2, "0")}`;
}

class Sums {
  requests = 0; errors = 0; prompt = 0; completion = 0; total = 0; credit = 0;
  creditSamples = 0; creditTokens = 0; cacheHit = 0; cacheMiss = 0;
  latSum = 0; latSamples = 0; tpsSum = 0; tpsSamples = 0;
  add(r: RawUsageRow): void {
    this.requests++;
    if (!r.ok) this.errors++;
    this.prompt += r.promptTokens; this.completion += r.completionTok; this.total += r.totalTokens;
    if (r.hasCredit) { this.credit += r.credit; this.creditSamples++; this.creditTokens += r.totalTokens; }
    this.cacheHit += r.cacheHitTok; this.cacheMiss += r.cacheMissTok;
    if (r.latencyMs > 0) { this.latSum += r.latencyMs; this.latSamples++; }
    if (r.tps > 0) { this.tpsSum += r.tps; this.tpsSamples++; }
  }
  row(dimension: string, key: string, realm: string, extra: string, bucket: string, eventAt: Date | null): UsageAggRow {
    return {
      dimension, key, realm, extra, bucket, eventAt,
      requests: this.requests, errors: this.errors, prompt: this.prompt, completion: this.completion,
      total: this.total, credit: this.credit, creditSamples: this.creditSamples, creditTokens: this.creditTokens,
      cacheHit: this.cacheHit, cacheMiss: this.cacheMiss,
      latSum: this.latSum, latSamples: this.latSamples, tpsSum: this.tpsSum, tpsSamples: this.tpsSamples,
    };
  }
}

function creditRow(dimension: string, key: string, realm: string, extra: string, s: Sums): UsageAggRow {
  return {
    dimension, key, realm, extra, bucket: "", eventAt: null,
    requests: s.requests, errors: 0, prompt: 0, completion: 0, total: 0,
    credit: s.credit, creditSamples: s.creditSamples, creditTokens: s.creditTokens,
    cacheHit: s.cacheHit, cacheMiss: s.cacheMiss,
    latSum: 0, latSamples: 0, tpsSum: 0, tpsSamples: 0,
  };
}

async function queryUsageAggregateDal(q: UsageQuery): Promise<UsageAggRow[]> {
  const where: Record<string, unknown> = {};
  if (q.since || q.until) {
    const at: Record<string, string> = {};
    if (q.since) at.gte = q.since.toISOString();
    if (q.until) at.lte = q.until.toISOString();
    where.at = at;
  }
  const rows = await dal.usageEvent.findMany({ where }) as unknown as RawUsageRow[];
  const out: UsageAggRow[] = [];
  const grp = <T>(fn: (r: RawUsageRow) => string, filter: (r: RawUsageRow) => boolean, dimension: string, keyOf: (r: RawUsageRow) => [string, string, string], bucket = false) => {
    const m = new Map<string, Sums>();
    const meta = new Map<string, [string, string, string]>();
    for (const r of rows) {
      if (!filter(r)) continue;
      const k = fn(r) + (bucket ? "|" + shanghaiBucket(r.at, q.dayScope) : "");
      let s = m.get(k); if (!s) { s = new Sums(); m.set(k, s); meta.set(k, keyOf(r)); }
      s.add(r);
    }
    for (const [k, s] of m) {
      const [key, realm, extra] = meta.get(k)!;
      const b = bucket ? k.split("|").pop()! : "";
      out.push(s.row(dimension, key, realm, extra, b, null));
    }
  };
  const norm = (r: RawUsageRow) => ({
    realm: r.realm || "cn",
    model: (r.model || "").trim() || "（未知模型）",
    canonical: (r.model || "").trim().replace(/^(cn:|global:)/, ""),
    key: (r.keyName || "").trim() || "(未知)",
    provider: r.realm?.startsWith("provider:") ? r.realm.slice(9) : (r.provider || ""),
  });
  // totals / provider_totals
  const tot = new Sums(); const prov = new Sums();
  let minAt: Date | null = null;
  for (const r of rows) {
    tot.add(r);
    if (norm(r).provider) prov.add(r);
    if (!minAt || r.at < minAt) minAt = r.at;
  }
  out.push(tot.row("totals", "", "", "", "", minAt));
  out.push(prov.row("provider_totals", "", "", "", "", null));
  // by_realm / by_account / by_model / by_key / by_pool_model / by_pool_key / by_pool_key_model / by_provider / by_provider_model / by_key_model
  grp(r => norm(r).realm, () => true, "by_realm", r => [norm(r).realm, "", ""]);
  grp(r => r.uid, () => true, "by_account", r => [r.uid, norm(r).realm, ""]);
  grp(r => norm(r).model, () => true, "by_model", r => [norm(r).model, "", ""]);
  grp(r => norm(r).key, () => true, "by_key", r => [norm(r).key, norm(r).realm, ""]);
  grp(r => norm(r).model, r => !norm(r).provider, "by_pool_model", r => [norm(r).model, "", ""]);
  grp(r => norm(r).key, r => !norm(r).provider, "by_pool_key", r => [norm(r).key, "", ""]);
  grp(r => norm(r).key + "" + norm(r).model, r => !norm(r).provider, "by_pool_key_model", r => [norm(r).key + "" + norm(r).model, norm(r).key, norm(r).model]);
  grp(r => norm(r).provider, r => !!norm(r).provider, "by_provider", r => [norm(r).provider, "", ""]);
  grp(r => norm(r).provider + ":" + norm(r).canonical, r => !!norm(r).provider, "by_provider_model", r => [norm(r).provider + ":" + norm(r).canonical, norm(r).provider, norm(r).canonical]);
  grp(r => norm(r).key + "" + norm(r).model, () => true, "by_key_model", r => [norm(r).key + "" + norm(r).model, norm(r).key, norm(r).model]);
  // credit_by_account / credit_by_model / credit_by_key
  const cred = (dimension: string, fn: (r: RawUsageRow) => string, keyOf: (r: RawUsageRow) => [string, string, string]) => {
    const m = new Map<string, Sums>();
    const meta = new Map<string, [string, string, string]>();
    for (const r of rows) {
      if (!r.hasCredit) continue;
      const k = fn(r);
      let s = m.get(k); if (!s) { s = new Sums(); m.set(k, s); meta.set(k, keyOf(r)); }
      s.add(r);
    }
    for (const [k, s] of m) { const [key, realm, extra] = meta.get(k)!; out.push(creditRow(dimension, key, realm, extra, s)); }
  };
  cred("credit_by_account", r => r.uid, r => [r.uid, "", ""]);
  cred("credit_by_model", r => norm(r).canonical + "|" + norm(r).realm + "|" + (r.modelRate || ""), r => [norm(r).canonical, norm(r).realm, r.modelRate || ""]);
  cred("credit_by_key", r => norm(r).key, r => [norm(r).key, "", ""]);
  // series / series_group
  grp(() => "", () => true, "series", () => ["", "", ""], true);
  if (q.groupDim) {
    const dimKey = (r: RawUsageRow): string => {
      const n = norm(r);
      return q.groupDim === "key" ? n.key : q.groupDim === "model" ? n.model : q.groupDim === "account" ? r.uid : q.groupDim === "provider" ? n.provider || "内置池" : n.realm;
    };
    grp(dimKey, () => true, "series_group", r => [dimKey(r), norm(r).realm, ""], true);
  }
  return out;
}

// 所有维度在同一个 SQL 中聚合。数据库只回传聚合行，避免整个 UsageEvent
// 时间窗经 Supabase → Railway 传输；过滤值仍全部由 Prisma 参数化。
// CloudBase 通道（USE_CLOUDBASE_REST=1）走应用层聚合（queryUsageAggregateDal），
// 同一响应契约；db 参数在该通道下被忽略。
export async function queryUsageAggregate(
  db: QueryRunner,
  q: UsageQuery,
): Promise<UsageAggRow[]> {
  if (useCloudbaseRest()) return queryUsageAggregateDal(q);
  // UsageEvent."at" 是 timestamp without time zone，Prisma 按 UTC 写入墙钟。
  // 先 AT TIME ZONE 'UTC' 还原成带时区时刻，再转 Asia/Shanghai，
  // 否则 to_char 会按会话时区（Supabase 默认 UTC）渲染，导致小时桶整体早 8 小时。
  const bucket = q.dayScope
    ? `to_char(("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')`
    : `to_char(("at" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD"T"HH24')`;
  const sums = `
    count(*)::bigint AS requests,
    count(*) FILTER (WHERE NOT "ok")::bigint AS errors,
    COALESCE(sum("promptTokens"), 0)::bigint AS prompt,
    COALESCE(sum("completionTok"), 0)::bigint AS completion,
    COALESCE(sum("totalTokens"), 0)::bigint AS total,
    COALESCE(sum("credit") FILTER (WHERE "hasCredit"), 0)::float8 AS credit,
    count(*) FILTER (WHERE "hasCredit")::bigint AS "creditSamples",
    COALESCE(sum("totalTokens") FILTER (WHERE "hasCredit"), 0)::bigint AS "creditTokens",
    COALESCE(sum("cacheHitTok"), 0)::bigint AS "cacheHit",
    COALESCE(sum("cacheMissTok"), 0)::bigint AS "cacheMiss",
    COALESCE(sum("latencyMs") FILTER (WHERE "latencyMs" > 0), 0)::bigint AS "latSum",
    count(*) FILTER (WHERE "latencyMs" > 0)::bigint AS "latSamples",
    COALESCE(sum("tps") FILTER (WHERE "tps" > 0), 0)::float8 AS "tpsSum",
    count(*) FILTER (WHERE "tps" > 0)::bigint AS "tpsSamples"`;
  const creditSums = `
    count(*)::bigint AS requests,
    0::bigint AS errors,
    0::bigint AS prompt,
    0::bigint AS completion,
    0::bigint AS total,
    COALESCE(sum("credit"), 0)::float8 AS credit,
    count(*)::bigint AS "creditSamples",
    COALESCE(sum("totalTokens"), 0)::bigint AS "creditTokens",
    COALESCE(sum("cacheHitTok"), 0)::bigint AS "cacheHit",
    COALESCE(sum("cacheMissTok"), 0)::bigint AS "cacheMiss",
    0::bigint AS "latSum",
    0::bigint AS "latSamples",
    0::float8 AS "tpsSum",
    0::bigint AS "tpsSamples"`;
  const groupKey = q.groupDim === "key" ? "key_name"
    : q.groupDim === "model" ? "model_name"
      : q.groupDim === "account" ? '"uid"'
        : q.groupDim === "provider" ? `COALESCE(NULLIF(provider_name, ''), '内置池')`
          : "realm_name";
  const groupKeySql = Prisma.raw(groupKey);
  const seriesGroup = q.groupDim ? Prisma.sql`
    UNION ALL
    SELECT 'series_group', ${groupKeySql} AS key,
      (array_agg(realm_name ORDER BY "at" ASC, "id" ASC))[1] AS realm,
      '' AS extra, bucket, NULL::timestamptz AS "eventAt", ${Prisma.raw(sums)}
    FROM normalized GROUP BY ${groupKeySql}, bucket
  ` : Prisma.empty;

  return db.$queryRaw<UsageAggRow[]>(Prisma.sql`
    WITH filtered AS NOT MATERIALIZED (
      SELECT "id", "at", "uid", "model", "realm", "provider", "promptTokens",
        "completionTok", "totalTokens", "credit", "hasCredit", "cacheHitTok",
        "cacheMissTok", "latencyMs", "tps", "keyName", "modelRate", "ok"
      FROM "UsageEvent"
      WHERE (${q.since}::timestamptz IS NULL
          OR "at" >= (${q.since}::timestamptz AT TIME ZONE 'UTC'))
        AND (${q.until}::timestamptz IS NULL
          OR "at" <= (${q.until}::timestamptz AT TIME ZONE 'UTC'))
    ), normalized AS (
      SELECT filtered.*,
        COALESCE(NULLIF("realm", ''), 'cn') AS realm_name,
        COALESCE(NULLIF(btrim("model"), ''), '（未知模型）') AS model_name,
        regexp_replace(btrim(COALESCE("model", '')), '^(cn:|global:)', '') AS canonical_model,
        COALESCE(NULLIF("keyName", ''), '(未知)') AS key_name,
        COALESCE(
          CASE WHEN COALESCE("realm", '') LIKE 'provider:%' THEN substring("realm" from 10) ELSE NULL END,
          NULLIF("provider", ''), ''
        ) AS provider_name,
        ${Prisma.raw(bucket)} AS bucket
      FROM filtered
    )
    SELECT 'totals' AS dimension, '' AS key, '' AS realm, '' AS extra, '' AS bucket,
      min("at") AT TIME ZONE 'UTC' AS "eventAt", ${Prisma.raw(sums)} FROM normalized
    UNION ALL
    SELECT 'provider_totals', '', '', '', '', NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized WHERE provider_name <> ''
    UNION ALL
    SELECT 'by_realm', realm_name, '', '', '', NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized GROUP BY realm_name
    UNION ALL
    SELECT 'by_account', "uid", (array_agg(realm_name ORDER BY "at" ASC, "id" ASC))[1], '', '', NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized GROUP BY "uid"
    UNION ALL
    SELECT 'by_model', model_name, '', '', '', NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized GROUP BY model_name
    UNION ALL
    SELECT 'by_key', key_name, (array_agg(realm_name ORDER BY "at" ASC, "id" ASC))[1], '', '', NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized GROUP BY key_name
    UNION ALL
    SELECT 'by_pool_model', model_name, '', '', '', NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized WHERE provider_name = '' GROUP BY model_name
    UNION ALL
    SELECT 'by_pool_key', key_name, '', '', '', NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized WHERE provider_name = '' GROUP BY key_name
    UNION ALL
    SELECT 'by_pool_key_model', key_name || chr(1) || model_name, key_name, model_name, '', NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized WHERE provider_name = '' GROUP BY key_name, model_name
    UNION ALL
    SELECT 'by_provider', provider_name, '', '', '', NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized WHERE provider_name <> '' GROUP BY provider_name
    UNION ALL
    SELECT 'by_provider_model', provider_name || ':' || canonical_model, provider_name, canonical_model, '', NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized WHERE provider_name <> '' GROUP BY provider_name, canonical_model
    UNION ALL
    SELECT 'by_key_model', key_name || chr(1) || model_name, key_name, model_name, '', NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized GROUP BY key_name, model_name
    UNION ALL
    SELECT 'credit_by_account', "uid", '', '', '', NULL::timestamptz, ${Prisma.raw(creditSums)}
      FROM normalized WHERE "hasCredit" GROUP BY "uid"
    UNION ALL
    SELECT 'credit_by_model', canonical_model, realm_name, COALESCE("modelRate", ''), '', NULL::timestamptz, ${Prisma.raw(creditSums)}
      FROM normalized WHERE "hasCredit" GROUP BY canonical_model, realm_name, COALESCE("modelRate", '')
    UNION ALL
    SELECT 'credit_by_key', key_name, '', '', '', NULL::timestamptz, ${Prisma.raw(creditSums)}
      FROM normalized WHERE "hasCredit" GROUP BY key_name
    UNION ALL
    SELECT 'series', '', '', '', bucket, NULL::timestamptz, ${Prisma.raw(sums)}
      FROM normalized GROUP BY bucket
    ${seriesGroup}
  `);
}
