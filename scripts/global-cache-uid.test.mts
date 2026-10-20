// global-cache-uid.test.mts — global 探测缓存按账号 uid 隔离测试（mock fetch，离线）。
import assert from "node:assert/strict";
import { fetchGlobalModelInfos } from "file:///C:/Users/16321/Downloads/workbuddy2api-panel-main/wb2api-next/src/lib/upstream/modelCatalog.ts";

// mock fetch：任何探测请求都按 Authorization 头里的 token 返回不同模型名单，
// 并记录每 token 的请求次数。命中缓存的第二次调用不得再发网。
const fetchCount = new Map<string, number>();
const origFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const headers = new Headers(init?.headers as HeadersInit);
  const auth = headers.get("authorization") ?? "";
  const token = auth.replace(/^bearer\s+/i, "") || "none";
  fetchCount.set(token, (fetchCount.get(token) ?? 0) + 1);
  const model = token === "tok-A" ? "model-from-A" : "model-from-B";
  return new Response(JSON.stringify({ code: 0, data: { models: [
    { id: model, maxInputTokens: 100000, maxOutputTokens: 8000 },
  ] } }), { status: 200, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

type Obj = Record<string, unknown>;
const cfg = {} as never;
const acctA = { uid: "uid-A", nickname: "A", realm: "global", accessToken: "tok-A", refreshToken: "", expiresAt: 0, domain: "", enterpriseId: "", deviceToken: "" };
const acctB = { uid: "uid-B", nickname: "B", realm: "global", accessToken: "tok-B", refreshToken: "", expiresAt: 0, domain: "", enterpriseId: "", deviceToken: "" };

let n = 0;
function t(name: string, cond: boolean, extra = "") {
  assert.ok(cond, name + " " + extra);
  n++;
  console.log("PASS " + name);
}

// A 首次：探测 → model-from-A。
const r1 = await fetchGlobalModelInfos(cfg, acctA as never);
t("A 首次探测返回 A 的模型", r1.names.includes("model-from-A"), JSON.stringify(r1.names));
const countA1 = fetchCount.get("tok-A") ?? 0;
t("A 首次发了网", countA1 > 0, "count=" + countA1);

// A 第二次：1h 缓存命中，零新请求。
const r2 = await fetchGlobalModelInfos(cfg, acctA as never);
t("A 第二次命中缓存", r2.names.includes("model-from-A"));
t("A 第二次未发网", (fetchCount.get("tok-A") ?? 0) === countA1);

// B 首次：不得命中 A 的缓存——独立探测，拿到 B 的模型。
const r3 = await fetchGlobalModelInfos(cfg, acctB as never);
t("B 不受 A 缓存污染（拿到自己的模型）", r3.names.includes("model-from-B") && !r3.names.includes("model-from-A"), JSON.stringify(r3.names));
t("B 首次发了网", (fetchCount.get("tok-B") ?? 0) > 0);

// B 第二次：B 自己的缓存命中。
const countB1 = fetchCount.get("tok-B") ?? 0;
const r4 = await fetchGlobalModelInfos(cfg, acctB as never);
t("B 第二次命中自己的缓存", r4.names.includes("model-from-B"));
t("B 第二次未发网", (fetchCount.get("tok-B") ?? 0) === countB1);

globalThis.fetch = origFetch;
console.log("\n" + n + " 项 global 缓存 uid 隔离测试全部 PASS");