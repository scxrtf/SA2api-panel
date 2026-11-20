import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { isJSONObject, chatRequestError } from "../src/lib/request-validation.ts";

let authorized = true;
let forwarded = 0;
mock.module(new URL("../src/lib/auth-guard.ts", import.meta.url).href, {
  namedExports: {
    verifyAny: async () => authorized,
    identifyKeyIdentity: async () => authorized ? { name: "", providers: "*", unrestricted: true } : null,
  },
});
mock.module(new URL("../src/lib/chat.ts", import.meta.url).href, {
  namedExports: {
    handleChat: async () => { forwarded++; return Response.json({ ok: true }); },
    openAIError: (status: number, code: string, message: string) => Response.json({ error: { code, message } }, { status }),
  },
});
mock.module(new URL("../src/lib/agenttool-route.ts", import.meta.url).href, {
  namedExports: {
    resolveRealm: () => "cn", deepSeekSearchClient: () => false,
    compatDeepSeekSearch: (value: string) => value,
    agentToolError: () => Response.json({}, { status: 502 }),
    runAgentTool: async () => { forwarded++; throw new Error("invalid input reached upstream"); },
  },
});
mock.module(new URL("../src/lib/upstream/agenttool.ts", import.meta.url).href, {
  namedExports: { webSearch: async () => "", webFetch: async () => "" },
});

const chat = await import("../src/app/api/v1/chat/completions/route.ts");
const messages = await import("../src/app/api/v1/messages/route.ts");
const search = await import("../src/app/api/v1/search/route.ts");
const fetchRoute = await import("../src/app/api/v1/fetch/route.ts");
const request = (value: unknown) => new Request("http://localhost/api/v1/chat/completions", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
});

test("JSON 对象判定与 chat 最小契约校验", () => {
  for (const value of [null, [], "text", 0, true]) assert.equal(isJSONObject(value), false);
  assert.equal(isJSONObject({}), true);
  assert.equal(chatRequestError({ model: "model", messages: [{ role: "user", content: "hello" }] }), null);
  for (const value of [
    {}, { model: " ", messages: [] }, { model: "model", messages: null },
    { model: "model", messages: [null] }, { model: "model", messages: [{}] },
    { model: "model", messages: [{ role: "user" }], stream: "true" },
  ]) assert.ok(chatRequestError(value));
});

test("四个网关入口对 JSON null / 数组 / 标量返回 400，零上游调用", async () => {
  for (const route of [chat, messages, search, fetchRoute]) {
    for (const value of [null, [], [1], "text", 0, true]) {
      const response = await route.POST(request(value));
      assert.equal(response.status, 400);
    }
  }
  assert.equal(forwarded, 0);
});

test("chat 拦截空消息与错误 stream 类型，合法请求保持原路径", async () => {
  for (const value of [
    { model: "model", messages: [] },
    { model: "model", messages: [null] },
    { model: "model", messages: [{ role: "user" }], stream: 1 },
  ]) assert.equal((await chat.POST(request(value))).status, 400);
  assert.equal(forwarded, 0);
  assert.equal((await chat.POST(request({ model: "model", messages: [{ role: "user", content: "hello" }] }))).status, 200);
  assert.equal(forwarded, 1);
});

test("鉴权在 JSON 解析前执行，未授权请求返回 401", async () => {
  authorized = false;
  try {
    for (const route of [chat, messages, search, fetchRoute]) {
      assert.equal((await route.POST(request(null))).status, 401);
    }
  } finally { authorized = true; }
});
