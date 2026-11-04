import { Prisma } from "@prisma/client";
import type { SeriesDim, UsageAggRow } from "./usage-aggregation";

export interface UsageQuery {
  since: Date | null;
  until: Date | null;
  dayScope: boolean;
  groupDim: SeriesDim | "";
}

interface QueryRunner {
  $queryRaw<T>(query: Prisma.Sql): Promise<T>;
}

// 所有维度在同一个 SQL 中聚合。数据库只回传聚合行，避免整个 UsageEvent
// 时间窗经 Supabase → Railway 传输；过滤值仍全部由 Prisma 参数化。
export async function queryUsageAggregate(
  db: QueryRunner,
  q: UsageQuery,
): Promise<UsageAggRow[]> {
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
