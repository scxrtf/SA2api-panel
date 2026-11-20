// 仅缓存面板聚合结果，不含鉴权信息。20 秒有效期自查询成功起算。
import { createServerCache } from "./server-cache";

const TTL_MS = 20_000;
const MAX_ENTRIES = 64;
const globals = globalThis as typeof globalThis & { wb2aUsageServerCache?: ReturnType<typeof createServerCache<unknown>> };
const cache = globals.wb2aUsageServerCache ??= createServerCache<unknown>(MAX_ENTRIES, () => TTL_MS);

export function cachedUsageQuery<T>(key: string, loader: () => Promise<T>, refresh = false): Promise<T> {
  return cache.load(key, loader, { refresh }).promise as Promise<T>;
}

// 状态只列出已完成且仍有效的快照，不暴露 payload。
export function usageCacheStats(now = Date.now()) {
  const { size, maxEntries, entries } = cache.stats(now);
  return { size, maxEntries, ttlMs: TTL_MS, entries: entries.map(({ key, ttlMs, ageMs }) => ({ key, ttlMs: ttlMs - ageMs })) };
}
