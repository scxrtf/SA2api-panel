// 数据库监控：直连模式查询系统目录；CloudBase 模式只读少量采样行与主键。
import { fail, ok, panelAuth, verifySuperPassword } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { dal } from "@/lib/dal";
import { cbSelect } from "@/lib/cloudbase-rest";
import { getCloudbasePlatformStats } from "@/lib/cloudbase-monitor";
import { clearRequestLogDetails, clearRequestLogDialog, pruneModelHealth, pruneRequestLogs, retentionConfig, runRetention } from "@/lib/retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CACHE_MS = 60_000;
const LIMIT_GB = Number(process.env.DB_SIZE_LIMIT_GB || 5);
let cache: { at: number; data: Record<string, unknown> } | null = null;

interface StatsRow {
  database_name: string;
  database_bytes: string;
  request_logs: string;
  dialog_rows: string;
  active_connections: string;
  max_connections: string;
  server_version: string;
  tables: { name: string; rows: number; totalBytes: number; dataBytes: number; indexBytes: number }[];
}

function cloudbaseRestEnabled(): boolean {
  const v = (process.env.USE_CLOUDBASE_REST ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// 行大小采样：按主键倒序取最近 50 行，序列化字节数均值作为行长估计。
// 比固定 1KB/行 假设精确（RequestLog 带大 JSON 字段，行长可能是 UsageEvent 的数倍）。
async function sampleRowBytes(table: string, pk = "id"): Promise<number> {
  try {
    const rows = await cbSelect<Record<string, unknown>[]>(table, { select: "*", order: [{ col: pk, desc: true }], limit: 50 });
    if (!rows.length) return 0;
    const total = rows.reduce((s, r) => s + Buffer.byteLength(JSON.stringify(r), "utf8"), 0);
    return Math.round(total / rows.length);
  } catch { return 0; }
}

// 表增长速率：按时间索引分页拉时间列自数；网关的 HEAD/count=exact 实测不可用。
async function growth24h(table: string, timeCol: string): Promise<number | null> {
  try {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    let offset = 0;
    for (;;) {
      const rows = await cbSelect<unknown[]>(table, {
        select: timeCol,
        filters: [{ col: timeCol, op: "gte", val: since }],
        limit: 1000,
        offset,
      });
      if (rows.length < 1000) return offset + rows.length;
      offset += 1000;
    }
  } catch { return null; }
}

// CloudBase PostgREST 没有 pg_catalog 访问权限：库大小/连接数/版本拿不到，
// 业务行数走 DAL 主键分页计数；容量保留采样估算，平台 QPS 走 CAM 接口。
async function readStatsDal(): Promise<Record<string, unknown>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const TABLES: { name: string; model: keyof typeof dal }[] = [
    { name: "Account", model: "account" },
    { name: "AccountState", model: "accountState" },
    { name: "ApiKey", model: "apiKey" },
    { name: "Provider", model: "provider" },
    { name: "UsageEvent", model: "usageEvent" },
    { name: "RequestLog", model: "requestLog" },
    { name: "BalanceSample", model: "balanceSample" },
    { name: "Setting", model: "setting" },
    { name: "TaskQueueItem", model: "taskQueueItem" },
    { name: "ModelCooldown", model: "modelCooldown" },
    { name: "ModelCost", model: "modelCost" },
    { name: "ModelProbe", model: "modelProbe" },
    { name: "ModelHealthCheck", model: "modelHealthCheck" },
    { name: "LoginSession", model: "loginSession" },
    { name: "StickySession", model: "stickySession" },
    { name: "MachineKeyAuthorization", model: "machineKeyAuthorization" },
  ];
  const counts = await Promise.all(TABLES.map(async (t) => ({ name: t.name, rows: await dal[t.model].count() })));
  counts.sort((a, b) => b.rows - a.rows);

  // 行大小采样（并行，失败回退 1KB 假设）
  const SAMPLE_PK: Record<string, string> = { Account: "uid", AccountState: "uid", Setting: "key", StickySession: "key", ModelProbe: "key", MachineKeyAuthorization: "machineId" };
  const samples = await Promise.all(counts.map(async (c) => ({
    name: c.name,
    avgBytes: c.rows > 0 ? await sampleRowBytes(c.name, SAMPLE_PK[c.name] ?? "id") : 0,
  })));
  const sampleMap = new Map(samples.map((s) => [s.name, s.avgBytes]));

  // 增长速率（四张时间序列表）
  const GROWTH: [string, string][] = [["UsageEvent", "at"], ["RequestLog", "at"], ["BalanceSample", "at"], ["ModelHealthCheck", "checkedAt"]];
  const growthEntries = await Promise.all(GROWTH.map(async ([name, col]) => {
    return [name, await growth24h(name, col)] as const;
  }));
  const growthMap = new Map<string, number | null>(growthEntries);

  // JSON 字节采样比堆行多记字段名/JSON 语法；1.25 仅作索引与页开销的保守系数。
  const OVERHEAD = 1.25;
  const approxBytes = (name: string, rows: number) => Math.round(rows * (sampleMap.get(name) || 1024) * OVERHEAD);
  const tables = counts.map((c) => ({
    ...c,
    avgRowBytes: sampleMap.get(c.name) ?? 0,
    added24h: growthMap.get(c.name) ?? null,
    totalBytes: approxBytes(c.name, c.rows),
    dataBytes: Math.round(approxBytes(c.name, c.rows) * 0.7),
    indexBytes: Math.round(approxBytes(c.name, c.rows) * 0.3),
  }));
  const dialogRows = await dal.requestLog.count({
    where: { OR: [{ requestMessages: { not: null } }, { responseMessage: { not: null } }] },
  }).catch(() => 0);
  const requestLogs = tables.find((t) => t.name === "RequestLog")?.rows ?? 0;
  const totalBytes = tables.reduce((s, t) => s + t.totalBytes, 0);
  const platform = await getCloudbasePlatformStats();
  let host = "";
  try { host = new URL(process.env.CLOUDBASE_POSTGREST_URL || "").hostname; } catch { /* ignore */ }
  const data = {
    measuredAt: new Date().toISOString(),
    cacheSeconds: CACHE_MS / 1000,
    mode: "cloudbase",
    sizing: "sampled", // sampled = 行大小采样校准；fallback 固定假设见单表 avgRowBytes=0
    database: {
      name: process.env.CLOUDBASE_ENV_ID ?? "cloudbase",
      host,
      version: "cloudbase-postgrest",
      bytes: totalBytes,
      sizeGb: totalBytes / 1024 ** 3,
      limitGb: LIMIT_GB,
      percent: totalBytes / (LIMIT_GB * 1024 ** 3) * 100,
      requestLogs,
      dialogRows,
      activeConnections: 0,
      maxConnections: 0,
    },
    tables,
    platform,
    growth: Object.fromEntries(growthEntries),
    growthBasis: "24h",
    retention: retentionConfig(),
  };
  cache = { at: Date.now(), data };
  return data;
}

async function readStats(): Promise<Record<string, unknown>> {
  if (cloudbaseRestEnabled()) return readStatsDal();
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const rows = await prisma.$queryRaw<StatsRow[]>`
    with table_stats as (
      select c.relname as name,
             c.reltuples::bigint as rows,
             pg_total_relation_size(c.oid)::bigint as total_bytes,
             pg_relation_size(c.oid)::bigint as data_bytes,
             pg_indexes_size(c.oid)::bigint as index_bytes
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
    ), log_stats as (
      select count(*)::bigint as request_logs,
             count(*) filter (
               where "requestMessages" is not null or "responseMessage" is not null
             )::bigint as dialog_rows
        from "RequestLog"
    )
    select current_database() as database_name,
           pg_database_size(current_database())::bigint as database_bytes,
           log_stats.request_logs, log_stats.dialog_rows,
           (select count(*)::bigint from pg_stat_activity where datname = current_database()) as active_connections,
           current_setting('max_connections')::bigint as max_connections,
           current_setting('server_version') as server_version,
           (select coalesce(jsonb_agg(jsonb_build_object(
             'name', name, 'rows', rows, 'totalBytes', total_bytes,
             'dataBytes', data_bytes, 'indexBytes', index_bytes
           ) order by total_bytes desc), '[]'::jsonb) from table_stats) as tables
     from log_stats`;
  const row = rows[0];
  if (!row) throw new Error("database_stats_empty");
  const bytes = Number(row.database_bytes);
  let host = "";
  try { host = new URL(process.env.DATABASE_URL || "").hostname; } catch { /* ignore */ }
  const data = {
    measuredAt: new Date().toISOString(),
    cacheSeconds: CACHE_MS / 1000,
    mode: "direct",
    database: {
      name: row.database_name,
      host,
      version: row.server_version,
      bytes,
      sizeGb: bytes / 1024 ** 3,
      limitGb: LIMIT_GB,
      percent: bytes / (LIMIT_GB * 1024 ** 3) * 100,
      requestLogs: Number(row.request_logs),
      dialogRows: Number(row.dialog_rows),
      activeConnections: Number(row.active_connections),
      maxConnections: Number(row.max_connections),
    },
    tables: row.tables,
    retention: retentionConfig(),
  };
  cache = { at: Date.now(), data };
  return data;
}

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  try {
    if (new URL(req.url).searchParams.get("refresh") === "1") cache = null;
    return ok(await readStats());
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : String(e));
  }
}

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  try {
    const body = await req.json() as { action?: string; super_password?: unknown; olderThanHours?: unknown; days?: unknown; healthDays?: unknown };
    if (!verifySuperPassword(body.super_password)) return fail(403, "超级密码错误");
    if (body.action === "clear_dialog") {
      const cleared = await clearRequestLogDialog();
      cache = null;
      return ok({ action: body.action, cleared, stats: await readStats() });
    }
    if (body.action === "run_retention") {
      const result = await runRetention();
      cache = null;
      return ok({ action: body.action, result, stats: await readStats() });
    }
    if (body.action === "clear_details") {
      const hours = body.olderThanHours === undefined ? retentionConfig().detailHours : Number(body.olderThanHours);
      if (!Number.isInteger(hours) || hours < 0 || hours > 24 * 365) return fail(400, "详情时间范围须为 0～8760 之间的整数小时");
      const cleared = await clearRequestLogDetails(hours);
      cache = null;
      return ok({ action: body.action, cleared, stats: await readStats() });
    }
    if (body.action === "clear_expired_logs") {
      const days = body.days === undefined ? retentionConfig().days : Number(body.days);
      if (!Number.isInteger(days) || days < 1 || days > 365) return fail(400, "日志保留天数须为 1～365 之间的整数");
      const healthDays = body.healthDays === undefined ? 3 : Number(body.healthDays);
      if (!Number.isInteger(healthDays) || healthDays < 1 || healthDays > 365) return fail(400, "健康检查保留天数须为 1～365 之间的整数");
      const result = {
        rowsDeleted: await pruneRequestLogs(days),
        healthDeleted: await pruneModelHealth(healthDays),
      };
      cache = null;
      return ok({ action: body.action, result, stats: await readStats() });
    }
    return fail(400, "unknown_action");
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : String(e));
  }
}
