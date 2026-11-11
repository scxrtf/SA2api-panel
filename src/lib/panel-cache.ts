// 面板服务端数据缓存：低频视图默认 1 小时，余额趋势单独缓存 60 秒。
// 多个浏览器/标签页共享同一份，刷新页面也不会丢失。
// 手动刷新通过 ?refresh=1 绕过缓存立即拉新数据。
// globalThis 防止 Next 热重载重复建缓存实例。
import { PANEL_CACHE_DEFAULT_TTL_MS, panelCacheTtlMs } from "./balance-history-cache";

interface Entry { at: number; data: unknown }
const globalForPanel = globalThis as unknown as { panelDataCache?: Map<string, Entry> };
const cache = globalForPanel.panelDataCache ?? new Map<string, Entry>();
globalForPanel.panelDataCache = cache;

const DEFAULT_TTL_MS = PANEL_CACHE_DEFAULT_TTL_MS;

export function panelCacheGet<T>(key: string, ttlMs = DEFAULT_TTL_MS): T | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at >= ttlMs) { cache.delete(key); return null; }
  return hit.data as T;
}

export function panelCacheSet(key: string, data: unknown): void {
  cache.delete(key);
  cache.set(key, { at: Date.now(), data });
}

export function panelCacheDel(keyPrefix?: string): void {
  if (!keyPrefix) { cache.clear(); return; }
  for (const k of cache.keys()) if (k.startsWith(keyPrefix)) cache.delete(k);
}

// 快照供「缓存详细」页展示。
export function panelCacheStats(): { size: number; entries: { key: string; ageMs: number; ttlMs: number }[] } {
  const now = Date.now();
  const entries: { key: string; ageMs: number; ttlMs: number }[] = [];
  for (const [k, e] of cache) {
    const ageMs = now - e.at;
    const ttlMs = panelCacheTtlMs(k);
    if (ageMs >= ttlMs) {
      cache.delete(k);
      continue;
    }
    entries.push({ key: k, ageMs, ttlMs });
  }
  return { size: entries.length, entries };
}
