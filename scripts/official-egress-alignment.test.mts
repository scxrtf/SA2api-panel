import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingHttpHeaders } from "node:http";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/lib/config.ts";
import { loginDoJSON } from "../src/lib/login.ts";
import { webFetch, webSearch } from "../src/lib/upstream/agenttool.ts";
import { chatHeaders } from "../src/lib/upstream/client.ts";
import { closeOfficialEgressConnections, officialEgress } from "../src/lib/upstream/official-egress.ts";

type Packet = { method: string; target: string; headers: IncomingHttpHeaders; body: string };
async function capture(run: (base: string, packets: Packet[]) => Promise<void>) {
  const packets: Packet[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    packets.push({ method: request.method ?? "", target: request.url ?? "", headers: request.headers, body });
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(request.url?.includes("/agenttool/")
      ? { content: "offline body", results: [] } : { code: 0, data: { verified: true } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try { await run(`http://127.0.0.1:${address.port}`, packets); }
  finally {
    closeOfficialEgressConnections();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("登录原生HTTP出口实收 state/token/account 路径、正文和独立头", { timeout: 5000 }, async () => {
  await capture(async (base, packets) => {
    const origin = "https://www.workbuddy.cn";
    await loginDoJSON("POST", base + "/v2/plugin/auth/state?platform=workbuddy", "", "{}", origin,
      DEFAULT_CONFIG, { clientIP: "203.0.113.42" });
    await loginDoJSON("GET", base + "/v2/plugin/auth/token?state=offline-state", "", null, origin);
    await loginDoJSON("GET", base + "/v2/plugin/account", "offline-token", null, origin);
    assert.equal(packets.length, 3);
    const [state, token, account] = packets;
    assert.equal(state.method, "POST");
    assert.equal(state.target, "/v2/plugin/auth/state?platform=workbuddy");
    assert.equal(state.body, "{}");
    assert.equal(state.headers["content-length"], "2");
    assert.equal(state.headers["content-type"], "application/json");
    for (const name of ["x-forwarded-for", "x-real-ip", "x-client-ip"]) assert.equal(state.headers[name], "203.0.113.42");
    for (const packet of [state, token]) {
      for (const name of ["authorization", "user-id", "enterprise-id", "department-info"]) {
        assert.equal(packet.headers["x-no-" + name], "true");
      }
      assert.equal(packet.headers.authorization, undefined);
      if (packet === token) {
        for (const name of ["x-forwarded-for", "x-real-ip", "x-client-ip"]) assert.equal(packet.headers[name], undefined);
      }
    }
    assert.equal(token.headers["content-type"], undefined);
    assert.equal(account.target, "/v2/plugin/account");
    assert.equal(account.headers.authorization, "Bearer offline-token");
    assert.equal(account.headers["x-domain"], "www.workbuddy.cn");
    for (const packet of packets) {
      assert.equal(packet.headers["user-agent"], "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0");
      assert.equal(packet.headers.origin, undefined);
      assert.equal(packet.headers.referer, undefined);
      assert.equal(packet.headers["x-requested-with"], undefined);
    }
  });
});

test("隐私偏好实际进入chat线缆，Global与CN使用同一判定且UA一致", { timeout: 5000 }, async () => {
  await capture(async (base, packets) => {
    for (const realm of ["cn", "global"]) {
      for (const explicit of [null, false, true]) {
        const cfg = { ...DEFAULT_CONFIG, enable_model_optimization: explicit };
        const auth = { uid: "offline-uid", nickname: "", realm, accessToken: "offline-token",
          refreshToken: "", expiresAt: 0, domain: "", enterpriseId: "", deviceToken: "" };
        const headers = chatHeaders(cfg, auth, "", { conversationID: "", cacheKeyID: "", conversationRequestID: "", traceID: "" });
        const response = await officialEgress(base + "/v2/chat/completions", { method: "POST", headers, body: "{}", proxy: null });
        await response.text();
        const packet = packets.at(-1)!;
        assert.equal(packet.headers["x-private-data"], explicit === false ? "true" : "false");
        assert.equal(packet.headers["user-agent"], realm === "global"
          ? "workbuddy-ai/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0"
          : "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0");
      }
    }
  });
});

test("工具原生fetch实收独立CLI头与完整正文，不混入chat私有/SDK头", { timeout: 5000 }, async () => {
  await capture(async (base, packets) => {
    const originalFetch = globalThis.fetch;
    const upstreamURLs: string[] = [];
    globalThis.fetch = async (input, init) => {
      const original = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(original.origin, "https://www.workbuddy.cn");
      upstreamURLs.push(original.toString());
      return originalFetch(base + original.pathname + original.search, init);
    };
    const auth = { uid: "offline-uid", nickname: "", realm: "cn", accessToken: "offline-token",
      refreshToken: "", expiresAt: 0, domain: "", enterpriseId: "", deviceToken: "" };
    try {
      await webSearch(DEFAULT_CONFIG, auth, "alpha", 0, undefined, {
        allowed_domains: ["example.com"], blocked_domains: ["blocked.example"], freshness: "d3",
        context: { conversationID: "conversation", conversationRequestID: "turn" },
      });
      await webFetch(DEFAULT_CONFIG, auth, "https://example.com/page", undefined, {
        prompt: "extract the title", model_name: "offline-model",
      });
    } finally { globalThis.fetch = originalFetch; }
    assert.equal(upstreamURLs.length, 2);
    const [search, fetch] = packets;
    assert.equal(search.target, "/agenttool/v1/search");
    assert.deepEqual(JSON.parse(search.body), {
      query: "alpha (-site:blocked.example)", type: "text2text", max_results: 5,
      allowed_domains: ["example.com"], freshness: "d3",
    });
    assert.equal(fetch.target, "/agenttool/v1/webfetch");
    assert.deepEqual(JSON.parse(fetch.body), {
      url: "https://example.com/page", format: "markdown", prompt: "extract the title",
      timeout: 20, max_length: 100000, model_name: "offline-model",
    });
    assert.equal(search.headers["x-wb-uid"], undefined);
    assert.equal(fetch.headers["x-wb-uid"], auth.uid);
    for (const packet of packets) {
      assert.equal(packet.headers["user-agent"], "CLI/5.9.3");
      assert.equal(packet.headers["content-type"], "application/json;charset=UTF-8");
      assert.equal(packet.headers["x-conversation-message-id"], packet.headers["x-request-id"]);
      assert.match(String(packet.headers["x-request-id"]), /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
      assert.equal(packet.headers["x-private-data"], undefined);
      assert.equal(packet.headers["x-stainless-runtime"], undefined);
      assert.equal(packet.headers.baggage, undefined);
      assert.equal(packet.headers.traceparent, undefined);
    }
  });
});
