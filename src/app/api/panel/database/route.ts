// 数据库监控：只查询系统目录与累计值，不读取业务表内容。
import { fail, ok, panelAuth } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { dal } from "@/lib/dal";
import { clearRequestLogDialog, retentionConfig, runRetention } from "@/lib/retention";

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

function useCloudbaseRest(): boolean {
  const v = (process.env.USE_CLOUDBASE_REST ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// CloudBase PostgREST 没有 pg_catalog 访问权限：库大小/连接数/版本拿不到，
// 业务行数走各表 count（Content-Range 精确口径），其余字段以 null 占位，面板照常渲染。
async function readStatsDal(): Promise<Record<string, unknown>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const TABLES: { name: string; model: keyof typeof dal }[] = [
    { name: "Account", model: "account" },
    { name: "ApiKey", model: "apiKey" },
    { name: "Provider", model: "provider" },
    { name: "UsageEvent", model: "usageEvent" },
    { name: "RequestLog", model: "requestLog" },
    { name: "BalanceSample", model: "balanceSample" },
    { name: "Setting", model: "setting" },
    { name: "TaskQueueItem", model: "taskQueueItem" },
    { name: "ModelCooldown", model: "modelCooldown" },
    { name: "ModelHealthCheck", model: "modelHealthCheck" },
    { name: "LoginSession", model: "loginSession" },
    { name: "StickySession", model: "stickySession" },
  ];
  const tables = [] as { name: string; rows: number; totalBytes: number; dataBytes: number; indexBytes: number }[];
  for (const t of TABLES) {
    const rows = await dal[t.model].count();
    tables.push({ name: t.name, rows, totalBytes: 0, dataBytes: 0, indexBytes: 0 });
  }
  const dialogRows = await dal.requestLog.count({
    where: { OR: [{ requestMessages: { not: null } }, { responseMessage: { not: null } }] },
  }).catch(() => 0);
  const requestLogs = tables.find((t) => t.name === "RequestLog")?.rows ?? 0;
  let host = "";
  try { host = new URL(process.env.CLOUDBASE_POSTGREST_URL || "").hostname; } catch { /* ignore */ }
  const data = {
    measuredAt: new Date().toISOString(),
    cacheSeconds: CACHE_MS / 1000,
    database: {
      name: process.env.CLOUDBASE_ENV_ID ?? "cloudbase",
      host,
      version: "cloudbase-postgrest",
      bytes: 0,
      sizeGb: 0,
      limitGb: LIMIT_GB,
      percent: 0,
      requestLogs,
      dialogRows,
      activeConnections: 0,
      maxConnections: 0,
    },
    tables,
    retention: retentionConfig(),
  };
  cache = { at: Date.now(), data };
  return data;
}

async function readStats(): Promise<Record<string, unknown>> {
  if (useCloudbaseRest()) return readStatsDal();
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
    const body = await req.json() as { action?: string };
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
    return fail(400, "unknown_action");
  } catch (e) {
    return fail(500, e instanceof Error ? e.message : String(e));
  }
}
