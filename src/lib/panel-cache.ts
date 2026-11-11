// 面板服务端数据缓存：积分构成 / 余额趋势 / 模型目录 / 探测历史 / 基准列表
// 这类变化频率低的数据在服务端进程内缓存 1 小时，多个浏览器/标签页共享同一份，
// 刷新页面也不会丢失。手动刷新通过 ?refresh=1 绕过缓存立即拉新数据。
// globalThis 防止 Next 热重载重复建缓存实例。
interface Entry { at: number; data: unknown }
const globalForPanel = globalThis as unknown as { panelDataCache?: Map<string, Entry> };
const cache = globalForPanel.panelDataCache ?? new Map<string, Entry>();
globalForPanel.panelDataCache = cache;

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 小时

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
export function panelCacheStats(): { size: number; entries: { key: string; ageMs: number }[] } {
  const now = Date.now();
  const entries: { key: string; ageMs: number }[] = [];
  for (const [k, e] of cache) entries.push({ key: k, ageMs: now - e.at });
  return { size: entries.length, entries };
}
