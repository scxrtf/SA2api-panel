// 多个浏览器/标签页共享进程内的面板快照；各路由独立打包时仍共用同一份。
import { BALANCE_HISTORY_CACHE_MS } from "./balance-history-cache";
import { cacheAgeMs, createServerCache, type CacheLoadOptions } from "./server-cache";

export const PANEL_CACHE_DEFAULT_TTL_MS = 60 * 60_000;
export const MODEL_PROBES_CACHE_KEY = "model_probes";

export function panelCacheTtlMs(key: string): number {
  if (key.startsWith("balance_history:")) return BALANCE_HISTORY_CACHE_MS;
  if (key === MODEL_PROBES_CACHE_KEY) return 60_000;
  return PANEL_CACHE_DEFAULT_TTL_MS;
}

const MAX_ENTRIES = 64; // 30 个余额窗口 + 固定键仍有余量。
const globals = globalThis as typeof globalThis & { wb2aPanelServerCache?: ReturnType<typeof createServerCache<unknown>> };
const cache = globals.wb2aPanelServerCache ??= createServerCache<unknown>(MAX_ENTRIES, panelCacheTtlMs);

export function cachedPanelData<T>(key: string, loader: () => Promise<T>, options: CacheLoadOptions<T> = {}) {
  const { refresh, shouldCache } = options;
  const { promise, cached } = cache.load(key, loader, {
    refresh,
    shouldCache: shouldCache && ((value) => shouldCache(value as T)),
  });
  return { promise: promise as Promise<T>, cached };
}

export function panelCacheGet<T>(key: string, ttlMs = panelCacheTtlMs(key)): T | null {
  const now = Date.now();
  const hit = cache.peek(key, now);
  return hit && cacheAgeMs(hit.at, now) < ttlMs ? hit.value as T : null;
}

export function panelCacheSet(key: string, data: unknown): void {
  cache.set(key, data);
}

export function panelCacheAgeMs(key: string, now = Date.now()): number | undefined {
  const hit = cache.peek(key, now);
  return hit && cacheAgeMs(hit.at, now);
}

// 使用完整键，避免 balance_history:1 连带失效 10～19 天窗口。
export function panelCacheDel(key?: string): void {
  if (key === undefined) cache.clear();
  else cache.delete(key);
}

// 快照供「缓存详细」页展示。
export function panelCacheStats(now = Date.now()) {
  return cache.stats(now);
}
