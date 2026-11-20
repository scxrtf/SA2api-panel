import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/lib/config.ts";
import { chatHeaders, newMessageID, type AuthShape } from "../src/lib/upstream/client.ts";

const account: AuthShape = {
  uid: "offline-user", nickname: "offline", realm: "cn", accessToken: "offline-token",
  refreshToken: "", expiresAt: 0, domain: "", enterpriseId: "", deviceToken: "",
};

test("消息 ID 为去横线的 UUIDv7，包含版本7与RFC variant", () => {
  for (let i = 0; i < 128; i++) assert.match(newMessageID(), /^[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$/);
});

test("UUIDv7 同毫秒及小幅时钟回拨保持严格递增", () => {
  const originalNow = Date.now;
  const state = globalThis as unknown as { __wbMessageId?: { ms: number; counter: number } };
  const originalState = state.__wbMessageId;
  delete state.__wbMessageId;
  let now = 1_800_000_000_000;
  Date.now = () => now;
  try {
    const ids = Array.from({ length: 2000 }, () => newMessageID());
    now--;
    ids.push(newMessageID());
    assert.deepEqual(ids.toSorted(), ids);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(Number.parseInt(ids[0].slice(0, 12), 16), now + 1);
  } finally {
    Date.now = originalNow;
    if (originalState) state.__wbMessageId = originalState;
    else delete state.__wbMessageId;
  }
});

test("16位 B3 trace 在 W3C traceparent 中扩展为32位", () => {
  const headers = chatHeaders(DEFAULT_CONFIG, account, "", {
    conversationID: "00112233-4455-4677-8899-aabbccddeeff", cacheKeyID: "",
    conversationRequestID: "request", traceID: "ABCDEF1234567890",
  });
  assert.equal(headers["X-B3-TraceId"], "abcdef1234567890");
  assert.match(headers.traceparent, /^00-0000000000000000abcdef1234567890-[0-9a-f]{16}-01$/);
  assert.equal(headers["X-Request-ID"], headers["X-Conversation-Message-ID"]);
  assert.equal(headers["X-IDE-Version"], "5.9.3");
  assert.equal(headers["X-Stainless-Runtime-Version"], "v22.21.1");
});

test("零 trace ID 不进入 B3/W3C trace 字段", () => {
  const headers = chatHeaders(DEFAULT_CONFIG, account, "", {
    conversationID: "", cacheKeyID: "", conversationRequestID: "", traceID: "0".repeat(32),
  });
  assert.match(headers.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  assert.notEqual(headers["X-B3-TraceId"], "0".repeat(32));
  assert.equal(headers["X-Trace-ID"], headers["X-B3-TraceId"]);
  assert.match(headers["X-Conversation-ID"], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
