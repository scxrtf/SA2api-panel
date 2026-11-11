import assert from "node:assert/strict";
import test from "node:test";
import { balanceDueAt } from "../src/lib/scheduler.ts";

test("余额刷新在进程启动后立即到期", () => {
  const now = Date.parse("2026-11-11T15:00:00.000Z");
  assert.equal(balanceDueAt(null, 30 * 60_000, now), now);
});

test("余额刷新按上次执行时间排下一周期", () => {
  const lastRunAt = Date.parse("2026-11-11T15:00:00.000Z");
  assert.equal(balanceDueAt(lastRunAt, 30 * 60_000), lastRunAt + 30 * 60_000);
});

test("配置重排保留已等待时间，缩短间隔可立即补跑", () => {
  const lastRunAt = Date.parse("2026-11-11T15:00:00.000Z");
  const now = lastRunAt + 20 * 60_000;
  assert.ok(balanceDueAt(lastRunAt, 10 * 60_000, now) <= now);
  assert.equal(balanceDueAt(lastRunAt, 60 * 60_000, now), lastRunAt + 60 * 60_000);
});
