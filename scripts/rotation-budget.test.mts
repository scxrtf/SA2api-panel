// rotation-budget.test.mts — 轮转预算必须覆盖可用账号（离线，无网络）。
// 复现现场：号池账号数 > max_rotate，前 max_rotate 个账号返回账号级 429
// （6020 排队 / 普通 429），其余账号仍可用。修复前循环按 max_rotate 截止，
// 直接把「还有可用账号」误报成轮转耗尽。
import assert from "node:assert/strict";
import { handleChat } from "../src/lib/chat.ts";

const MAX_ROTATE = 3;
const ACCOUNT_COUNT = 8;
const OK_UID = "acct-0"; // 积分最低 → 权重最低，排在高积分账号之后

const globalWithDb = globalThis as typeof globalThis & { prisma?: unknown };
const oldPrisma = globalWithDb.prisma;
const oldFetch = globalThis.fetch;

type TestState = {
  uid: string;
  disabled: boolean;
  paused: boolean;
  credits: bigint;
  cooldownUntil: bigint;
  cooldownReason: string;
  breakerUntil: bigint;
  degradeUntil: bigint;
};
type TestAccount = {
  uid: string;
  realm: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: bigint;
  domain: string;
  enterpriseId: string;
  deviceToken: string;
  state: TestState;
  modelCooldowns: { uid: string; model: string; until: bigint; reason: string }[];
  modelCosts: never[];
};

const accounts: TestAccount[] = Array.from({ length: ACCOUNT_COUNT }, (_, i) => {
  const uid = "acct-" + i;
  return {
    uid, realm: "cn", accessToken: "offline-" + uid, refreshToken: "",
    expiresAt: 0n, domain: "", enterpriseId: "", deviceToken: "",
    state: {
      uid, disabled: false, paused: false,
      credits: i === 0 ? 0n : 100n,
      cooldownUntil: 0n, cooldownReason: "",
      breakerUntil: 0n, degradeUntil: 0n,
    },
    modelCooldowns: [],
    modelCosts: [],
  };
});
const byUID = new Map(accounts.map((a) => [a.uid, a]));
const modelCooldowns = new Map<string, { uid: string; model: string; until: bigint; reason: string }>();

const db = {
  setting: {
    findUnique: async () => ({
      key: "config", value: JSON.stringify({ max_rotate: MAX_ROTATE }),
    }),
  },
  account: {
    findMany: async () => accounts.map((a) => ({
      ...a,
      modelCooldowns: [...modelCooldowns.values()].filter((c) => c.uid === a.uid),
    })),
    findUnique: async () => null,
  },
  accountState: {
    findUnique: async ({ where }: { where: { uid: string } }) =>
      byUID.get(where.uid)?.state ?? null,
    upsert: async ({ where, create, update }: {
      where: { uid: string };
      create: Partial<TestState>;
      update: Partial<TestState>;
    }) => {
      const account = byUID.get(where.uid);
      if (!account) throw new Error("unknown account " + where.uid);
      Object.assign(account.state, create, update);
      return account.state;
    },
  },
  modelCooldown: {
    deleteMany: async ({ where }: { where?: { uid?: string } } = {}) => {
      for (const [key, item] of modelCooldowns) {
        if (!where?.uid || item.uid === where.uid) modelCooldowns.delete(key);
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
  },
  stickySession: {
    findUnique: async () => null,
    findMany: async () => [],
    upsert: async () => ({}),
    delete: async () => ({}),
  },
  usageEvent: { create: async () => ({}) },
  requestLog: { create: async () => ({ id: "offline-log" }) },
};

const encoder = new TextEncoder();
const sse = () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(encoder.encode(
      'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    ));
    controller.close();
  },
}), { headers: { "Content-Type": "text/event-stream" } });

const queueEnvelope = (retryAfter: number) => JSON.stringify({
  code: 6020,
  msg: "queue.waiting.title",
  data: { queue_position: 1847, retry_after: retryAfter },
});
const queueBody = queueEnvelope(40);

const request = () => handleChat({
  body: {
    model: "cn:test-model",
    messages: [{ role: "user", content: "offline" }],
  },
  clientIP: "", inboundHeaders: new Headers(), ua: "", path: "/v1/chat/completions",
});

const resetAccounts = () => {
  for (const account of accounts) {
    account.state.cooldownUntil = 0n;
    account.state.cooldownReason = "";
  }
  modelCooldowns.clear();
};

const hits: string[] = [];
const uidOfAuth = (init?: RequestInit) => {
  const auth = String((init?.headers as Record<string, string>).Authorization);
  return { auth, uid: auth.replace(/^Bearer\s+offline-/, "") };
};

try {
  globalWithDb.prisma = db;

  // 场景 1：6020 排队 —— 前若干个账号排队，ok 账号应被尝试到。
  resetAccounts();
  hits.length = 0;
  globalThis.fetch = async (_url, init) => {
    const { auth, uid } = uidOfAuth(init);
    hits.push(auth);
    if (uid === OK_UID) return sse();
    return new Response(queueBody, {
      status: 429, headers: { "Retry-After": "40" },
    });
  };
  const queueResponse = await request();
  assert.equal(queueResponse.status, 200,
    "queue rotation must reach the healthy account beyond max_rotate");
  assert.ok(hits.some((auth) => auth.endsWith(OK_UID)),
    "the healthy account must be attempted");
  assert.ok(hits.length > MAX_ROTATE,
    `rotation must exceed max_rotate when accounts remain, got ${hits.length} attempts`);
  console.log(`PASS 6020 rotation covers pool beyond max_rotate (attempts=${hits.length})`);

  // 场景 2：普通账号级 429 走同一预算规则（不退避路径）。
  resetAccounts();
  hits.length = 0;
  globalThis.fetch = async (_url, init) => {
    const { auth, uid } = uidOfAuth(init);
    hits.push(auth);
    if (uid === OK_UID) return sse();
    return new Response("Too Many Requests", {
      status: 429, headers: { "Retry-After": "20" },
    });
  };
  const rateResponse = await request();
  assert.equal(rateResponse.status, 200,
    "account-level 429 rotation must reach the healthy account beyond max_rotate");
  assert.ok(hits.length > MAX_ROTATE,
    `account-level 429 must exceed max_rotate when accounts remain, got ${hits.length} attempts`);
  assert.ok(accounts.filter((a) => a.state.cooldownUntil > BigInt(Date.now())).length
    >= MAX_ROTATE, "failed accounts must be cooled down, not retried");
  console.log(`PASS account-level 429 rotation covers pool beyond max_rotate (attempts=${hits.length})`);

  // 场景 3：全部账号排队时仍会终止，并返回 429 + Retry-After（预算有硬上限）。
  resetAccounts();
  hits.length = 0;
  globalThis.fetch = async (_url, init) => {
    hits.push(uidOfAuth(init).auth);
    return new Response(queueBody, {
      status: 429, headers: { "Retry-After": "40" },
    });
  };
  const exhausted = await request();
  const exhaustedBody = await exhausted.json() as { error: { code: string } };
  assert.equal(exhausted.status, 429);
  assert.equal(exhaustedBody.error.code, "upstream_queueing");
  assert.ok(Number(exhausted.headers.get("Retry-After")) > 0);
  assert.equal(hits.length, ACCOUNT_COUNT,
    `exhaustion must try every account exactly once, got ${hits.length}`);
  console.log(`PASS queue exhaustion terminates after all ${hits.length} accounts`);

  // 场景 4：单账号连续短 6020，必须在同一等待预算内继续重试到成功。
  resetAccounts();
  hits.length = 0;
  const single = byUID.get(OK_UID);
  if (!single) throw new Error("missing single-account fixture");
  accounts.splice(0, accounts.length, single);
  byUID.clear();
  byUID.set(single.uid, single);
  globalWithDb.prisma = {
    ...db,
    setting: {
      findUnique: async () => ({
        key: "config",
        value: JSON.stringify({ max_rotate: 1, pool_wait_ms: 1_000, pool_wait_poll_ms: 50 }),
      }),
    },
  };
  globalThis.fetch = async (_url, init) => {
    hits.push(uidOfAuth(init).auth);
    return hits.length <= 2
      ? new Response(queueEnvelope(0.03), { status: 429 })
      : sse();
  };
  const recovered = await request();
  assert.equal(recovered.status, 200,
    "two consecutive short queue responses must not exhaust ordinary rotation budget");
  assert.equal(hits.length, 3);
  console.log("PASS single account recovers after consecutive short 6020 responses");

  // 场景 5：持续短排队有独立硬上限，不能形成上游请求风暴。
  resetAccounts();
  hits.length = 0;
  globalThis.fetch = async (_url, init) => {
    hits.push(uidOfAuth(init).auth);
    return new Response(queueEnvelope(0.01), { status: 429 });
  };
  const bounded = await request();
  assert.equal(bounded.status, 429);
  assert.equal(hits.length, 4, "initial attempt plus at most three queue retry rounds");
  console.log("PASS persistent 6020 retries stop at the independent hard cap");
} finally {
  globalThis.fetch = oldFetch;
  if (oldPrisma === undefined) delete globalWithDb.prisma;
  else globalWithDb.prisma = oldPrisma;
}
