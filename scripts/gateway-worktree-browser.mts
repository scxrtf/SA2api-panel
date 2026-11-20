import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Snapshot } from "../src/lib/workspace/contracts";

const qa = resolve(process.env.WB2_WORKSPACE_QA_DIR || ".runtime/workspace-qa");
const origin = new URL(process.env.WB2_WORKSPACE_QA_URL || "http://127.0.0.1:3291");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) && origin.port === "3291");
const key = process.env.WB2_WORKSPACE_QA_GATEWAY_KEY || "gateway-worktree-fixture";
const { chromium } = createRequire(join(qa, "package.json"))("playwright-core");
const candidates = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "/usr/bin/chromium", "/usr/bin/google-chrome"];
const executablePath = process.env.WB2_WORKSPACE_QA_BROWSER || candidates.find(existsSync);
const clipFn = process.env.WB2_WORKSPACE_QA_CLIP_SCRIPT ? await readFile(process.env.WB2_WORKSPACE_QA_CLIP_SCRIPT, "utf8") : undefined;
const output = resolve(process.env.WB2_WORKSPACE_QA_OUTPUT || join(qa, "gateway-captures"));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (error: Error) => errors.push(error.message));
const checks: Record<string, number> = {};
const url = (path: string) => new URL(path, origin);
const suffix = Date.now().toString(36);
const machineA = "dev-desktop-" + suffix, machineB = "dev-laptop-" + suffix;
const sessionA = "会话 A-1 " + suffix, sessionB = "会话 B-1 " + suffix, anotherA = "会话 A-2 " + suffix;
const childA = "会话 A 子分支 " + suffix;

async function capture(name: string) {
  if (clipFn) {
    const audit = await page.evaluate(`(${clipFn})({root:".aw-screen",viewport:true})`);
    assert.equal(audit.cut, 0, JSON.stringify(audit.issues?.slice(0, 3)));
    checks[name] = audit.cut;
  }
  await page.screenshot({ path: join(output, name + ".png") });
}
async function waitForIndicator(list: string, indicator: string) {
  await page.waitForFunction(({ list, indicator }: { list: string; indicator: string }) => {
    const current = document.querySelector(`${list} [aria-selected="true"]`)?.getBoundingClientRect();
    const marker = document.querySelector(indicator)?.getBoundingClientRect();
    return !!current && !!marker && marker.width > 0 && Math.abs(current.left - marker.left) < 2
      && Math.abs(current.width - marker.width) < 2;
  }, { list, indicator });
}
async function send(machine: string, id: string, prompt: string, parent?: string) {
  const response = await fetch(url("/api/v1/responses"), {
    method: "POST", headers: {
      Authorization: "Bearer " + key, "Content-Type": "application/json", "User-Agent": "Codex Desktop fixture",
      "X-WB2A-Machine-Id": machine, "X-WB2A-Session-Id": id, ...(parent ? { "X-WB2A-Parent-Session-Id": parent } : {}),
    }, body: JSON.stringify({ model: "trace-qa", input: prompt, stream: true, store: false }), signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  assert.equal(response.status, 200, body);
  assert.match(body, /response\.completed/);
}

try {
  assert.equal((await fetch(url("/api/workspace"), { method: "POST", headers: { Authorization: "Bearer " + key } })).status, 405);
  assert.equal((await fetch(url("/api/workspace/artifacts/test-only/apply"), { method: "POST", headers: { Authorization: "Bearer " + key } })).status, 404);
  await page.goto(url("/panel/").href);
  const navigation = page.getByRole("navigation", { name: "主导航" });
  const rack = page.getByRole("tablist", { name: "功能机柜" });
  const workspaceLink = navigation.getByRole("link", { name: "机器会话", exact: true });
  const workspaceTab = rack.getByRole("tab", { name: "机器会话", exact: true });
  await rack.getByRole("tab", { name: "账号池", exact: true }).waitFor();
  assert.equal(await navigation.getByRole("link").count(), 14);
  assert.equal(await rack.getByRole("tab").count(), 14);
  assert.equal(await workspaceLink.locator(".num").textContent(), "14");
  await page.getByRole("tabpanel", { name: "账号池", exact: true })
    .evaluate((panel: HTMLElement) => { panel.dataset.mountProof = "kept"; });
  await workspaceLink.click();
  await page.waitForURL("**/panel/workspace");
  await page.getByRole("heading", { name: "机器会话", exact: true }).waitFor();
  assert.equal(await workspaceLink.getAttribute("aria-current"), "page");
  assert.equal(await workspaceTab.getAttribute("aria-selected"), "true");
  assert.equal(await page.locator(".tb-idx").textContent(), "14 / 14");
  await waitForIndicator(".panel-rack-list", ".panel-rack-indicator");
  await workspaceTab.focus();
  await workspaceTab.press("ArrowLeft");
  const logTab = rack.getByRole("tab", { name: "运行日志", exact: true });
  assert.equal(await logTab.evaluate((tab: HTMLElement) => tab === document.activeElement), true);
  assert.equal(await logTab.getAttribute("aria-selected"), "false");
  await logTab.press("Enter");
  await page.waitForURL("**/panel/?view=logs");
  await page.getByRole("tabpanel", { name: "运行日志", exact: true }).waitFor();
  await waitForIndicator(".panel-rack-list", ".panel-rack-indicator");
  await page.goBack();
  await page.waitForURL("**/panel/workspace");
  assert.equal(await page.locator('[data-mount-proof="kept"]').count(), 1);
  await page.getByText("实时观测", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("任务内容").count(), 0);
  assert.equal(await page.getByLabel("面板主密钥").count(), 0);
  await send(machineA, "same-thread", sessionA);
  await page.getByRole("heading", { name: machineA }).waitFor();
  await page.getByRole("button", { name: new RegExp(sessionA) }).click();
  const light = page.locator("svg[data-light-layer] g");
  const follow = send(machineA, "same-thread", "桌面端第二轮 " + suffix);
  await light.first().waitFor({ state: "attached" });
  await capture("gateway-live-light");
  await follow;
  await send(machineB, "same-thread", sessionB);
  await send(machineA, "other-thread", anotherA);
  await send(machineA, "child-thread", childA, "same-thread");
  await page.getByRole("heading", { name: machineB }).waitFor();
  await page.getByRole("textbox", { name: "搜索机器或会话" }).fill(machineB);
  assert.equal(await page.getByRole("heading", { name: machineA }).count(), 0);
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await page.getByRole("heading", { name: machineA }).waitFor();
  await page.getByRole("button", { name: /客户端上报分支/ }).waitFor();
  const answer = await page.request.get(url("/api/workspace").href);
  assert.equal(answer.status(), 200);
  const snapshot = await answer.json() as Snapshot;
  const a = snapshot.sessions.find((s) => s.name === sessionA)!;
  const b = snapshot.sessions.find((s) => s.name === sessionB)!;
  assert.notEqual(a.rootId, b.rootId);
  assert.notEqual(a.gateway?.machineId, b.gateway?.machineId);
  assert.equal(snapshot.sessions.find((s) => s.name === childA)?.rootId, a.rootId);
  assert.notEqual(snapshot.sessions.find((s) => s.name === anotherA)?.rootId, a.rootId);
  await page.getByRole("button", { name: new RegExp(sessionB) }).click();
  await page.getByLabel("客户端会话").getByRole("heading", { name: sessionB, exact: true, level: 2 }).waitFor();
  assert.equal(await page.getByLabel("客户端会话").getByText(sessionA, { exact: true }).count(), 0);
  await page.getByRole("button", { name: new RegExp(sessionA) }).click();
  await page.getByRole("button", { name: /客户端上报分支/ }).waitFor();
  await page.getByRole("button", { name: /客户端上报分支/ }).click();
  await page.getByLabel("客户端会话").getByRole("heading", { name: childA, exact: true, level: 2 }).waitFor();
  await rack.getByRole("tab", { name: "账号池", exact: true }).click();
  await page.waitForURL("**/panel/");
  await workspaceLink.click();
  await page.getByLabel("客户端会话").getByRole("heading", { name: childA, exact: true, level: 2 }).waitFor();
  await page.getByRole("button", { name: /客户端上报分支/ }).click();
  await page.reload();
  await page.getByRole("button", { name: /客户端上报分支/ }).waitFor();
  assert.equal(await light.count(), 0);
  await capture("gateway-reloaded");
  await page.setViewportSize({ width: 390, height: 844 });
  const workbenchTabs = page.getByRole("tablist", { name: "会话面板" });
  const chat = workbenchTabs.getByRole("tab", { name: "会话", exact: true });
  const tree = workbenchTabs.getByRole("tab", { name: "工作树", exact: true });
  await chat.focus();
  await chat.press("ArrowRight");
  await tree.press("Enter");
  assert.equal(await tree.getAttribute("aria-selected"), "true");
  await waitForIndicator(".aw-mobile-tabs", ".aw-tab-indicator");
  await page.getByRole("button", { name: /客户端上报分支/ }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await capture("gateway-mobile");
  await page.getByRole("button", { name: "展开导航", exact: true }).click();
  assert.equal(await workspaceLink.getAttribute("aria-current"), "page");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("button", { name: "展开导航", exact: true }).evaluate((tab: HTMLElement) => tab === document.activeElement), true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const motion = await page.locator(".aw-tab-indicator").evaluate((mark: HTMLElement) => getComputedStyle(mark).transitionProperty);
  assert.equal(motion, "none");
  assert.deepEqual(errors, []);
  await writeFile(join(output, "checks.json"), JSON.stringify({ checks, errors, workflow: "14 synchronized panel tabs, keyboard, indicator alignment, retained panels, filtered machine list, independent gateway sessions, live light, compact workbench" }, null, 2));
  console.log("Gateway browser check: 14 synchronized tabs, retained panels, keyboard and mobile navigation, filtering, session isolation, client fork, live light and reload passed.");
} finally {
  await browser.close();
}
