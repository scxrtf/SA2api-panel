import assert from "node:assert/strict";
import test from "node:test";
import { NAV, isPanelView, pad2, panelHref, panelView } from "../src/app/panel/nav";

test("机器会话是同一份面板注册表里的第 14 项", () => {
  assert.equal(NAV.length, 14);
  assert.equal(new Set(NAV.map(({ id }) => id)).size, 14);
  assert.equal(NAV.at(-1)?.id, "workspace");
  assert.equal(pad2(NAV.findIndex(({ id }) => id === "workspace") + 1), "14");
});

test("内部标签地址、原机器会话书签和回退选择一致", () => {
  for (const { id } of NAV) {
    const parsed = new URL(panelHref(id), "http://localhost");
    assert.equal(panelView(parsed.pathname, parsed.searchParams.get("view")), id);
  }
  assert.equal(panelView("/panel/workspace/", "logs"), "workspace");
  assert.equal(panelView("/panel", "workspace"), "accounts");
  assert.equal(panelView("/panel", "unknown"), "accounts");
  assert.equal(isPanelView(null), false);
});
