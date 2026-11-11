// 进程内短缓存：相同查询在 20 秒内只访问一次 Supabase；并发请求共享 Promise。
// 仅保存面板聚合结果，不含鉴权信息。globalThis 防止 Next 热重载重复建表。
interface Entry { expires: number; value: Promise<unknown> }
const globalForUsage = globalThis as unknown as { usageQueryCache?: Map<string, Entry> };
const cache = globalForUsage.usageQueryCache ?? new Map<string, Entry>();
globalForUsage.usageQueryCache = cache;
const TTL_MS = 20_000;
const MAX_ENTRIES = 64;

export function cachedUsageQuery<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value as Promise<T>;
  const value = loader();
  cache.delete(key);
  cache.set(key, { expires: now + TTL_MS, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  for (const [k, entry] of cache) {
    if (entry.expires <= now) cache.delete(k);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return value;
}

// 缓存条目快照（供面板「缓存详细」页展示）：键、剩余 TTL、是否在途。
export function usageCacheStats(): { size: number; maxEntries: number; ttlMs: number; entries: { key: string; ttlMs: number }[] } {
  const now = Date.now();
  const entries: { key: string; ttlMs: number }[] = [];
  for (const [k, e] of cache) {
    if (e.expires > now) entries.push({ key: k, ttlMs: e.expires - now });
    else cache.delete(k);
  }
  return { size: entries.length, maxEntries: MAX_ENTRIES, ttlMs: TTL_MS, entries };
}
