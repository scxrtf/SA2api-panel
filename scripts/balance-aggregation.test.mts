import assert from "node:assert/strict";
import test from "node:test";
import { snapshotBalance } from "../src/lib/balance.ts";

test("折叠余额首值为 0 时保留正确的窗口变化、日变化与最小值", async () => {
  const [series] = await snapshotBalance(0, {}, {}, [{
    uid: "offline-balance-zero", at: new Date("2026-10-01T01:00:00Z"),
    credits: 10n, day: "2026-10-01", first: 0n, consumed: 0n, gained: 10n,
  }]);
  assert.equal(series.min, 0);
  assert.equal(series.max, 10);
  assert.equal(series.change, 10);
  assert.equal(series.daily[0].first, 0);
  assert.equal(series.daily[0].min, 0);
  assert.equal(series.daily[0].change, 10);
});

test("缺少首值的历史折叠记录仍回退到末值", async () => {
  const [series] = await snapshotBalance(0, {}, {}, [{
    uid: "offline-balance-missing", at: new Date("2026-10-01T01:00:00Z"),
    credits: 10n, day: "2026-10-01", first: null, consumed: null, gained: null,
  }]);
  assert.equal(series.min, 10);
  assert.equal(series.change, 0);
  assert.equal(series.daily[0].first, 10);
});

test("非零首值与空结果保持原有聚合语义", async () => {
  const [series] = await snapshotBalance(0, {}, {}, [{
    uid: "offline-balance", at: new Date("2026-10-01T01:00:00Z"),
    credits: 10n, day: "2026-10-01", first: 20n, consumed: 10n, gained: 0n,
  }]);
  assert.equal(series.min, 10);
  assert.equal(series.max, 20);
  assert.equal(series.change, -10);
  assert.equal(series.daily[0].change, -10);
  assert.deepEqual(await snapshotBalance(0, {}, {}, []), []);
});

test("同日分批折叠的余额使用下一段首值衔接，不重复累计段内涨跌", async () => {
  const [series] = await snapshotBalance(0, {}, {}, [
    { uid: "offline-folds", at: new Date("2026-10-01T01:00:00Z"), credits: 800n,
      day: "2026-10-01", first: 1000n, consumed: 200n, gained: 0n },
    { uid: "offline-folds", at: new Date("2026-10-01T02:00:00Z"), credits: 900n,
      day: "2026-10-01", first: 700n, consumed: 0n, gained: 200n },
  ]);
  const day = series.daily[0];
  assert.equal(day.first, 1000);
  assert.equal(day.last, 900);
  assert.equal(day.consumed, 300);
  assert.equal(day.gained, 200);
  assert.equal(day.gained - day.consumed, day.change);
});
