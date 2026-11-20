import assert from "node:assert/strict";
import test, { mock } from "node:test";

process.env.USE_CLOUDBASE_REST = "0";
type State = { uid: string; credits: bigint; expiring: bigint; earliestRemain: bigint; earliestAt: bigint; cooldownReason: string };
const states = new Map<string, State>();
const costs = new Map<string, Record<string, unknown>>();
let reads = 0;
let blockedUID = "";
let gate: Promise<void> = Promise.resolve();
let releaseGate: () => void = () => undefined;
let failNextWrite = false;
function stateOf(uid: string): State {
  let state = states.get(uid);
  if (!state) {
    state = { uid, credits: 100n, expiring: 60n, earliestRemain: 30n, earliestAt: BigInt(Date.now() + 3600_000), cooldownReason: "" };
    states.set(uid, state);
  }
  return state;
}
mock.module(new URL("../src/lib/db.ts", import.meta.url).href, {
  namedExports: { prisma: {
    accountState: {
      findUnique: async ({ where }: { where: { uid: string } }) => {
        const snapshot = { ...stateOf(where.uid) };
        reads++;
        if (where.uid === blockedUID) await gate;
        return snapshot;
      },
      upsert: async ({ where, update }: { where: { uid: string }; update: Partial<State> }) => {
        if (failNextWrite) { failNextWrite = false; throw new Error("offline settlement failure"); }
        return Object.assign(stateOf(where.uid), update);
      },
    },
    modelCost: {
      findUnique: async ({ where }: { where: { uid_model: { uid: string; model: string } } }) =>
        costs.get(JSON.stringify(where.uid_model)) ?? null,
      upsert: async ({ where, create }: { where: { uid_model: { uid: string; model: string } }; create: Record<string, unknown> }) => {
        costs.set(JSON.stringify(where.uid_model), { ...create }); return create;
      },
      update: async ({ where, data }: { where: { uid_model: { uid: string; model: string } }; data: Record<string, unknown> }) => {
        costs.set(JSON.stringify(where.uid_model), data); return data;
      },
    },
  } },
});
const { noteModelCost, setCreditsDetailed } = await import("../src/lib/pool.ts");
function block(uid: string): void {
  blockedUID = uid;
  reads = 0;
  gate = new Promise<void>((resolve) => { releaseGate = resolve; });
}
async function nextTurn(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

test("同账号两条流结算不丢扣费，也不丢模型 token 累计", async () => {
  const uid = "offline-concurrent";
  block(uid);
  const first = noteModelCost(uid, "same-model", 10, 1000);
  const second = noteModelCost(uid, "same-model", 20, 1000);
  await nextTurn();
  const readersBeforeRelease = reads;
  releaseGate();
  await Promise.all([first, second]);
  assert.equal(stateOf(uid).credits, 70n);
  assert.equal(stateOf(uid).expiring, 30n);
  assert.equal(stateOf(uid).earliestRemain, 0n);
  assert.equal(readersBeforeRelease, 1, "只有队首应读取余额快照");
  assert.equal(costs.get(JSON.stringify({ uid, model: "same-model" }))?.tokens, 2000);
});

test("权威余额刷新与聊天结算共用同一账号写入边界", async () => {
  const uid = "offline-authoritative";
  block(uid);
  const first = noteModelCost(uid, "one", 10, 1000);
  const refresh = setCreditsDetailed(uid, 200n, 200n, 0n, 0n, 0n);
  const second = noteModelCost(uid, "two", 20, 1000);
  await nextTurn();
  releaseGate();
  await Promise.all([first, refresh, second]);
  assert.equal(stateOf(uid).credits, 180n);
});

test("单个结算失败不阻塞后续写入，空闲账号的队列会清理", async () => {
  blockedUID = "";
  failNextWrite = true;
  const uid = "offline-failure";
  const first = noteModelCost(uid, "one", 10, 1000);
  const second = noteModelCost(uid, "two", 20, 1000);
  await assert.rejects(first, /offline settlement failure/);
  await second;
  assert.equal(stateOf(uid).credits, 80n);
  await nextTurn();
  const queues = (globalThis as unknown as { __wbBalanceWrites?: Map<string, Promise<void>> }).__wbBalanceWrites;
  assert.equal(queues?.size ?? 0, 0);
});

test("不同账号各自结算，不被其他账号的慢写入串行阻塞", async () => {
  block("offline-slow");
  const slow = noteModelCost("offline-slow", "one", 10, 1000);
  let fastDone = false;
  const fast = noteModelCost("offline-fast", "one", 10, 1000).then(() => { fastDone = true; });
  await nextTurn();
  const completedBeforeRelease = fastDone;
  releaseGate();
  await Promise.all([slow, fast]);
  assert.equal(completedBeforeRelease, true);
});
