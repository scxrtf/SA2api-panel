import assert from "node:assert/strict";
import test, { mock } from "node:test";

const calls: { operation: string; args?: unknown }[] = [];
let providerExists = false;
const record = (operation: string) => (args?: unknown) => {
  calls.push({ operation, args });
  return Promise.resolve(operation === "findUnique"
    ? providerExists ? { name: "upstream" } : null
    : operation === "findMany" ? [] : undefined);
};

mock.module(new URL("../src/lib/panel-auth.ts", import.meta.url).href, {
  namedExports: {
    panelAuth: async () => null,
    verifySuperPassword: (value: unknown) => value === "secret",
    ok: (data: Record<string, unknown> = {}) => Response.json({ ok: true, ...data }),
    fail: (status: number, error: string) => Response.json({ ok: false, error }, { status }),
  },
});
mock.module(new URL("../src/lib/db.ts", import.meta.url).href, {
  namedExports: {
    prisma: {
      provider: {
        findMany: record("findMany"),
        findUnique: record("findUnique"),
        create: record("create"),
        update: record("update"),
      },
    },
  },
});
mock.module(new URL("../src/lib/provider.ts", import.meta.url).href, {
  namedExports: { invalidateProviders() { calls.push({ operation: "invalidate" }); } },
});
mock.module(new URL("../src/lib/auth-guard.ts", import.meta.url).href, {
  namedExports: { mask: () => "masked", invalidateKeyRing() {} },
});
mock.module(new URL("../src/lib/cloudbase-rest.ts", import.meta.url).href, {
  namedExports: { isCloudbaseRestEnabled: () => false },
});

const providersRoute = await import("../src/app/api/panel/providers/route.ts");
const providerRoute = await import("../src/app/api/panel/providers/[name]/route.ts");
const validProvider = { name: "upstream", base_url: "https://example.com/v1", key: "upstream-key", models: "model-a" };
const request = (body: unknown) => new Request("http://localhost/api/panel/providers", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

test("新增供应商必须通过超级密码校验，失败时不访问数据库", async () => {
  for (const superPassword of [undefined, "wrong"]) {
    calls.length = 0;
    const response = await providersRoute.POST(request({ ...validProvider, super_password: superPassword }));
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { ok: false, error: "超级密码错误" });
    assert.deepEqual(calls, []);
  }

  const response = await providersRoute.POST(request({ ...validProvider, super_password: "secret" }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.operation), ["findUnique", "create", "invalidate"]);
  const create = calls.find((call) => call.operation === "create");
  assert.deepEqual(create?.args, {
    data: { name: "upstream", baseUrl: "https://example.com/v1", apiKey: "upstream-key", models: "model-a" },
  });
});

test("修改供应商必须先验证超级密码，且不会把密码写入供应商", async () => {
  calls.length = 0;
  let response = await providerRoute.PATCH(request({ models: "model-b", super_password: "wrong" }), {
    params: Promise.resolve({ name: "upstream" }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(calls, []);

  response = await providerRoute.PATCH(request({ models: "model-b", super_password: "secret" }), {
    params: Promise.resolve({ name: "upstream" }),
  });
  assert.equal(response.status, 404, "mock 中供应商不存在时仍已完成鉴权并查询数据库");
  assert.deepEqual(calls.map((call) => call.operation), ["findUnique"]);

  calls.length = 0;
  providerExists = true;
  response = await providerRoute.PATCH(request({ models: "model-b", super_password: "secret" }), {
    params: Promise.resolve({ name: "upstream" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.operation), ["findUnique", "update", "invalidate"]);
  assert.deepEqual(calls.find((call) => call.operation === "update")?.args, {
    where: { name: "upstream" }, data: { models: "model-b" },
  });
  providerExists = false;
});

test("供应商 GET 保持原有面板鉴权，不要求超级密码", async () => {
  calls.length = 0;
  const response = await providersRoute.GET(new Request("http://localhost/api/panel/providers"));
  assert.equal(response.status, 200);
  assert.deepEqual(calls.map((call) => call.operation), ["findMany"]);
});
