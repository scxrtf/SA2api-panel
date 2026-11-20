import { databaseCache } from "./database-cache";
import { PANEL_CACHE_DEFAULT_TTL_MS, panelCacheStats } from "./panel-cache";
import { usageCacheStats } from "./usage-cache";

export interface CacheLayer {
  id: string;
  name: string;
  scope: string;
  ttlMs: number;
  maxEntries: number | null;
  size: number;
  entries: { key: string; ttlMs: number; configuredTtlMs: number }[];
  note: string;
  visible: boolean;
  cached?: boolean;
  remainingMs?: number;
}

export interface CacheStatusSnapshot {
  at: number;
  layers: CacheLayer[];
}

function singletonLayer(id: string, name: string, note: string, ttlMs: number, remainingMs: number): CacheLayer {
  const cached = remainingMs > 0;
  return {
    id, name, note, ttlMs, remainingMs, cached, maxEntries: 1,
    scope: "服务端进程内", visible: true, size: cached ? 1 : 0,
    entries: cached ? [{ key: id, ttlMs: remainingMs, configuredTtlMs: ttlMs }] : [],
  };
}

export function readCacheStatus(at = Date.now()): CacheStatusSnapshot {
  const panel = panelCacheStats(at);
  const usage = usageCacheStats(at);
  const { stats, platform } = databaseCache;
  const platformNote = platform.get(at)?.value === null
    ? "当前缓存的是空结果，下次取数将在到期后重试。"
    : "CloudBase 模式下的平台 QPS 与资源趋势。";

  return {
    at,
    layers: [
      {
        id: "panel-data", name: "面板数据", scope: "服务端进程内",
        ttlMs: PANEL_CACHE_DEFAULT_TTL_MS, maxEntries: panel.maxEntries, size: panel.size, visible: true,
        entries: panel.entries.map(({ key, ageMs, ttlMs }) => ({
          key, ttlMs: ttlMs - ageMs, configuredTtlMs: ttlMs,
        })),
        note: "模型目录、积分构成、模型鉴别；余额趋势和模型探测采用 60 秒有效期。",
      },
      {
        id: "usage-aggregation", name: "用量聚合", scope: "服务端进程内",
        ttlMs: usage.ttlMs, maxEntries: usage.maxEntries, size: usage.size, visible: true,
        entries: usage.entries.map((entry) => ({ ...entry, configuredTtlMs: usage.ttlMs })),
        note: "相同查询复用结果，在途查询共享同一个任务。",
      },
      singletonLayer("database:stats", "数据库监控", "表行数、容量与日志保留统计。", stats.ttlMs, stats.remaining(at)),
      singletonLayer("database:platform", "平台趋势", platformNote, platform.ttlMs, platform.remaining(at)),
    ],
  };
}
