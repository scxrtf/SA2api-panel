// 离线验证普通 429 的快速切换与全池冷却的快速失败；不访问真实上游。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { DEFAULT_CONFIG, getConfig } from "../src/lib/config.ts";
import { modelBlocked, pick, retryStatus } from "../src/lib/pool.ts";
import { handleChat } from "../src/lib/chat.ts";
import { agentToolError, runAgentTool } from "../src/lib/agenttool-route.ts";
import { UpstreamError } from "../src/lib/upstream/errors.ts";

const now = Date.now();
interface TestAccount {
  uid: string;
  realm: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: bigint;
  domain: string;
  enterpriseId: string;
  deviceToken: string;
  state: {
    uid: string;
    disabled: boolean;
    paused: boolean;
    credits: bigint;
    cooldownUntil: bigint;
    breakerUntil: bigint;
    degradeUntil: bigint;
    cooldownReason: string;
  };
  modelCooldowns: { uid: string; model: string; until: bigint; reason: string }[];
  modelCosts: never[];
}
const globalWithDb = globalThis as typeof globalThis & { prisma?: unknown };
function account(uid: string, cooldownUntil = 0, modelUntil = 0): TestAccount {
  return {
    uid, realm: "cn", disabled: false, paused: false,
    accessToken: "offline-" + uid, refreshToken: "", expiresAt: 0n,
    domain: "", enterpriseId: "", deviceToken: "",
    state: {
      uid, disabled: false, paused: false, credits: 0n,
      cooldownUntil: BigInt(cooldownUntil), breakerUntil: 0n,
      degradeUntil: 0n,
      cooldownReason: cooldownUntil ? "soft_rate: 429" : "",
    },
    modelCooldowns: modelUntil
      ? [{ uid, model: "test-model", until: BigInt(modelUntil), reason: "6004" }]
      : [],
    modelCosts: [],
  };
}

const oldPrisma = globalWithDb.prisma;
const oldFetch = globalThis.fetch;
try {
  const healthy = account("healthy");
  const cooling = account("cooling", now + 30_000);
  globalWithDb.prisma = {
    account: { findMany: async () => [cooling, healthy] },
  };
  const selected = await pick(DEFAULT_CONFIG, { model: "test-model", realm: "cn" });
  assert.equal(selected?.account.uid, "healthy");
  console.log("PASS healthy account wins over a cooling account");

  globalWithDb.prisma = { account: { findMany: async () => [cooling] } };
  assert.equal(await pick(DEFAULT_CONFIG, { model: "test-model", realm: "cn" }), null);
  assert.equal(await pick(DEFAULT_CONFIG, {
    model: "test-model", realm: "cn", tried: new Set(["cooling"]),
  }), null);
  console.log("PASS cooling accounts are not selected as eager retry fallbacks");

  const soon = account("soon", now + 5_000);
  const late = account("late", now + 30_000);
  const modelCooling = account("model", 0, now + 60_000);
  globalWithDb.prisma = { account: { findMany: async () => [late, soon, modelCooling] } };
  const status = await retryStatus("test-model", "cn");
  assert.ok(status.retryAfterMs > 0 && status.retryAfterMs <= 5_000,
    `expected earliest recovery <=5s, got ${status.retryAfterMs}ms`);
  assert.equal(status.cooling, 3);
  const attempted = await retryStatus("test-model", "cn");
  assert.ok(attempted.retryAfterMs > 0 && attempted.retryAfterMs <= 5_000,
    `next client retry must see the earliest pool recovery, got ${attempted.retryAfterMs}ms`);
  assert.equal(attempted.cooling, 3);
  console.log("PASS Retry-After follows the earliest applicable recovery");

  const hardCooling = account("hard-cooling", now + 60_000);
  hardCooling.state.cooldownReason = "hard_credit";
  globalWithDb.prisma = { account: { findMany: async () => [hardCooling] } };
  assert.equal((await retryStatus("test-model", "cn")).cooling, 0);
  hardCooling.state.cooldownUntil = BigInt(now - 1);
  hardCooling.state.breakerUntil = BigInt(now + 5_000);
  const recoveredHard = await retryStatus("test-model", "cn");
  assert.equal(recoveredHard.cooling, 1);
  assert.ok(recoveredHard.retryAfterMs > 0 && recoveredHard.retryAfterMs <= 5_000);
  console.log("PASS hard-credit exclusion expires while active breaker remains visible");

  const globalHealthy = { ...account("global-healthy"), realm: "global" };
  globalWithDb.prisma = { account: { findMany: async () => [modelCooling, globalHealthy] } };
  const cnBlock = await modelBlocked("test-model", "cn");
  assert.equal(cnBlock.blocked, true);
  const globalBlock = await modelBlocked("test-model", "global");
  assert.equal(globalBlock.blocked, false);
  console.log("PASS model cooldown exhaustion is isolated by realm");

  const state = new Map<string, TestAccount["state"]>();
  for (const uid of ["rate-limited", "standby"]) {
    state.set(uid, account(uid).state);
  }
  let storedConfig: Record<string, unknown> = {};
  const getConfigForTest = async (overrides: Record<string, unknown>) => {
    storedConfig = overrides;
    return getConfig(true);
  };
  const db = {
    setting: { findUnique: async () => ({
      key: "config", value: JSON.stringify(storedConfig),
    }) },
    account: {
      findMany: async () => [...state.keys()].map((uid) => ({
        ...account(uid), state: state.get(uid)!,
      })),
      findUnique: async () => null,
    },
    accountState: {
      findUnique: async ({ where }: { where: { uid: string } }) => state.get(where.uid) ?? null,
      upsert: async ({ where, create, update }: {
        where: { uid: string };
        create: TestAccount["state"];
        update: Partial<TestAccount["state"]>;
      }) => {
        const current = state.get(where.uid) ?? create;
        const next = { ...current, ...update };
        state.set(where.uid, next);
        return next;
      },
    },
    modelCooldown: { deleteMany: async () => ({ count: 0 }) },
    stickySession: {
      findUnique: async () => null,
      findMany: async () => [],
      upsert: async () => ({}),
      delete: async () => ({}),
    },
    usageEvent: { create: async () => ({}) },
    requestLog: { create: async () => ({}) },
  };
  globalWithDb.prisma = db;
  const request = (conversationId = "offline") => handleChat({
    body: {
      model: "cn:test-model", conversation_id: conversationId,
      messages: [{ role: "user", content: "offline" }],
    },
    clientIP: "", inboundHeaders: new Headers(), ua: "", path: "/v1/chat/completions",
  });
  const hits: string[] = [];
  const encoder = new TextEncoder();
  globalThis.fetch = async (_url, init) => {
    const auth = String((init?.headers as Record<string, string>).Authorization);
    hits.push(auth);
    if (hits.length === 1) {
      return new Response("Too Many Requests", {
        status: 429, headers: { "Retry-After": "20" },
      });
    }
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(
          'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        ));
        controller.close();
      },
    }), { headers: { "Content-Type": "text/event-stream" } });
  };
  const started = Date.now();
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(hits.length, 2);
  assert.notEqual(hits[0], hits[1]);
  assert.ok(Date.now() - started < 500, "429 rotation must not wait for the Retry-After window");
  const limitedUID = hits[0].endsWith("rate-limited") ? "rate-limited" : "standby";
  assert.equal(state.get(limitedUID)!.cooldownUntil > BigInt(Date.now()), true);
  console.log("PASS upstream 429 rotates immediately to a different healthy account");

  // 6020 是 (账号, 模型) 级排队，不是全池不可用；先尝试其他健康账号。
  const modelCooldowns = new Map<string, { uid: string; model: string; until: bigint; reason: string }>();
  for (const uid of state.keys()) {
    state.set(uid, { ...state.get(uid)!, cooldownUntil: 0n, cooldownReason: "" });
  }
  db.account.findMany = async () => [...state.keys()].map((uid) => ({
    ...account(uid), state: state.get(uid)!,
    modelCooldowns: [...modelCooldowns.values()].filter((item) => item.uid === uid),
  }));
  db.modelCooldown = {
    deleteMany: async ({ where }: { where: { uid: string } }) => {
      for (const [key, item] of modelCooldowns) {
        if (item.uid === where.uid) modelCooldowns.delete(key);
      }
      return { count: 0 };
    },
    upsert: async ({ where, create, update }: {
      where: { uid_model: { uid: string; model: string } };
      create: { uid: string; model: string; until: bigint; reason: string };
      update: { until: bigint; reason: string };
    }) => {
      const key = where.uid_model.uid + "\0" + where.uid_model.model;
      const next = { ...(modelCooldowns.get(key) ?? create), ...update };
      modelCooldowns.set(key, next);
      return next;
    },
  };
  hits.length = 0;
  const queueBody = JSON.stringify({
    code: 6020,
    msg: "queue.waiting.title",
    data: { queue_position: 1847, retry_after: 40 },
  });
  const queueStarted = Date.now();
  const responseAfterQueue = await request("offline-queue");
  assert.equal(responseAfterQueue.status, 200);
  assert.equal(hits.length, 2);
  assert.notEqual(hits[0], hits[1]);
  assert.ok(Date.now() - queueStarted < 1_000, "queue rotation must not wait for Retry-After");
  console.log("PASS upstream 6020 queue rotates to a different healthy account");

  globalThis.fetch = async (_url, init) => {
    hits.push(String((init?.headers as Record<string, string>).Authorization));
    return new Response(queueBody, {
      status: 429, headers: { "Retry-After": "20" },
    });
  };
  // 各场景必须独立于前一轮的账号级和模型级冷却。
  for (const uid of state.keys()) {
    state.set(uid, { ...state.get(uid)!, cooldownUntil: 0n, cooldownReason: "" });
  }
  modelCooldowns.clear();
  hits.length = 0;
  const queueExhausted = await request("offline-queue-exhausted");
  assert.equal(queueExhausted.status, 429);
  assert.equal((await queueExhausted.json() as { error: { code: string } }).error.code,
    "upstream_queueing");
  assert.ok(Number(queueExhausted.headers.get("Retry-After")) > 0);
  assert.equal(hits.length, 2, "queue exhaustion must try every account exactly once");
  console.log("PASS all-account queueing fails only after account rotation");

  // 后续用例只覆盖账号级冷却，不继承上一场景的模型级冷却。
  modelCooldowns.clear();
  hits.length = 0;
  for (const uid of state.keys()) {
    state.set(uid, { ...state.get(uid)!, cooldownUntil: BigInt(Date.now() + 15_000) });
  }
  const exhausted = await request();
  assert.equal(exhausted.status, 429);
  assert.ok(Number(exhausted.headers.get("Retry-After")) > 0);
  assert.ok(Number(exhausted.headers.get("Retry-After")) <= 15);
  assert.equal(hits.length, 0, "cooldown must not trigger eager upstream probes");
  console.log("PASS all-cooling request fails fast with Retry-After and zero upstream calls");

  // 混合冷却不能沿用最后一次上游的 Retry-After：另一个账号更早恢复时，
  // 客户端应收到最早可路由时间。这里用 max_rotate=1 覆盖循环直接耗尽的分支。
  const resetAt = Date.now();
  for (const uid of state.keys()) {
    state.set(uid, {
      ...state.get(uid)!,
      cooldownUntil: BigInt(resetAt + 20_000),
      cooldownReason: "soft_rate: 429",
    });
  }
  // getConfig 有 5 秒缓存；独立进程避免本文件先前场景缓存默认值干扰测试。
  const exhaustedOutput = execFileSync(process.execPath, [
    "--import", "tsx", "--eval", String.raw`
      const { getConfig } = await import("./src/lib/config.ts");
      const { handleChat } = await import("./src/lib/chat.ts");
      const makeAccount = (uid) => ({
        uid, realm: "cn", accessToken: "offline-" + uid, refreshToken: "",
        expiresAt: 0n, domain: "", enterpriseId: "", deviceToken: "",
        state: {
          uid, disabled: false, paused: false, credits: 0n,
          cooldownUntil: 0n, breakerUntil: 0n, degradeUntil: 0n,
          cooldownReason: "soft_rate: 429",
        },
        modelCooldowns: [], modelCosts: [],
      });
      const accounts = [makeAccount("rate-limited"), makeAccount("standby")];
      accounts[1].state.cooldownUntil = BigInt(Date.now() + 5_000);
      globalThis.prisma = {
        setting: { findUnique: async () => ({
          key: "config", value: JSON.stringify({ max_rotate: 1 }),
        }) },
        account: {
          findMany: async () => accounts,
          findUnique: async () => null,
        },
        accountState: {
          findUnique: async ({ where }) =>
            accounts.find((account) => account.uid === where.uid)?.state,
          upsert: async ({ where, create, update }) => {
            const account = accounts.find((entry) => entry.uid === where.uid);
            Object.assign(account.state, create, update);
            return account.state;
          },
        },
        modelCooldown: { deleteMany: async () => ({ count: 0 }) },
        stickySession: {
          findUnique: async () => null, findMany: async () => [],
          upsert: async () => ({}), delete: async () => ({}),
        },
        usageEvent: { create: async () => ({}) },
        requestLog: { create: async () => ({}) },
      };
      let calls = 0;
      Math.random = () => 0;
      globalThis.fetch = async (_url, init) => {
        calls++;
        const auth = String(init.headers.Authorization);
        const account = accounts.find((entry) => auth.endsWith(entry.uid));
        account.state.cooldownUntil = BigInt(Date.now() +
          (account.uid === "standby" ? 5_000 : 20_000));
        return new Response("Too Many Requests", {
          status: 429, headers: { "Retry-After": "20" },
        });
      };
      await getConfig(true);
      const response = await handleChat({
        body: { model: "cn:test-model", messages: [{ role: "user", content: "offline" }] },
        clientIP: "", inboundHeaders: new Headers(), ua: "", path: "/v1/chat/completions",
      });
      if (response.status !== 429 || calls !== 1) {
        throw new Error("unexpected rotation result: " + response.status + ", calls=" + calls);
      }
      const retryAfter = Number(response.headers.get("Retry-After"));
      if (!(retryAfter > 0 && retryAfter <= 5)) {
        throw new Error("Retry-After is not the account recovery time: " + retryAfter);
      }
    `,
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(exhaustedOutput, "");
  console.log("PASS rotation-budget exhaustion returns the earliest Retry-After");

  globalWithDb.prisma = db;
  await getConfigForTest({ max_rotate: 1 });
  for (const uid of state.keys()) {
    state.set(uid, { ...state.get(uid)!, cooldownUntil: 0n });
  }
  hits.length = 0;
  let agentCalls = 0;
  const agentOutcome = await runAgentTool("cn", async () => {
    agentCalls++;
    throw new UpstreamError("soft_rate", 429, "Too Many Requests", 5_000);
  });
  // 两个账号均在第二次选号后进入冷却，第三次只检查本地候选，不发上游请求。
  assert.equal(agentCalls, state.size);
  assert.equal(agentOutcome.status, 429);
  assert.equal(agentOutcome.code, "rate_limit_exceeded");
  assert.ok((agentOutcome.retryAfterMs ?? 0) > 0);
  assert.ok(Number(agentToolError(agentOutcome).headers.get("Retry-After")) > 0);
  const agentCooling = await runAgentTool("cn", async () => {
    agentCalls++;
    throw new Error("must not call upstream while all accounts are cooling");
  });
  assert.equal(agentCalls, state.size);
  assert.equal(agentCooling.status, 429);
  assert.ok((agentCooling.retryAfterMs ?? 0) > 0);
  console.log("PASS search/fetch share 429 fast-fail and Retry-After semantics");
} finally {
  globalThis.fetch = oldFetch;
  if (oldPrisma === undefined) delete globalWithDb.prisma;
  else globalWithDb.prisma = oldPrisma;
}
