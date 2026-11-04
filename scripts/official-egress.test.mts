import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import { brotliCompressSync, deflateRawSync, deflateSync, gunzipSync, gzipSync } from "node:zlib";
import {
  closeOfficialEgressConnections,
  officialEgress,
  officialRequestFixture,
} from "../src/lib/upstream/official-egress.ts";
import { newTraceID } from "../src/lib/upstream/client.ts";

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

async function withServer(
  handler: Parameters<typeof createServer>[0],
  run: (base: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  const base = await listen(server);
  try { await run(base); } finally {
    closeOfficialEgressConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("chat 请求保持官方头大小写、顺序、baggage 和分域头", () => {
  const fixture = officialRequestFixture("https://www.workbuddy.cn/v2/chat/completions", {
    method: "POST",
    headers: {
      Host: "www.workbuddy.cn",
      Authorization: "Bearer token",
      "X-Domain": "www.workbuddy.cn",
      baggage: "buddyId=,buddyName=,codebuddy.session_id=conversation,codebuddy.conversation_request_id=request",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: "x",
  });
  const names = fixture.split("\r\n").slice(1, -1).map((line) => line.split(":")[0]);
  assert.deepEqual(names, [
    "Accept", "Content-Type", "baggage", "Authorization", "X-Domain",
    "Content-Length", "Accept-Encoding", "Host",
  ]);
  assert.match(fixture, /\r\nAccept-Encoding: gzip, compress, deflate, br\r\n/);
});

test("chat 大于 1024 字节时 gzip，边界值不压缩", () => {
  for (const size of [1024, 1025]) {
    const body = "x".repeat(size);
    const fixture = officialRequestFixture("http://127.0.0.1/v2/chat/completions", {
      method: "POST", body,
    });
    assert.equal(fixture.includes("Content-Encoding: gzip"), size === 1025);
    assert.match(fixture, new RegExp(`Content-Length: ${size === 1025 ? "\\d+" : size}`));
  }
});

test("v3/config 仅发送官方六头且不带鉴权或浏览器头", () => {
  const fixture = officialRequestFixture("https://www.workbuddy.cn/v3/config", {
    headers: {
      Accept: "application/json, text/plain, */*",
      Connection: "close",
      "User-Agent": "WorkBuddy/5.9.3 CLI/2.165.0",
      "X-Request-ID": "trace",
      "X-Product": "SaaS",
    },
  });
  assert.equal(fixture + "\r\n", [
    "GET /v3/config HTTP/1.1",
    "Accept: application/json, text/plain, */*",
    "Connection: close",
    "User-Agent: WorkBuddy/5.9.3 CLI/2.165.0",
    "X-Request-ID: trace",
    "X-Product: SaaS",
    "Host: www.workbuddy.cn",
    "",
  ].join("\r\n"));
});

const officialHeadFixtures = [
  {
    path: "/v2/report", host: "www.workbuddy.cn",
    ua: "WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0", uid: "cn-uid", length: 765,
  },
  {
    path: "/v2/report", host: "www.workbuddy.ai",
    ua: "workbuddy-ai/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0", uid: "gl-uid", length: 724,
  },
];
for (const { path, host, ua, uid, length } of officialHeadFixtures) {
  test(`真机 report 头严格对拍 ${host}`, () => {
    const fixture = officialRequestFixture(`https://${host}${path}`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=UTF-8",
        "X-Request-ID": "0123456789abcdef0123456789abcdef",
        "X-Product": "SaaS", "User-Agent": ua,
        Authorization: "Bearer <REDACTED>", "X-User-Id": uid, "X-Domain": host,
      },
      body: "x".repeat(length),
    });
    assert.equal(fixture + "\r\n", [
      `POST ${path} HTTP/1.1`,
      "Accept: application/json, text/plain, */*",
      "Content-Type: application/json;charset=UTF-8",
      "X-Request-ID: 0123456789abcdef0123456789abcdef",
      "X-Product: SaaS", `User-Agent: ${ua}`,
      "Authorization: Bearer <REDACTED>", `X-User-Id: ${uid}`, `X-Domain: ${host}`,
      `Content-Length: ${length}`, `Host: ${host}`, "Connection: keep-alive", "",
    ].join("\r\n"));
    assert.doesNotMatch(fixture, /Accept-Encoding/i);
  });
}

test("真机 global refresh 头严格对拍", () => {
  const host = "www.workbuddy.ai";
  const fixture = officialRequestFixture(`https://${host}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/plain, */*", "Content-Type": "application/json",
      "X-Domain": host, "X-Refresh-Token": "refresh-token",
      "X-Auth-Refresh-Source": "plugin",
      "User-Agent": "workbuddy-ai/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0",
      "X-Request-ID": "83bf6bd3885544188ffb214b7d437a0d", "X-Product": "SaaS",
      Authorization: "Bearer <REDACTED>", "X-User-Id": "gl-uid",
    },
    body: "{}",
  });
  assert.equal(fixture + "\r\n", [
    "POST /v2/plugin/auth/token/refresh HTTP/1.1",
    "Accept: application/json, text/plain, */*", "Content-Type: application/json",
    `X-Domain: ${host}`, "X-Refresh-Token: refresh-token", "X-Auth-Refresh-Source: plugin",
    "User-Agent: workbuddy-ai/5.9.4 workbuddy-ai/5.9.4 CLI/2.165.0",
    "X-Request-ID: 83bf6bd3885544188ffb214b7d437a0d", "X-Product: SaaS",
    "Authorization: Bearer <REDACTED>", "X-User-Id: gl-uid", "Content-Length: 2",
    `Host: ${host}`, "Connection: keep-alive", "",
  ].join("\r\n"));
  assert.doesNotMatch(fixture, /Accept-Encoding/i);
});

test("report ID 是纯随机 32 hex，不使用时间前缀 message ID", () => {
  for (let i = 0; i < 32; i++) {
    assert.match(newTraceID(), /^[0-9a-f]{32}$/);
  }
  assert.notEqual(newTraceID(), newTraceID());
});

test("真实线上的 chat gzip 请求体可由服务端解压", async () => {
  await withServer((req, res) => {
    assert.equal(req.headers["content-encoding"], "gzip");
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      assert.equal(gunzipSync(Buffer.concat(chunks)).toString(), "x".repeat(1025));
      res.end("ok");
    });
  }, async (base) => {
    const response = await officialEgress(base + "/v2/chat/completions", {
      method: "POST", body: "x".repeat(1025), proxy: null,
    });
    assert.equal(await response.text(), "ok");
  });
});

test("SSE 任意分片可完整重组", async () => {
  const payload = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: [DONE]\n\n';
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const chunk of [payload.slice(0, 7), payload.slice(7, 23), payload.slice(23)]) res.write(chunk);
    res.end();
  }, async (base) => {
    const response = await officialEgress(base + "/v2/chat/completions", { method: "POST", body: "x", proxy: null });
    assert.equal(await response.text(), payload);
  });
});

for (const [encoding, compress] of [
  ["gzip", gzipSync],
  ["deflate", deflateSync],
  ["deflate-raw", deflateRawSync],
  ["br", brotliCompressSync],
] as const) {
  test(`响应解压 ${encoding}`, async () => {
    await withServer((_req, res) => {
      res.writeHead(200, {
        "Content-Encoding": encoding === "deflate-raw" ? "deflate" : encoding,
        "Content-Length": compress(Buffer.from("decoded payload")).length,
      });
      const bytes = compress(Buffer.from("decoded payload"));
      res.write(bytes.subarray(0, 1));
      res.end(bytes.subarray(1));
    }, async (base) => {
      const response = await officialEgress(base + "/", { proxy: null });
      assert.equal(await response.text(), "decoded payload");
    });
  });
}

test("chunked 响应与 trailer 正常结束", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "Transfer-Encoding": "chunked", Trailer: "X-Test" });
    res.write("one"); res.write("two");
    res.addTrailers({ "X-Test": "done" }); res.end();
  }, async (base) => {
    const response = await officialEgress(base + "/", { proxy: null });
    assert.equal(await response.text(), "onetwo");
  });
});

for (const status of [204, 205, 304]) {
  test(`${status} 空响应立即完成且 Response.body 为 null`, async () => {
    await withServer((_req, res) => { res.writeHead(status); res.end(); }, async (base) => {
      const response = await officialEgress(base + "/", { proxy: null });
      assert.equal(response.status, status);
      assert.equal(response.body, null);
      assert.equal(await response.text(), "");
    });
  });
}

test("Content-Length 0 空响应立即完成", async () => {
  await withServer((_req, res) => { res.writeHead(200, { "Content-Length": "0" }); res.end(); }, async (base) => {
    const response = await officialEgress(base + "/", { proxy: null });
    assert.equal(await response.text(), "");
  });
});

test("EOF 响应完整读取", { timeout: 2000 }, async () => {
  closeOfficialEgressConnections();
  const server = createNetServer((socket) => {
    socket.end("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nbye");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const response = await officialEgress(`http://127.0.0.1:${address.port}/`, { proxy: null });
    assert.equal(await response.text(), "bye");
  } finally {
    closeOfficialEgressConnections();
    server.close();
  }
});

test("keep-alive 复用同一条连接，Connection: close 隔离下一条", async () => {
  const sockets = new Set<object>();
  await withServer((req, res) => {
    sockets.add(req.socket);
    if (req.url === "/close") res.writeHead(200, { Connection: "close" });
    res.end("ok");
  }, async (base) => {
    for (const path of ["/one", "/two", "/close", "/three"]) {
      assert.equal(await (await officialEgress(base + path, { proxy: null })).text(), "ok");
    }
    assert.equal(sockets.size, 2);
  });
});

test("请求 Connection: close 复用旧空闲连接，但响应后销毁", async () => {
  const sockets: object[] = [];
  let closeSeen = 0;
  await withServer((req, res) => {
    if (!sockets.includes(req.socket)) sockets.push(req.socket);
    if (req.headers.connection === "close") closeSeen++;
    res.writeHead(200, { "Content-Length": "2" });
    res.end("ok");
  }, async (base) => {
    for (const path of ["/v2/report", "/v2/report", "/v3/config", "/v2/report"]) {
      const response = await officialEgress(base + path, {
        method: "POST", body: "{}",
        headers: path === "/v3/config" ? { Connection: "close" } : undefined,
        proxy: null,
      });
      assert.equal(await response.text(), "ok");
    }
    assert.equal(sockets.length, 2);
    assert.equal(closeSeen, 1);
  });
});

test("响应头超时", async () => {
  await withServer(() => undefined, async (base) => {
    await assert.rejects(
      officialEgress(base + "/", { proxy: null, timeoutMs: 30 }),
      (error: unknown) => error instanceof Error && error.name === "TimeoutError",
    );
  });
});

test("预中止不发起连接", async () => {
  const controller = new AbortController();
  controller.abort(new Error("pre-aborted"));
  await assert.rejects(officialEgress("http://127.0.0.1:1/", { proxy: null, signal: controller.signal }), /pre-aborted/);
});

test("TCP 连接阶段中止", { timeout: 2000 }, async () => {
  const server = createNetServer(() => undefined);
  const originalConnect = (await import("node:net")).Socket.prototype.connect;
  (await import("node:net")).Socket.prototype.connect = function () {
    setTimeout(() => this.emit("connect"), 100).unref();
    return this;
  } as typeof originalConnect;
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("tcp-aborted")), 10);
    await assert.rejects(
      officialEgress("http://127.0.0.1:9/", { proxy: null, signal: controller.signal }),
      /tcp-aborted/,
    );
  } finally { (await import("node:net")).Socket.prototype.connect = originalConnect; server.close(); }
});

test("响应体取消会销毁连接", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "Content-Length": "100" }); res.write("partial");
  }, async (base) => {
    const response = await officialEgress(base + "/", { proxy: null });
    await response.body?.cancel(new Error("body-cancelled"));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
