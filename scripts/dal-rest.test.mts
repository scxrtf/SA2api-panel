// CloudBase DAL 离线契约测试：真实 HTTP URL/body，不连接云端数据库。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

type Captured = { method: string; url: URL; body: any };
const requests: Captured[] = [];
let findPage = 0;
let upsertConflict = true;
let relationRows: { uid: string }[] = [];
const allRows = Array.from({ length: 1001 }, (_, i) => ({ id: `row-${i}`, totalTokens: 1, at: "2026-11-10T00:00:00.000Z" }));

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url ?? "/", "http://dal.test");
  const table = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  requests.push({ method: req.method ?? "", url, body: text ? JSON.parse(text) : undefined });
  res.setHeader("Content-Type", "application/json");
  const send = (value: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };

  if (table === "AccountState") return send(relationRows);
  if (table === "Account") return send([{ uid: "keep", expiresAt: "123", state: null }]);
  if (table === "ModelCooldown" && req.method === "POST") return send([{ id: "cooldown-id", ...((requests.at(-1)?.body?.[0]) ?? {}) }]);
  if (table === "Setting" && req.method === "GET") {
    return send(upsertConflict ? [] : [{ key: "lease", value: "old" }]);
  }
  if (table === "Setting" && req.method === "POST" && upsertConflict) {
    upsertConflict = false;
    return send({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
  }
  if (table === "Setting" && req.method === "PATCH") {
    return send([{ key: "lease", value: "new", updatedAt: "2026-11-10T00:00:00.000Z" }]);
  }
  if (table === "Provider") return send([{ id: requests.at(-1)?.body?.[0]?.id, name: "vendor" }]);
  if (table === "UsageEvent") {
    if (url.searchParams.has("group-test")) return send([]);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 1000);
    findPage++;
    return send(allRows.slice(offset, offset + limit));
  }
  if (table === "RequestLog") {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = Number(url.searchParams.get("limit") ?? 1000);
    return send(Array.from({ length: Math.max(0, Math.min(limit, 1001 - offset)) }, () => ({ durationMs: 2 })));
  }
  return send([]);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
process.env.CLOUDBASE_POSTGREST_URL = `http://127.0.0.1:${port}`;
process.env.CLOUDBASE_API_KEY = "offline-test";
process.env.USE_CLOUDBASE_REST = "1";

try {
  const { dal } = await import("../src/lib/dal.ts");

  await dal.modelCooldown.findUnique({ where: { uid_model: { uid: "u1", model: "m1" } } });
  let url = requests.at(-1)!.url;
  assert.equal(url.searchParams.get("uid"), 'eq."u1"');
  assert.equal(url.searchParams.get("model"), 'eq."m1"');
  assert.equal(url.searchParams.has("uid_model"), false);

  await dal.modelCooldown.findMany({ where: {
    reason: { not: { startsWith: "11102" } },
    OR: [
      { uid: "u1", model: { contains: "a,b\"(x)%*\\", mode: "insensitive" } },
      { until: { gte: 12n } },
    ],
  } });
  url = requests.at(-1)!.url;
  assert.equal(url.searchParams.get("reason"), 'not.like."11102*"');
  assert.equal(url.searchParams.get("or"), String.raw`or(and(uid.eq."u1",model.ilike."*a,b\"(x)\\%\\*\\\\*"),until.gte."12")`);

  await dal.provider.create({ data: { name: "vendor", baseUrl: "https://vendor.invalid" }, select: { id: true, name: true } });
  let captured = requests.at(-1)!;
  assert.match(captured.body[0].id, /^c/);
  assert.equal(captured.url.searchParams.get("select"), "id,name");

  relationRows = [{ uid: "blocked-a" }, { uid: "blocked,b" }];
  const accounts = await dal.account.findMany({ where: { state: { isNot: { disabled: false } } } });
  url = requests.at(-1)!.url;
  assert.equal(url.searchParams.get("uid"), 'not.in.("blocked-a","blocked,b")');
  assert.equal(accounts[0].expiresAt, 123n);
  relationRows = [];
  await dal.account.findMany({ where: { state: { isNot: { disabled: false } } } });
  assert.equal(requests.at(-1)!.url.searchParams.has("uid"), false, "empty isNot match must not exclude parents");

  const state = await dal.setting.upsert({
    where: { key: "lease" },
    create: { key: "lease", value: "created-only" },
    update: { value: "new" },
    select: { key: true, value: true },
  });
  assert.equal(state.value, "new");
  assert.equal(requests.filter((r) => r.url.pathname.endsWith("/Setting") && r.method === "POST").length, 1);
  const patch = requests.filter((r) => r.url.pathname.endsWith("/Setting") && r.method === "PATCH").at(-1)!;
  assert.equal(patch.body.value, "new");
  assert.ok(patch.body.updatedAt, "@updatedAt must be injected on updates");
  assert.equal(patch.url.searchParams.get("select"), "key,value");

  findPage = 0;
  const rows = await dal.usageEvent.findMany({ select: { id: true } });
  assert.equal(rows.length, 1001);
  assert.equal(findPage, 2, "unbounded findMany must continue past the gateway page limit");
  assert.equal(requests.at(-1)!.url.searchParams.get("offset"), "1000");
  const bounded = await dal.usageEvent.findMany({ select: { id: true }, take: 1, skip: 1000 });
  assert.equal(bounded.length, 1);
  assert.equal(requests.at(-1)!.url.searchParams.get("limit"), "1");

  const grouped = await dal.usageEvent.groupBy({
    by: ["uid", "ok"], _count: { _all: true }, _sum: { totalTokens: true },
  });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0]._count._all, 1001, "groupBy aggregation must include every fetched page");
  assert.equal(grouped[0]._sum.totalTokens, 1001);
  const aggregate = await dal.requestLog.aggregate({ _avg: { durationMs: true } });
  assert.equal(aggregate._avg.durationMs, 2);

  console.log("PASS DAL compound keys, escaping, relation negation, BigInt, write select, upsert race, and pagination");
} finally {
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
}
