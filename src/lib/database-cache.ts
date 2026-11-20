// Both route handlers must observe the same cache even when Next bundles them separately.
import type { CloudbasePlatformStats } from "./cloudbase-monitor";
import { cacheAgeMs, createServerCache } from "./server-cache";

type Snapshot = Record<string, unknown>;

function createCacheSlot<T>(ttlMs: number) {
  const cache = createServerCache<T>(1, () => ttlMs);
  const key = "snapshot";
  return {
    ttlMs,
    get(now = Date.now()) { return cache.peek(key, now) ?? null; },
    set(value: T, now = Date.now()) { cache.set(key, value, now); },
    clear() { cache.delete(key); },
    load(loader: () => Promise<T>, refresh = false) { return cache.load(key, loader, { refresh }).promise; },
    remaining(now: number) {
      const entry = cache.peek(key, now);
      return entry ? ttlMs - cacheAgeMs(entry.at, now) : 0;
    },
  };
}

function createDatabaseCache() {
  return {
    stats: createCacheSlot<Snapshot>(3_600_000),
    platform: createCacheSlot<CloudbasePlatformStats | null>(60_000),
  };
}

const processCache = globalThis as typeof globalThis & { wb2aDatabaseServerCache?: ReturnType<typeof createDatabaseCache> };
export const databaseCache = processCache.wb2aDatabaseServerCache ??= createDatabaseCache();
