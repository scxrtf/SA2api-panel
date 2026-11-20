import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { databaseCache } from "../src/lib/database-cache.ts";

function directRows(dialogRows = 8) {
  return [{
    database_name: "offline", database_bytes: "1024", request_logs: "10", dialog_rows: String(dialogRows),
    active_connections: "1", max_connections: "3", server_version: "offline", tables: [],
  }];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => { resolve = finish; });
  return { promise, resolve };
}

let cloudbase: boolean;
let directCalls: number;
let tableLoads: number;
let platformCalls: number;
let readDirect: () => Promise<ReturnType<typeof directRows>>;
let countAccounts: () => Promise<number>;
let readPlatform: () => Promise<{ qps: number } | null>;
let remainingDialogs: number;

test.beforeEach(() => {
  databaseCache.stats.clear();
  databaseCache.platform.clear();
  cloudbase = false;
  directCalls = tableLoads = platformCalls = 0;
  remainingDialogs = 8;
  readDirect = async () => directRows(remainingDialogs);
  countAccounts = async () => 0;
  readPlatform = async () => ({ qps: platformCalls });
});

function fixture(file: string, namedExports: Record<string, unknown>) {
  mock.module(new URL(`../src/lib/${file}.ts`, import.meta.url).href, { namedExports });
}

fixture("db", { prisma: { $queryRaw: () => { directCalls++; return readDirect(); } } });
fixture("dal", { dal: new Proxy({}, {
  get(_target, model) {
    return { async count() {
      if (model !== "account") return 0;
      tableLoads++;
      return countAccounts();
    } };
  },
}) });
fixture("cloudbase-rest", { cbSelect: async () => [], isCloudbaseRestEnabled: () => cloudbase });
fixture("cloudbase-monitor", { getCloudbasePlatformStats: () => { platformCalls++; return readPlatform(); } });
fixture("panel-auth", {
  panelAuth: async (req: Request) => req.headers.has("Authorization") ? null : new Response(null, { status: 401 }),
  ok: (data: Record<string, unknown>) => Response.json({ ok: true, ...data }),
  fail: (status: number, error: string) => Response.json({ ok: false, error }, { status }),
  verifySuperPassword: (password: string) => password === "offline",
});
fixture("retention", {
  clearRequestLogDetails: async () => 0,
  clearRequestLogDialog: async () => { remainingDialogs = 0; return 8; },
  pruneModelHealth: async () => 0,
  pruneRequestLogs: async () => 0,
  retentionConfig: () => ({ days: 30, detailHours: 48 }),
  runRetention: async () => ({}),
});

const { GET, POST } = await import("../src/app/api/panel/database/route.ts");
const url = "http://localhost/api/panel/database";
const headers = { Authorization: "Bearer offline" };
const read = (refresh = false) => GET(new Request(url + (refresh ? "?refresh=1" : ""), { headers }));
const flush = () => new Promise<void>((done) => { setImmediate(done); });

test("direct database stats coalesce cold reads and manual refreshes, after auth", async () => {
  for (const refresh of [false, true]) {
    const responses = await Promise.all(Array.from({ length: 5 }, () => read(refresh)));
    const snapshots = await Promise.all(responses.map((response) => response.json()));
    assert.ok(snapshots.every((snapshot) => snapshot.mode === "direct" && snapshot.platform === undefined));
    assert.equal(directCalls, refresh ? 2 : 1);
  }
  assert.equal((await GET(new Request(url))).status, 401);
  assert.equal(directCalls, 2);
  assert.equal(platformCalls, 0);
});

test("CloudBase table stats and QPS load in parallel, coalesce, and expire independently", async (t) => {
  cloudbase = true;
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const tables = deferred<number>();
  const platform = deferred<{ qps: number }>();
  countAccounts = () => tables.promise;
  readPlatform = () => platform.promise;
  const cold = [read(), read(), read()];
  await flush();
  try {
    assert.equal(tableLoads, 1);
    assert.equal(platformCalls, 1); // 平台请求已开始，表统计仍被 gate 暂停。
  } finally {
    tables.resolve(0);
    platform.resolve({ qps: 10 });
  }
  const payloads = await Promise.all((await Promise.all(cold)).map((response) => response.json()));
  assert.ok(payloads.every((p) => p.mode === "cloudbase" && p.platform.qps === 10));
  assert.ok(!Object.hasOwn(databaseCache.stats.get()!.value, "platform"));

  readPlatform = async () => ({ qps: 20 });
  now += 60_000;
  assert.equal((await (await read()).json()).platform.qps, 20);
  assert.equal(tableLoads, 1);
  assert.equal(platformCalls, 2);

  readPlatform = async () => ({ qps: 30 });
  const fresh = await Promise.all([read(true), read(true)]);
  assert.equal((await fresh[0].json()).platform.qps, 30);
  assert.equal((await fresh[1].json()).platform.qps, 30);
  assert.equal(tableLoads, 2);
  assert.equal(platformCalls, 3);
});

test("a CloudBase platform failure does not discard table stats or become a cached error", async () => {
  cloudbase = true;
  readPlatform = async () => { throw new Error("offline platform failure"); };
  assert.equal((await read()).status, 500);
  readPlatform = async () => null;
  const recovered = await read();
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).platform, null);
  assert.equal((await (await read()).json()).platform, null);
  assert.equal(tableLoads, 1);
  assert.equal(platformCalls, 2);
});

test("retention invalidates in-flight stats so an old row count cannot reappear", async () => {
  const old = deferred<ReturnType<typeof directRows>>();
  readDirect = () => directCalls === 1 ? old.promise : Promise.resolve(directRows(remainingDialogs));
  const pending = read();
  await flush();
  assert.equal(directCalls, 1);
  const action = await POST(new Request(url, {
    method: "POST", headers,
    body: JSON.stringify({ action: "clear_dialog", super_password: "offline" }),
  }));
  assert.equal((await action.json()).stats.database.dialogRows, 0);
  old.resolve(directRows(8));
  assert.equal((await (await pending).json()).database.dialogRows, 8);
  assert.equal((await (await read()).json()).database.dialogRows, 0);
  assert.equal(directCalls, 2);
});
