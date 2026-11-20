import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Socket } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { closeOfficialEgressConnections, officialEgress, officialRequestFixture } from "../src/lib/upstream/official-egress.ts";

async function withRawServer(reply: (socket: Socket) => void, run: (url: string) => Promise<void>) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => reply(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    await run(`http://127.0.0.1:${address.port}/`);
  } finally {
    closeOfficialEgressConnections();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("raw 请求拒绝 CRLF、无效头名和大小写重复头", () => {
  for (const headers of [
    { "X-Trace-ID": "ok\r\nX-Injected: yes" },
    { "Bad Name": "value" },
    { Host: "www.workbuddy.cn", host: "elsewhere.invalid" },
  ]) {
    assert.throws(() => officialRequestFixture("https://www.workbuddy.cn/", { headers }));
  }
});

test("raw 请求拒绝无效 method 和歧义 framing", () => {
  assert.throws(() => officialRequestFixture("https://www.workbuddy.cn/", { method: "GET\r\nX: y" }));
  assert.throws(() => officialRequestFixture("https://www.workbuddy.cn/", {
    method: "POST", body: "hello", headers: { "Content-Length": "1" },
  }));
  assert.throws(() => officialRequestFixture("https://www.workbuddy.cn/", {
    method: "POST", body: "hello", headers: { "Transfer-Encoding": "chunked" },
  }));
});

test("HEAD 响应忽略声明的正文长度且 body 为 null", { timeout: 2000 }, async () => {
  await withRawServer((socket) => socket.write("HTTP/1.1 200 OK\r\nContent-Length: 999\r\n\r\n"), async (url) => {
    const response = await officialEgress(url, { method: "HEAD", proxy: null });
    assert.equal(response.body, null);
  });
});

test("同一 TCP 分片中的超限响应头也被拦截", { timeout: 2000 }, async () => {
  await withRawServer((socket) => socket.end(`HTTP/1.1 200 OK\r\nX-Large: ${"x".repeat(70_000)}\r\nContent-Length: 0\r\n\r\n`), async (url) => {
    await assert.rejects(async () => {
      const response = await officialEgress(url, { proxy: null });
      await response.text();
    }, /headers too large/);
  });
});

for (const framing of ["Content-Length: 2\r\nContent-Length: 3", "Content-Length: 2\r\nTransfer-Encoding: chunked"]) {
  test(`歧义响应 framing 被拦截：${framing.split("\r\n").join(" / ")}`, { timeout: 2000 }, async () => {
    await withRawServer((socket) => socket.end(`HTTP/1.1 200 OK\r\n${framing}\r\n\r\nok`), async (url) => {
      await assert.rejects(async () => {
        const response = await officialEgress(url, { proxy: null });
        await response.text();
      }, /framing|content.length/i);
    });
  });
}

test("大 HTTP chunk 增量交付首批字节，不缓存整个 chunk", { timeout: 2000 }, async () => {
  await withRawServer((socket) => socket.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n400000\r\nfirst"), async (url) => {
    const response = await officialEgress(url, { proxy: null, signal: AbortSignal.timeout(250) });
    const reader = response.body!.getReader();
    try {
      const first = await reader.read();
      assert.equal(new TextDecoder().decode(first.value), "first");
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  });
});

test("空 gzip 正文及时报错而非挂起", { timeout: 2000 }, async () => {
  await withRawServer((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 0\r\n\r\n"), async (url) => {
    await assert.rejects(async () => {
      const response = await officialEgress(url, { proxy: null, signal: AbortSignal.timeout(250) });
      await response.text();
    }, (error: unknown) => error instanceof Error && /unexpected|gzip|compressed/i.test(
      `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`,
    ));
  });
});

test("透明解压后移除压缩长度与Content-Encoding", { timeout: 2000 }, async () => {
  const body = gzipSync("decoded body");
  await withRawServer((socket) => socket.end(Buffer.concat([
    Buffer.from(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\n\r\n`), body,
  ])), async (url) => {
    const response = await officialEgress(url, { proxy: null });
    assert.equal(response.headers.get("content-encoding"), null);
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(await response.text(), "decoded body");
  });
});

test("取消已收完但未读的旧body不会摧毁已复用连接", { timeout: 2000 }, async () => {
  let releaseSecond!: () => void;
  let receivedSecond!: () => void;
  const secondReceived = new Promise<void>((resolve) => { receivedSecond = resolve; });
  const peers = new Set<Socket>();
  const server = createHttpServer((request, response) => {
    if (request.url === "/one") response.end("first");
    else { releaseSecond = () => response.end("second"); receivedSecond(); }
  });
  server.on("connection", (socket) => peers.add(socket));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const first = await officialEgress(base + "/one", { proxy: null });
    const pending = officialEgress(base + "/two", { proxy: null, signal: AbortSignal.timeout(1000) });
    await secondReceived;
    await first.body!.cancel();
    releaseSecond();
    assert.equal(await (await pending).text(), "second");
    assert.equal(peers.size, 1);
  } finally {
    closeOfficialEgressConnections();
    for (const socket of peers) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test.after(() => closeOfficialEgressConnections());
