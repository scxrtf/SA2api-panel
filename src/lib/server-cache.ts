interface Entry<T> {
  at: number;
  ttlMs: number;
  value: T;
}

export interface CacheLoadOptions<T> {
  refresh?: boolean;
  shouldCache?: (value: T) => boolean;
}

export function cacheAgeMs(at: number, now: number): number {
  return Math.max(0, now - at);
}

// 进程内 TTL + LRU。已完成的快照与在途任务分开，慢查询不会被 TTL 或容量淘汰中断去重。
export function createServerCache<T>(maxEntries: number, ttlFor: (key: string) => number) {
  const entries = new Map<string, Entry<T>>();
  const pending = new Map<string, { refresh: boolean; promise: Promise<T> }>();

  function peek(key: string, now = Date.now()): Entry<T> | undefined {
    const entry = entries.get(key);
    if (entry && cacheAgeMs(entry.at, now) >= entry.ttlMs) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  }

  function store(key: string, value: T, now: number) {
    entries.delete(key);
    entries.set(key, { at: now, ttlMs: ttlFor(key), value });
    if (entries.size <= maxEntries) return;

    // 先清理已过期条目，满了才淘汰最久未访问的一项。
    for (const k of entries.keys()) peek(k, now);
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (!oldest.done) entries.delete(oldest.value);
    }
  }

  function load(key: string, loader: () => T | Promise<T>, options: CacheLoadOptions<T> = {}) {
    const { refresh = false, shouldCache } = options;
    const running = pending.get(key);
    if (running && (!refresh || running.refresh)) return { promise: running.promise, cached: false };
    if (!refresh) {
      const hit = peek(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return { promise: Promise.resolve(hit.value), cached: true };
      }
    }

    // 强刷可替换更早的普通查询；删除、清空或重新加载后，旧任务仅能回给原调用方。
    const promise: Promise<T> = Promise.resolve().then(loader).then((value) => {
      if (pending.get(key)?.promise === promise && (!shouldCache || shouldCache(value))) {
        store(key, value, Date.now());
      }
      return value;
    }).finally(() => {
      if (pending.get(key)?.promise === promise) pending.delete(key);
    });
    pending.set(key, { refresh, promise });
    return { promise, cached: false };
  }

  return {
    load,
    peek,
    set(key: string, value: T, now = Date.now()) {
      pending.delete(key);
      store(key, value, now);
    },
    delete(key: string) {
      pending.delete(key);
      entries.delete(key);
    },
    clear() {
      pending.clear();
      entries.clear();
    },
    stats(now = Date.now()) {
      const live: { key: string; ageMs: number; ttlMs: number }[] = [];
      for (const key of entries.keys()) {
        const entry = peek(key, now);
        if (entry) live.push({ key, ageMs: cacheAgeMs(entry.at, now), ttlMs: entry.ttlMs });
      }
      return { size: live.length, maxEntries, entries: live };
    },
  };
}
