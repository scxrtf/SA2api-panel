// Agent 上游业务信封与取消传播回归（离线，无网络）。
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/lib/config.ts";
import { UpstreamError } from "../src/lib/upstream/errors.ts";
import { webFetch, webSearch } from "../src/lib/upstream/agenttool.ts";
import type { AuthShape } from "../src/lib/upstream/client.ts";

const auth = {
  uid: "offline", nickname: "", realm: "cn", accessToken: "offline-token",
  refreshToken: "", expiresAt: 0, domain: "", enterpriseId: "", deviceToken: "",
} as AuthShape;
const oldFetch = globalThis.fetch;

try {
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: 6020, msg: "queue.waiting.title", data: { retry_after: 1.25 },
  }), { status: 200 });
  await assert.rejects(
    webSearch(DEFAULT_CONFIG, auth, "offline", 5),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.kind, "soft_queue");
      assert.equal(error.retryAfterMs, 1250);
      return true;
    },
  );
  console.log("PASS HTTP 200 nested 6020 envelope preserves kind and retry hint");

  const controller = new AbortController();
  globalThis.fetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    controller.abort();
  });
  await assert.rejects(webFetch(DEFAULT_CONFIG, auth, "https://example.invalid", controller.signal));
  console.log("PASS caller abort reaches the in-flight Agent upstream request");
} finally {
  globalThis.fetch = oldFetch;
}
