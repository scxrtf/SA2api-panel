import assert from "node:assert/strict";
import test from "node:test";
import { isEnterpriseEditionAccount, privateDataHeader, resolveModelOptimizationEnabled } from "../src/lib/upstream/privacy.ts";

process.env.USE_CLOUDBASE_REST = "0";
const { DEFAULT_CONFIG, getConfig, saveConfig } = await import("../src/lib/config.ts");
const { chatHeaders, rpcUserAgent } = await import("../src/lib/upstream/client.ts");
const account = {
  uid: "user", nickname: "", realm: "cn", accessToken: "offline-token", refreshToken: "",
  expiresAt: 0, domain: "", enterpriseId: "", deviceToken: "",
};

test("隐私判定复现本机函数的显式偏好/产品默认/企业矩阵", () => {
  for (const enterprise of [false, true]) {
    for (const productDefault of [true, false]) {
      for (const explicit of [undefined, null, true, false]) {
        const expected = typeof explicit === "boolean" ? explicit : !enterprise && productDefault;
        assert.equal(resolveModelOptimizationEnabled({ explicitEnabled: explicit, productDefaultEnabled: productDefault, isEnterpriseEdition: enterprise }), expected);
      }
    }
  }
  assert.equal(resolveModelOptimizationEnabled({ isEnterpriseEdition: false }), true);
  assert.equal(resolveModelOptimizationEnabled({ isEnterpriseEdition: true }), false);
});

test("企业识别包含 trim 后enterpriseId及ultimate/exclusive edition", () => {
  assert.equal(isEnterpriseEditionAccount({ enterpriseId: "  " }), false);
  assert.equal(isEnterpriseEditionAccount({ enterpriseId: " e " }), true);
  for (const accountType of ["ultimate", "exclusive"]) {
    assert.equal(isEnterpriseEditionAccount({ enterpriseId: "", accountType }), true);
    assert.equal(isEnterpriseEditionAccount({ enterpriseId: "", type: accountType }), true);
  }
  assert.equal(isEnterpriseEditionAccount({ enterpriseId: "", accountType: "personal" }), false);
});

test("CN/Global 都由实际偏好决定，不再把Global硬编码为private", () => {
  for (const realm of ["cn", "global"]) {
    const a = { ...account, realm };
    assert.equal(privateDataHeader(DEFAULT_CONFIG, a), "false");
    assert.equal(privateDataHeader({ ...DEFAULT_CONFIG, enable_model_optimization: false }, a), "true");
    assert.equal(privateDataHeader({ ...DEFAULT_CONFIG, model_optimization_default_enabled: false }, a), "true");
    const headers = chatHeaders(DEFAULT_CONFIG, a, "", { conversationID: "", cacheKeyID: "", conversationRequestID: "", traceID: "" });
    assert.equal(headers["X-Private-Data"], "false");
    assert.equal(headers["User-Agent"], rpcUserAgent(DEFAULT_CONFIG, a));
  }
});

test("每UID显式偏好优先，企业也可以显式启用或关闭", () => {
  const enterprise = { ...account, enterpriseId: "enterprise" };
  assert.equal(privateDataHeader(DEFAULT_CONFIG, enterprise), "true");
  assert.equal(privateDataHeader({ ...DEFAULT_CONFIG, enable_model_optimization: true }, enterprise), "false");
  assert.equal(privateDataHeader({ ...DEFAULT_CONFIG, enable_model_optimization: true, model_optimization_accounts: { user: false } }, enterprise), "true");
  assert.equal(privateDataHeader({ ...DEFAULT_CONFIG, enable_model_optimization: false, model_optimization_accounts: { user: true } }, enterprise), "false");
});

test("偏好保存/读取/清除与非法输入处理，不写真实数据库", async () => {
  const globals = globalThis as unknown as { prisma?: unknown };
  const original = globals.prisma;
  let stored = "{}";
  globals.prisma = { setting: {
    findUnique: async () => ({ value: stored }),
    upsert: async ({ update }: { update: { value: string } }) => { stored = update.value; return {}; },
  } };
  try {
    await getConfig(true);
    let config = await saveConfig({ enable_model_optimization: false, model_optimization_default_enabled: false, model_optimization_accounts: { user: true } });
    assert.equal(config.enable_model_optimization, false);
    assert.equal(config.model_optimization_default_enabled, false);
    assert.equal(config.model_optimization_accounts.user, true);
    assert.equal((await getConfig(true)).model_optimization_accounts.user, true);
    config = await saveConfig({ enable_model_optimization: null, model_optimization_accounts: {} });
    assert.equal(config.enable_model_optimization, null);
    assert.deepEqual(Object.keys(config.model_optimization_accounts), []);
    for (const value of ["true", 1, {}, []]) await assert.rejects(saveConfig({ enable_model_optimization: value }), /enable_model_optimization/);
    for (const value of [null, [], { user: "false" }, { " user ": false }]) await assert.rejects(saveConfig({ model_optimization_accounts: value }), /model_optimization_accounts/);
  } finally {
    if (original === undefined) delete globals.prisma;
    else globals.prisma = original;
  }
});
