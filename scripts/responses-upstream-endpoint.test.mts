import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { POST as checkerProxy } from "../src/app/api/panel/aichecker/proxy/[kind]/route";
import { nativeResponsesConfig, relayNativeResponses, responsesEndpoint } from "../src/lib/responses-native";

test("Responses upstream normalization preserves custom prefixes and strips only known endpoint suffixes", () => {
  const cases = [
    ["https://api.example.test", "/v1/responses"],
    ["https://api.example.test/gateway/", "/gateway/responses"],
    ["https://api.example.test/gateway/v2/responses/", "/gateway/v2/responses"],
    ["https://api.example.test/gateway/v1/responses/responses", "/gateway/v1/responses"],
    ["https://api.example.test/gateway/v1/responses/v1/responses", "/gateway/v1/responses"],
    ["https://api.example.test/gateway/v1/responses/compact", "/gateway/v1/responses"],
    ["https://api.example.test/gateway/v1/chat/completions", "/gateway/v1/responses"],
    ["https://api.example.test/gateway/chat/completions", "/gateway/responses"],
    ["https://api.example.test/responses/team/v3", "/responses/team/v3/responses"],
  ];
  for (const [base, expected] of cases) {
    const url = responsesEndpoint(base, "responses");
    assert.equal(url.origin, "https://api.example.test");
    assert.equal(url.pathname, expected, base);
    assert.equal(responsesEndpoint(base, "compact").pathname, expected + "/compact");
    assert.equal(responsesEndpoint(base, "input_tokens").pathname, expected + "/input_tokens");
    assert.equal(responsesEndpoint(base, "input_items", "resp_test").pathname, expected + "/resp_test/input_items");
  }
  assert.equal(responsesEndpoint("http://127.0.0.1:9999", "responses").pathname, "/v1/responses");
  for (const base of [
    "http://api.example.test/v1/responses",
    "https://name:password@api.example.test/v1",
    "https://api.example.test/v1?query=true",
    "https://api.example.test/v1#fragment",
  ]) assert.throws(() => responsesEndpoint(base, "responses"), /Invalid Responses upstream/);
});

test("native relay and checker use the normalized path and attribute genuine upstream 405 without retries", async (t) => {
  const calls: { method: string; path: string; input: string }[] = [];
  const server = createServer(async (req, res) => {
    const bytes: Buffer[] = [];
    for await (const chunk of req) bytes.push(Buffer.from(chunk));
    const { input } = JSON.parse(Buffer.concat(bytes).toString()) as { input: string };
    calls.push({ method: req.method ?? "", path: req.url ?? "", input });
    if (input === "wrong method") {
      res.writeHead(405, { "Content-Type": "text/html", "X-Request-Id": "upstream-405" });
      res.end("<p>provider-specific error</p>");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "resp_fixture", object: "response", status: "completed" }));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fixtureEnv = {
    WB2A_RESPONSES_UPSTREAM: origin + "/provider/v1/chat/completions",
    WB2A_RESPONSES_KEY: "native-fixture",
    WB2A_RESPONSES_MODELS: "fixture-model",
  };
  const previousEnv = Object.keys(fixtureEnv).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, fixtureEnv);
  t.after(() => {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const cfg = nativeResponsesConfig();
  assert.ok(cfg);
  const req = new Request("http://localhost/api/v1/responses", { method: "POST" });
  const native = (input: string) => relayNativeResponses(req, cfg, "responses", "owner-fixture", "fixture-model", {
    model: "fixture-model", input, store: false,
  });
  const check = (input: string) => checkerProxy(new Request("http://localhost/api/panel/aichecker/proxy/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Target-Base-URL": origin + "/provider/v1/responses/v1/responses",
    },
    body: JSON.stringify({ model: "fixture-model", input, store: false }),
  }), { params: Promise.resolve({ kind: "responses" }) });

  assert.equal((await native("normal")).status, 200);
  const bad = await native("wrong method");
  assert.equal(bad.status, 502);
  assert.equal(bad.headers.get("x-request-id"), "upstream-405");
  const diagnostic = await bad.json() as { error: { code: string; message: string } };
  assert.equal(diagnostic.error.code, "responses_upstream_method_not_allowed");
  assert.match(diagnostic.error.message, /HTTP 405.*POST.*WB2A_RESPONSES_UPSTREAM/);
  assert.doesNotMatch(diagnostic.error.message, /provider-specific error/);

  assert.equal((await check("normal")).status, 200);
  const checkerError = await check("wrong method");
  assert.equal(checkerError.status, 502);
  assert.match((await checkerError.json() as { error: string }).error, /目标上游.*HTTP 405/);
  assert.deepEqual(calls, ["normal", "wrong method", "normal", "wrong method"].map((input) => ({
    method: "POST", path: "/provider/v1/responses", input,
  })));
});
