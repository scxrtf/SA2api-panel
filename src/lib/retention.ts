// 数据库保留策略（retention）。
//
// 背景：RequestLog 每行会带 requestMessages/responseMessage/attemptDetails/
// parameterOverrides 四个 JSON 大字段（单行上限约数百 KB），TOAST 增长远快于堆，
// 免费档 Supabase 磁盘很容易被吃满并触发平台级只读（default_transaction_read_only=on）。
// 因此分两步收口：
//   1) 超过 detail 窗口的老行，清空 4 个 JSON 字段与 errorDetail（保留统计列，面板仍可看用量）；
//   2) 超过 retention 天的行整行删除。
// 两者都按批处理（原生 SQL + LIMIT），避免长事务与一次性 TOAST 抖动。
// 之后由 autovacuum 回收；如需立即还盘，手工执行 VACUUM (FULL)。
import { prisma } from "./db";
import { runlog } from "./runlog";

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_DETAIL_HOURS = 24;
const BATCH = 500;

function envNum(name: string, fallback: number, min: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function retentionConfig() {
  return {
    days: envNum("REQUEST_LOG_RETENTION_DAYS", DEFAULT_RETENTION_DAYS, 1),
    detailHours: envNum("REQUEST_LOG_DETAIL_HOURS", DEFAULT_DETAIL_HOURS, 0),
  };
}

export interface RetentionResult {
  detailCleared: number;
  rowsDeleted: number;
  healthDeleted: number;
  durationMs: number;
}

// 清空老行的详情大字段。返回处理行数。
export async function clearRequestLogDetails(
  olderThanHours = retentionConfig().detailHours,
  batch = BATCH,
  maxRounds = 200,
): Promise<number> {
  if (olderThanHours <= 0) return 0;
  let cleared = 0;
  try {
    for (let round = 0; round < maxRounds; round++) {
      const n = await prisma.$executeRaw`
        update "RequestLog"
           set "requestMessages" = null,
               "responseMessage" = null,
               "attemptDetails" = null,
               "parameterOverrides" = null,
               "errorDetail" = ''
         where ctid in (
           select ctid from "RequestLog"
            where "at" < (now() - make_interval(hours => ${olderThanHours}::int))
              and (
                "requestMessages" is not null
                or "responseMessage" is not null
                or "attemptDetails" is not null
                or "parameterOverrides" is not null
                or "errorDetail" <> ''
              )
            limit ${batch}::int
         )`;
      cleared += n;
      if (n < batch) break;
    }
    if (cleared > 0) runlog("retention: 清空 " + cleared + " 条老日志详情");
  } catch (e) {
    runlog("retention clearDetail failed: " + (e instanceof Error ? e.message : String(e)));
  }
  return cleared;
}

// 删除超过保留天数的日志行。
export async function pruneRequestLogs(
  days = retentionConfig().days,
  batch = 2000,
  maxRounds = 200,
): Promise<number> {
  let deleted = 0;
  try {
    for (let round = 0; round < maxRounds; round++) {
      const n = await prisma.$executeRaw`
        delete from "RequestLog"
         where ctid in (
           select ctid from "RequestLog"
            where "at" < (now() - make_interval(days => ${days}::int))
            limit ${batch}::int
         )`;
      deleted += n;
      if (n < batch) break;
    }
    if (deleted > 0) runlog("retention: 删除 " + deleted + " 条过期日志（>" + days + " 天）");
  } catch (e) {
    runlog("retention prune failed: " + (e instanceof Error ? e.message : String(e)));
  }
  return deleted;
}

// 模型健康检查的保留天数（配合 modelhealth 的清理，避免 30 天 × 全模型 × 高频探测堆积）。
export async function pruneModelHealth(
  days = envNum("MODEL_HEALTH_RETENTION_DAYS", 3, 1),
): Promise<number> {
  try {
    const r = await prisma.modelHealthCheck.deleteMany({
      where: { checkedAt: { lt: new Date(Date.now() - days * 24 * 3600_000) } },
    });
    if (r.count > 0) runlog("retention: 删除 " + r.count + " 条过期健康检查（>" + days + " 天）");
    return r.count;
  } catch (e) {
    runlog("retention health failed: " + (e instanceof Error ? e.message : String(e)));
    return 0;
  }
}

// 一次性跑完整保留策略。
export async function runRetention(): Promise<RetentionResult> {
  const started = Date.now();
  const cfg = retentionConfig();
  const detailCleared = await clearRequestLogDetails(cfg.detailHours);
  const rowsDeleted = await pruneRequestLogs(cfg.days);
  const healthDeleted = await pruneModelHealth();
  const result = { detailCleared, rowsDeleted, healthDeleted, durationMs: Date.now() - started };
  runlog(
    "retention 完成: 清详情 " + detailCleared + " · 删日志 " + rowsDeleted +
    " · 删健康检查 " + healthDeleted + " · " + result.durationMs + "ms",
  );
  return result;
}
