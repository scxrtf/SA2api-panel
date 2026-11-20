import assert from "node:assert/strict";
import test from "node:test";
import { cachedPanelData, panelCacheDel, panelCacheGet } from "../src/lib/panel-cache.ts";
import { createServerCache } from "../src/lib/server-cache.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

test("concurrent refreshes share a load and a late regular query cannot overwrite it", async () => {
  const cache = createServerCache<string>(2, () => 60_000);
  const old = deferred<string>();
  const fresh = deferred<string>();
  const initial = cache.load("key", () => old.promise);
  const refresh = cache.load("key", () => fresh.promise, { refresh: true });
  const mustNotLoad = () => assert.fail("refresh already running");
  assert.notEqual(refresh.promise, initial.promise);
  assert.equal(cache.load("key", mustNotLoad, { refresh: true }).promise, refresh.promise);
  assert.equal(cache.load("key", mustNotLoad).promise, refresh.promise);

  fresh.resolve("fresh");
  assert.equal(await refresh.promise, "fresh");
  old.resolve("old");
  assert.equal(await initial.promise, "old");
  const hit = cache.load("key", mustNotLoad);
  assert.equal(hit.cached, true);
  assert.equal(await hit.promise, "fresh");
});

test("exact invalidation and clear fence off old jobs without evicting sibling windows", async (t) => {
  t.after(() => panelCacheDel());
  const old = deferred<string>();
  const initial = cachedPanelData("balance_history:1", () => old.promise);
  await cachedPanelData("balance_history:10", async () => "keep").promise;
  panelCacheDel("balance_history:1");

  const fresh = deferred<string>();
  const reload = cachedPanelData("balance_history:1", () => fresh.promise);
  old.resolve("old");
  assert.equal(await initial.promise, "old");
  assert.equal(panelCacheGet("balance_history:1"), null);
  assert.equal(panelCacheGet("balance_history:10"), "keep");
  assert.equal(cachedPanelData("balance_history:1", async () => assert.fail("same job")).promise, reload.promise);

  panelCacheDel();
  fresh.resolve("invalidated");
  assert.equal(await reload.promise, "invalidated");
  assert.equal(panelCacheGet("balance_history:1"), null);
  assert.equal(panelCacheGet("balance_history:10"), null);
});

test("LRU honors recent hits and removes expired entries before evicting live ones", async (t) => {
  let now = 10_000;
  t.mock.method(Date, "now", () => now);
  const cache = createServerCache<number>(2, (key) => key === "short" ? 10 : 100);

  cache.set("hot", 1);
  cache.set("short", 2);
  now += 10;
  cache.set("cold", 3);
  assert.deepEqual(cache.stats().entries.map((entry) => entry.key), ["hot", "cold"]);

  assert.equal(await cache.load("hot", () => assert.fail("live entry")).promise, 1);
  const pending = deferred<number>();
  const load = cache.load("new", () => pending.promise);
  cache.set("newer", 4);
  assert.equal(cache.peek("cold"), undefined);
  assert.equal(cache.load("new", () => assert.fail("capacity does not evict in-flight work")).promise, load.promise);
  pending.resolve(5);
  assert.equal(await load.promise, 5);
  assert.deepEqual(cache.stats().entries.map((entry) => entry.key), ["newer", "new"]);
});

test("errors and uncacheable responses do not poison the existing snapshot", async () => {
  const cache = createServerCache<number>(1, () => 60_000);
  const key = "models";
  const skip = { refresh: true, shouldCache: (value: number) => value > 0 };
  assert.equal(await cache.load(key, () => -1, skip).promise, -1);
  assert.equal(cache.peek(key), undefined);
  assert.equal(await cache.load(key, () => 10).promise, 10);
  await assert.rejects(cache.load(key, () => { throw new Error("offline"); }, skip).promise, /offline/);
  assert.equal(await cache.load(key, () => 99).promise, 10);
  assert.equal(await cache.load(key, () => 20, skip).promise, 20);
  assert.equal(cache.peek(key)?.value, 20);
});
