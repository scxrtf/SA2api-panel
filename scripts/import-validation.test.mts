import assert from "node:assert/strict";
import test, { mock } from "node:test";

let writes = 0;
mock.module(new URL("../src/lib/panel-auth.ts", import.meta.url).href, { namedExports: {
  panelAuth: async () => null,
  ok: (data: Record<string, unknown> = {}) => Response.json({ ok: true, ...data }),
  fail: (status: number, error: string) => Response.json({ ok: false, error }, { status }),
} });
mock.module(new URL("../src/lib/config.ts", import.meta.url).href, { namedExports: { getConfig: async () => ({}) } });
mock.module(new URL("../src/lib/db.ts", import.meta.url).href, { namedExports: {
  prisma: { account: { upsert: async () => { writes++; throw new Error("invalid account reached database"); } } },
} });
mock.module(new URL("../src/lib/pool.ts", import.meta.url).href, { namedExports: {
  revive: async () => {}, markCheckin: async () => {}, setCreditsDetailed: async () => {},
} });
mock.module(new URL("../src/lib/upstream/client.ts", import.meta.url).href, { namedExports: {
  claimTrial: async () => {}, dailyCheckin: async () => {}, userResource: async () => {}, expiringSoonMs: () => 0,
} });
mock.module(new URL("../src/lib/upstream/global_register.ts", import.meta.url).href, { namedExports: { globalCompleteRegistration: async () => {} } });
mock.module(new URL("../src/lib/runlog.ts", import.meta.url).href, { namedExports: { runlogAccount() {} } });
mock.module(new URL("../src/lib/machine-key.ts", import.meta.url).href, { namedExports: {
  authorizeMachineForAccount: async () => {}, getOrCreateMachineId: async () => ({ id: "test" }),
} });
const { POST } = await import("../src/app/api/panel/import/cockpit/route.ts");
const request = (body: unknown) => new Request("http://localhost/api/panel/import/cockpit", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("批量导入对非数组/空数组返回 400", async () => {
  for (const value of [null, {}, 1, "text", []]) assert.equal((await POST(request(value))).status, 400);
  assert.equal(writes, 0);
});

test("批量导入逐项跳过 null/错误字段/不安全过期时间，零落库", async () => {
  const validFields = { uid: "test", access_token: "test-at", refresh_token: "test-rt" };
  const invalid = [null, 1, [], { uid: 1 }, { ...validFields, nickname: {} },
    { ...validFields, expires_at: 1.5 }, { ...validFields, expires_at: 9e20 }];
  const response = await POST(request(invalid));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, invalid.length);
  assert.equal(body.skipped, invalid.length);
  assert.equal(body.imported, 0);
  assert.equal(body.errors.length, invalid.length);
  assert.equal(writes, 0);
});
