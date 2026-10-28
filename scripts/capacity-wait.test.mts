// 离线验证容量等待、6020 短冷却恢复、客户端中止与限流并发收缩；不访问真实上游。
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, type AppConfig } from "../src/lib/config.ts";
import { sleepAbortable } from "../src/lib/backoff.ts";
import {
  acquire, applyErrorKind, capacityWaitStatus, inFlightCount, noteSuccess, pick, release,
} from "../src/lib/pool.ts";

const globalWithDb = globalThis as typeof globalThis & { prisma?: unknown };
const oldPrisma = globalWithDb.prisma;
const now = Date.now();
const model = "capacity-model";
const makeAccount = (uid: string) => ({
  uid, realm: "cn", accessToken: "offline-" + uid, refreshToken: "", expiresAt: 0n,
  domain: "", enterpriseId: "", deviceToken: "",
  state: {
    uid, disabled: false, paused: false, credits: 0n,
    cooldownUntil: 0n, breakerUntil: 0n, degradeUntil: 0n, cooldownReason: "",
    softStreak: 0,
  },
  modelCooldowns: [] as { uid: string; model: string; until: bigint; reason: string }[],
  modelCosts: [],
});
const account = makeAccount("capacity-account");
const cfg: AppConfig = {
  ...DEFAULT_CONFIG, max_in_flight: 2, pool_wait_ms: 1_000, pool_wait_poll_ms: 20,
};

try {
  globalWithDb.prisma = {
    account: { findMany: async () => [account], findUnique: async () => null },
    accountState: {
      findUnique: async () => account.state,
      upsert: async ({ create, update }: {
        create: Partial<typeof account.state>;
        update: Partial<typeof account.state>;
      }) => {
        Object.assign(account.state, create, update);
        return account.state;
      },
    },
    modelCooldown: {
      deleteMany: async () => ({ count: 0 }),
      upsert: async ({ create, update }: {
        create: { uid: string; model: string; until: bigint; reason: string };
        update: { until: bigint; reason: string };
      }) => {
        const existing = account.modelCooldowns.find((item) => item.model === create.model);
        if (existing) Object.assign(existing, update);
        else account.modelCooldowns.push({ ...create });
        return existing ?? create;
      },
    },
  };

  const first = await pick(cfg, { model, realm: "cn" });
  const second = await pick(cfg, { model, realm: "cn" });
  assert.ok(first && second);
  assert.equal(acquire(first, cfg), true);
  assert.equal(acquire(second, cfg), true);
  assert.equal(inFlightCount(account.uid), 2);
  assert.equal(await pick(cfg, { model, realm: "cn" }), null);
  const waiting = capacityWaitStatus(cfg, { model, realm: "cn" }, 1_000);
  await new Promise((resolve) => setTimeout(resolve, 60));
  release(account.uid);
  assert.ok((await waiting).waitMs > 0, "full in-flight capacity should be waitable");
  assert.equal((await capacityWaitStatus(cfg, { model, realm: "cn" }, 1_000)).reason, "ready");
  console.log("PASS in-flight release makes a waiting request routable");

  release(account.uid);
  const tried = new Set([account.uid]);
  account.modelCooldowns = [{
    uid: account.uid, model, until: BigInt(Date.now() + 100), reason: "6020 queue: offline",
  }];
  const queueWait = await capacityWaitStatus(cfg, { model, realm: "cn", tried }, 1_000);
  assert.ok(queueWait.waitMs > 0 && queueWait.waitMs <= 100);
  assert.ok(await sleepAbortable(queueWait.waitMs));
  account.modelCooldowns = [];
  tried.clear(); // 与 chat/agenttool 在 6020 冷却结束后的重选规则一致。
  assert.equal((await pick(cfg, { model, realm: "cn", tried }))?.account.uid, account.uid);
  console.log("PASS short 6020 cooldown permits bounded retry after all accounts queued");

  account.state.cooldownUntil = BigInt(now + 30_000);
  account.state.cooldownReason = "soft_rate: 429";
  assert.equal((await capacityWaitStatus(cfg, { model, realm: "cn" }, 1_000)).waitMs, -1);
  console.log("PASS ordinary long 429 cooldown never parks a request");

  account.state.cooldownUntil = 0n;
  account.state.cooldownReason = "";
  const controller = new AbortController();
  const started = Date.now();
  const aborted = sleepAbortable(10_000, controller.signal);
  controller.abort();
  assert.equal(await aborted, false);
  assert.ok(Date.now() - started < 100, "abort must clear the capacity timer immediately");
  console.log("PASS client abort interrupts capacity waiting");

  await applyErrorKind(cfg, account.uid, "soft_rate", "429 offline", model, 0);
  account.state.cooldownUntil = 0n;
  const underPressure = await pick(cfg, { model, realm: "cn" });
  assert.ok(underPressure && acquire(underPressure, cfg));
  assert.equal(acquire(underPressure, cfg), false, "429 must shrink account concurrency to one");
  release(account.uid);
  for (let i = 0; i < 3; i++) await noteSuccess(account.uid);
  assert.equal(acquire(underPressure, cfg), true);
  assert.equal(acquire(underPressure, cfg), true, "three successes must restore configured concurrency");
  release(account.uid);
  release(account.uid);
  console.log("PASS upstream pressure shrinks concurrency and three successes restore it");

  const unlimitedCfg = { ...cfg, max_in_flight: 0 };
  await applyErrorKind(cfg, account.uid, "soft_rate", "429 offline", model, 0);
  account.state.cooldownUntil = 0n;
  assert.equal(acquire(underPressure, unlimitedCfg), true);
  assert.equal(acquire(underPressure, unlimitedCfg), true,
    "upstream pressure must not override explicitly unlimited concurrency");
  release(account.uid);
  release(account.uid);
  console.log("PASS unlimited in-flight remains unlimited under upstream pressure");
} finally {
  if (oldPrisma === undefined) delete globalWithDb.prisma;
  else globalWithDb.prisma = oldPrisma;
}
