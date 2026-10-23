/* eslint-disable @typescript-eslint/no-explicit-any -- fake Prisma surface for offline routing tests */
import assert from "node:assert/strict";

type MemorySticky = {
  key: string;
  uid: string;
  updatedAt: Date;
};

function account(uid: string, realm: "cn" | "global") {
  return {
    uid,
    nickname: uid,
    realm,
    accessToken: "token-" + uid,
    refreshToken: "refresh-" + uid,
    expiresAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
    domain: "",
    enterpriseId: "",
    deviceToken: "",
    createdAt: new Date(),
    updatedAt: new Date(),
    state: {
      uid,
      credits: 100n,
      total: 100n,
      expiring: 0n,
      earliestAt: 0n,
      earliestRemain: 0n,
      paused: false,
      disabled: false,
      disableReason: "",
      disabledAt: 0n,
      sessionDead: false,
      sessionStrikes: 0,
      cooldownUntil: 0n,
      cooldownReason: "",
      breakerFails: 0,
      breakerUntil: 0n,
      lastUsed: 0n,
      usedSeq: 0n,
      lastCheckinDay: "",
      balanceAt: 0n,
      softStreak: 0,
      degradeUntil: 0n,
      updatedAt: new Date(),
    },
    modelCooldowns: [],
    modelCosts: [],
  };
}

const accounts = new Map([
  ["cn-1", account("cn-1", "cn")],
  ["global-1", account("global-1", "global")],
]);
const sticky = new Map<string, MemorySticky>([
  ["shared-session", { key: "shared-session", uid: "cn-1", updatedAt: new Date() }],
]);
const usageEvents: Record<string, any>[] = [];
const requestLogs: Record<string, any>[] = [];
const upstreamURLs: string[] = [];
let lastAccountWhere: Record<string, unknown> | null = null;

const db = {
  setting: {
    findUnique: async () => ({
      value: JSON.stringify({ session_sticky: true, max_rotate: 2 }),
    }),
  },
  account: {
    findMany: async () => [...accounts.values()],
    findUnique: async ({ where }: any) => accounts.get(where.uid) ?? null,
    findFirst: async ({ where }: any) => {
      lastAccountWhere = where;
      return [...accounts.values()].find((row) => (
        (!where.uid || row.uid === where.uid) &&
        (!where.realm || row.realm === where.realm)
      )) ?? null;
    },
    update: async () => undefined,
  },
  accountState: {
    upsert: async () => undefined,
  },
  modelCooldown: {
    deleteMany: async () => ({ count: 0 }),
  },
  stickySession: {
    findUnique: async ({ where }: any) => sticky.get(where.key) ?? null,
    findMany: async () => [...sticky.values()].map(({ uid }) => ({ uid })),
    update: async ({ where, data }: any) => {
      const current = sticky.get(where.key);
      if (!current) throw new Error("sticky row missing");
      const next = { ...current, ...data, updatedAt: new Date() };
      sticky.set(where.key, next);
      return next;
    },
    delete: async ({ where }: any) => {
      const current = sticky.get(where.key);
      sticky.delete(where.key);
      return current;
    },
    upsert: async ({ where, create, update }: any) => {
      const current = sticky.get(where.key);
      const next = current
        ? { ...current, ...update, updatedAt: new Date() }
        : { ...create, updatedAt: new Date() };
      sticky.set(where.key, next);
      return next;
    },
  },
  usageEvent: {
    create: async ({ data }: any) => {
      usageEvents.push(data);
      return data;
    },
  },
  requestLog: {
    create: async ({ data }: any) => {
      requestLogs.push(data);
      return data;
    },
  },
};

const oldFetch = globalThis.fetch;
const oldPrisma = (globalThis as any).prisma;
(globalThis as any).prisma = db;
const encoder = new TextEncoder();
globalThis.fetch = async (url) => {
  upstreamURLs.push(String(url));
  const payload = [
    'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream" } });
};

try {
  const { handleChat } = await import("../src/lib/chat.ts");
  const response = await handleChat({
    body: {
      model: "global:shared-model",
      conversation_id: "shared-session",
      stream: false,
      messages: [{ role: "user", content: "ping" }],
    },
    clientIP: "192.0.2.1",
    inboundHeaders: new Headers(),
    ua: "realm-routing-test",
    path: "/v1/chat/completions",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(upstreamURLs, ["https://www.workbuddy.ai/v2/chat/completions"]);
  assert.equal(usageEvents.at(-1)?.uid, "global-1");
  assert.equal(requestLogs.at(-1)?.uid, "global-1");
  assert.equal(requestLogs.at(-1)?.realm, "global");
  assert.equal(sticky.get("shared-session")?.uid, "global-1");
  console.log("PASS global model cannot reuse a sticky CN account");

  const { sampleOnce } = await import("../src/lib/aichecker.ts");
  const beforeProbe = upstreamURLs.length;
  await assert.rejects(
    sampleOnce(
      { kind: "pool", realm: "global", bare: "shared-model", uid: "cn-1" },
      "ping",
      new AbortController().signal,
      "realm-guard",
    ),
    /no available account for realm global/,
  );
  assert.equal(lastAccountWhere?.uid, "cn-1");
  assert.equal(lastAccountWhere?.realm, "global");
  assert.equal(upstreamURLs.length, beforeProbe);
  console.log("PASS explicit UID cannot bypass the requested realm");
} finally {
  globalThis.fetch = oldFetch;
  if (oldPrisma === undefined) delete (globalThis as any).prisma;
  else (globalThis as any).prisma = oldPrisma;
}
