import assert from "node:assert/strict";
import test, { mock } from "node:test";

let probes = 0;
let stopLoop: () => void = () => undefined;
mock.module(new URL("../src/lib/config.ts", import.meta.url).href, {
  namedExports: { getConfig: async () => ({
    schedule_checkin_disabled: true, schedule_travel_disabled: true, schedule_activity_disabled: true,
    schedule_keepalive_disabled: true, schedule_blackcat_disabled: true, schedule_growth_disabled: true,
    schedule_balance_refresh_enabled: false, schedule_model_health_enabled: true,
    schedule_model_health_minutes: 1,
  }) },
});
mock.module(new URL("../src/lib/cron.ts", import.meta.url).href, { namedExports: {} });
mock.module(new URL("../src/lib/modelhealth.ts", import.meta.url).href, {
  namedExports: {
    latestModelHealthAt: async () => null,
    runModelHealthProbe: async () => {
      probes++;
      if (probes >= 3) stopLoop(); // 原忙循环也会结束，保留确定性失败而非挂死测试。
      return { total: 0, ok: 0, failed: 0 };
    },
  },
});
mock.module(new URL("../src/lib/taskcenter.ts", import.meta.url).href, { namedExports: {
  startGrowthQueue: async () => ({}), listActiveAccounts: async () => [],
} });
const { startScheduler, stopScheduler } = await import("../src/lib/scheduler.ts");
stopLoop = stopScheduler;

test("空账号池/没有健康记录时每个周期只探测一次，不启动忙循环", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-11-11T00:00:00Z") });
  t.after(() => { stopScheduler(); t.mock.timers.reset(); });
  startScheduler();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probes, 1);
  t.mock.timers.tick(60_000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probes, 2);
});
