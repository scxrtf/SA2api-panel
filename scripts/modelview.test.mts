// modelview.test.mts — 对齐 Go modelview_test.go 的 9 个场景（离线纯函数）。
import assert from "node:assert/strict";
import { modelLockViewPure, type LockViewEntry } from "file:///C:/Users/16321/Downloads/workbuddy2api-panel-main/wb2api-next/src/lib/modelview.ts";

const NOW = Date.now();
const H = 3600_000;
const noFull = () => false;

function acct(uid: string, realm = "cn", over: Partial<LockViewEntry> = {}): LockViewEntry {
  return { uid, realm, disabled: false, paused: false, accountUnavailableUntil: 0, modelCooldowns: [], ...over };
}
function lock(model: string, until: number, reason: string) {
  return { model, until, reason };
}

let n = 0;
function t(name: string, fn: () => void) {
  fn(); n++; console.log("PASS " + name);
}

t("Empty → null", () => {
  assert.equal(modelLockViewPure([acct("u1"), acct("u2")], NOW, noFull), null);
});

t("Partial：锁一个号，带出可选/总数/最早解锁/原因", () => {
  const rows = modelLockViewPure([
    acct("u1", "cn", { modelCooldowns: [lock("glm-5.3", NOW + H, "6004 model rate limit")] }),
    acct("u2"),
  ], NOW, noFull)!;
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.model, "glm-5.3");
  assert.equal(r.realm, "cn");
  assert.equal(r.total, 2);
  assert.equal(r.locked, 1);
  assert.equal(r.servable, 1);
  assert.equal(r.state, "partial");
  assert.equal(r.reason, "6004 model rate limit");
  const d = Date.parse(r.unlock_at) - NOW;
  assert.ok(d > 50 * 60_000 && d < 70 * 60_000, "unlock_at 应约 1h 后: " + d);
  assert.equal(r.fully_unlock_at, r.unlock_at);
});

t("Locked：全锁 → 最早 min / 全解 max / 原因取最早", () => {
  const rows = modelLockViewPure([
    acct("u1", "cn", { modelCooldowns: [lock("glm-5.3", NOW + 2 * H, "reason-late")] }),
    acct("u2", "cn", { modelCooldowns: [lock("glm-5.3", NOW + H, "reason-early")] }),
  ], NOW, noFull)!;
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.state, "locked");
  assert.equal(r.servable, 0);
  assert.equal(r.locked, 2);
  assert.equal(r.total, 2);
  assert.equal(r.reason, "reason-early");
  const d1 = Date.parse(r.unlock_at) - NOW;
  const d2 = Date.parse(r.fully_unlock_at) - NOW;
  assert.ok(d1 > 50 * 60_000 && d1 < 70 * 60_000);
  assert.ok(d2 > 110 * 60_000 && d2 < 130 * 60_000);
});

t("Starved：模型没全锁但此刻没号（账号级冷却）", () => {
  const rows = modelLockViewPure([
    acct("u1", "cn", { modelCooldowns: [lock("glm-5.3", NOW + H, "6004 model rate limit")] }),
    acct("u2", "cn", { accountUnavailableUntil: NOW + H }), // CoolHard 等价
  ], NOW, noFull)!;
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.servable, 0);
  assert.equal(r.locked, 1);
  assert.equal(r.total, 2);
  assert.equal(r.state, "starved");
});

t("SkipsExpired：已过期冷却不算锁", () => {
  const rows = modelLockViewPure([
    acct("u1", "cn", { modelCooldowns: [lock("glm-5.3", NOW - 60_000, "6004")] }),
    acct("u2"),
  ], NOW, noFull);
  assert.equal(rows, null);
});

t("SkipsDisabled：禁用号不计分母", () => {
  const rows = modelLockViewPure([
    acct("u1", "cn", { modelCooldowns: [lock("glm-5.3", NOW + H, "6004")] }),
    acct("u2", "cn", { disabled: true }),
  ], NOW, noFull)!;
  assert.equal(rows[0].total, 1);
  assert.equal(rows[0].state, "locked");
});

t("SkipsPaused：暂停号不计分母", () => {
  const rows = modelLockViewPure([
    acct("u1", "cn", { modelCooldowns: [lock("glm-5.3", NOW + H, "6004")] }),
    acct("u2", "cn", { paused: true }),
  ], NOW, noFull)!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total, 1);
});

t("RealmIsolation：同名模型 cn/global 各自独立", () => {
  const rows = modelLockViewPure([
    acct("cn1", "cn", { modelCooldowns: [lock("glm-5.3", NOW + H, "6004 cn")] }),
    acct("cn2", "cn"),
    acct("g1", "global", { modelCooldowns: [lock("glm-5.3", NOW + H, "6004 global")] }),
    acct("g2", "global"),
  ], NOW, noFull)!;
  assert.equal(rows.length, 2);
  const cn = rows.find((r) => r.realm === "cn")!;
  const g = rows.find((r) => r.realm === "global")!;
  assert.equal(cn.total, 2); assert.equal(cn.locked, 1); assert.equal(cn.reason, "6004 cn");
  assert.equal(g.total, 2); assert.equal(g.locked, 1); assert.equal(g.reason, "6004 global");
});

t("SortsLockedFirst：整池不可用排前", () => {
  const rows = modelLockViewPure([
    acct("u1", "cn", { modelCooldowns: [
      lock("glm-5.3", NOW + H, "6004"),
      lock("kimi-k2", NOW + H, "6004"),
    ] }),
    acct("u2", "cn", { modelCooldowns: [lock("glm-5.3", NOW + H, "6004")] }),
  ], NOW, noFull)!;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].state, "locked");
  assert.equal(rows[1].state, "partial");
  assert.equal(rows[0].model, "glm-5.3");
});

t("InFlightFull 不计 servable → starved", () => {
  const rows = modelLockViewPure([
    acct("u1", "cn", { modelCooldowns: [lock("glm-5.3", NOW + H, "6004")] }),
    acct("u2"),
  ], NOW, (uid) => uid === "u2")!;
  assert.equal(rows[0].servable, 0);
  assert.equal(rows[0].state, "starved");
});

console.log("\n" + n + " 项 modelview 聚合测试全部 PASS");