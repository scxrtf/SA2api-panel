import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "./config";
import { keepaliveDue } from "./cron";

const HOUR_MS = 3600_000;
const NOW = 1_800_000_000_000;
const cfg = { ...DEFAULT_CONFIG, schedule_keepalive_refresh_before_hours: 24 };

function account(expiresAtMs: number | null, lastSuccessAgoMs: number | null) {
  return {
    expiresAt: expiresAtMs === null ? 0n : BigInt(Math.floor(expiresAtMs / 1000)),
    state: lastSuccessAgoMs === null
      ? null
      : { lastKeepaliveAt: BigInt(NOW - lastSuccessAgoMs) },
  };
}

test("known short-lived token is refreshed even after a recent success", () => {
  assert.equal(keepaliveDue(cfg, account(NOW + 2 * HOUR_MS, 30 * 60_000), NOW, false), true);
});

test("known long-lived token is skipped until it enters the refresh window", () => {
  assert.equal(keepaliveDue(cfg, account(NOW + 48 * HOUR_MS, null), NOW, false), false);
});

test("unknown expiry is refreshed once per refresh window", () => {
  assert.equal(keepaliveDue(cfg, account(null, null), NOW, false), true);
  assert.equal(keepaliveDue(cfg, account(null, 12 * HOUR_MS), NOW, false), false);
});

test("stale expiry is not retried immediately when upstream omitted expiresIn", () => {
  assert.equal(keepaliveDue(cfg, account(NOW - 2 * HOUR_MS, 30 * 60_000), NOW, false), false);
  assert.equal(keepaliveDue(cfg, account(NOW - 2 * HOUR_MS, 25 * HOUR_MS), NOW, false), true);
});

test("a token that expired after its last refresh is refreshed even if that refresh was recent", () => {
  assert.equal(keepaliveDue(cfg, account(NOW - 10 * 60_000, HOUR_MS), NOW, false), true);
});

test("force bypasses every due filter", () => {
  assert.equal(keepaliveDue(cfg, account(NOW + 48 * HOUR_MS, 30 * 60_000), NOW, true), true);
});
