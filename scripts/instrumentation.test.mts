import assert from "node:assert/strict";
import test, { mock } from "node:test";

let started = 0;
mock.module(new URL("../src/lib/scheduler.ts", import.meta.url).href, {
  namedExports: { startScheduler: () => { started++; } },
});
const { register } = await import("../src/instrumentation.ts");

test("隔离验证可关闭scheduler，正常Node启动仍启用，Edge不启动", async () => {
  const originalRuntime = process.env.NEXT_RUNTIME;
  const originalDisabled = process.env.WB2A_DISABLE_SCHEDULER;
  try {
    process.env.NEXT_RUNTIME = "nodejs";
    process.env.WB2A_DISABLE_SCHEDULER = "1";
    await register();
    assert.equal(started, 0);
    delete process.env.WB2A_DISABLE_SCHEDULER;
    await register();
    assert.equal(started, 1);
    process.env.NEXT_RUNTIME = "edge";
    await register();
    assert.equal(started, 1);
  } finally {
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
    if (originalDisabled === undefined) delete process.env.WB2A_DISABLE_SCHEDULER;
    else process.env.WB2A_DISABLE_SCHEDULER = originalDisabled;
  }
});
