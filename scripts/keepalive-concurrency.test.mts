import assert from "node:assert/strict";
import test, { mock } from "node:test";

process.env.USE_CLOUDBASE_REST = "1";
let leaseReads = 0;
let leaseWrites = 0;
let leaseFailure = false;
let releaseRead: () => void = () => undefined;
let reachedRead: () => void = () => undefined;
let readGate: Promise<void> = Promise.resolve();

mock.module(new URL("../src/lib/db.ts", import.meta.url).href, {
  namedExports: {
    prisma: {
      setting: {
        findUnique: async ({ where }: { where: { key: string } }) => {
          if (where.key === "config") return { value: "{}" };
          leaseReads++;
          reachedRead();
          await readGate;
          if (leaseFailure) throw new Error("offline lease database failure");
          return null;
        },
        upsert: async () => { leaseWrites++; return {}; },
        deleteMany: async () => ({ count: 1 }),
      },
      account: { findMany: async () => [] },
      stickySession: { deleteMany: async () => ({ count: 0 }) },
    },
  },
});
const { runKeepalive } = await import("../src/lib/cron.ts");

test("同进程 cron/panel 并发保活只有一个调用进入 CloudBase 租约读写", async () => {
  const reached = new Promise<void>((resolve) => { reachedRead = resolve; });
  readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
  const first = runKeepalive({ source: "cron" });
  await reached;
  const second = runKeepalive({ source: "panel", force: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  releaseRead();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(leaseReads, 1);
  assert.equal(leaseWrites, 1);
  assert.equal(a.busy, false);
  assert.equal(b.busy, true);
  assert.equal(b.force, true);
});

test("租约查询抛错后本地保活锁始终释放，后续调用仍能执行", async () => {
  readGate = Promise.resolve();
  reachedRead = () => undefined;
  leaseFailure = true;
  await assert.rejects(runKeepalive(), /offline lease database failure/);
  leaseFailure = false;
  const result = await runKeepalive();
  assert.equal(result.busy, false);
});
