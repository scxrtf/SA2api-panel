import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, Socket } from "node:net";
import { createServer as createTlsServer } from "node:tls";
import { readFileSync } from "node:fs";
import test from "node:test";
import { officialEgress, closeOfficialEgressConnections } from "../src/lib/upstream/official-egress.ts";

const OFFICIAL_JA3 = "771,4865-4866-4867-49199-49195-49200-49196-49191-52393-52392-49161-49171-49162-49172-156-157-47-53,0-23-65281-10-11-35-13-51-45-43,29-23-24,0";
const OFFICIAL_JA4 = "t13d0a1200_5d04281c6031_b76c5ee2507d";

function parseHello(raw: Buffer) {
  assert.equal(raw[0], 22);
  assert.equal(raw.readUInt16BE(3) + 5, raw.length);
  assert.equal(raw[5], 1);
  let p = 9;
  const version = raw.readUInt16BE(p);
  p += 34;
  const sessionIDLen = raw[p];
  p += 1 + sessionIDLen;
  const cipherBytes = raw.readUInt16BE(p);
  p += 2;
  const ciphers: number[] = [];
  for (let i = 0; i < cipherBytes; i += 2) ciphers.push(raw.readUInt16BE(p + i));
  p += cipherBytes;
  const compressionBytes = raw[p];
  p += 1 + compressionBytes;
  const extensionBytes = raw.readUInt16BE(p);
  p += 2;
  const end = p + extensionBytes;
  const extensions: number[] = [];
  const groups: number[] = [];
  const ecPointFormats: number[] = [];
  const sigalgs: number[] = [];
  const versions: number[] = [];
  const alpn: string[] = [];
  let hasSNI = false;
  while (p < end) {
    const type = raw.readUInt16BE(p);
    const length = raw.readUInt16BE(p + 2);
    const data = raw.subarray(p + 4, p + 4 + length);
    extensions.push(type);
    if (type === 0) hasSNI = true;
    if (type === 10) for (let i = 2; i < data.length; i += 2) groups.push(data.readUInt16BE(i));
    if (type === 11) ecPointFormats.push(...data.subarray(1));
    if (type === 13) for (let i = 2; i < data.length; i += 2) sigalgs.push(data.readUInt16BE(i));
    if (type === 43) for (let i = 1; i < data.length; i += 2) versions.push(data.readUInt16BE(i));
    if (type === 16) {
      for (let i = 2; i < data.length;) {
        const size = data[i];
        alpn.push(data.subarray(i + 1, i + 1 + size).toString());
        i += 1 + size;
      }
    }
    p += 4 + length;
  }
  const ja3 = [version, ciphers.join("-"), extensions.join("-"), groups.join("-"), ecPointFormats.join("-")].join(",");
  const tlsVersion = Math.max(version, ...versions);
  const a = `t1${(tlsVersion & 0xff) - 1}${hasSNI ? "d" : "i"}${extensions.length.toString(16).padStart(2, "0")}${ciphers.length.toString(16).padStart(2, "0")}${alpn[0]?.slice(0, 2) ?? "00"}`;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
  const b = hash(ciphers.toSorted((x, y) => x - y).map((n) => n.toString(16).padStart(4, "0")).join(","));
  const extensionList = extensions.filter((n) => n !== 0 && n !== 16).toSorted((x, y) => x - y);
  const c = hash(`${extensionList.map((n) => n.toString(16).padStart(4, "0")).join(",")}_${sigalgs.toSorted((x, y) => x - y).map((n) => n.toString(16).padStart(4, "0")).join(",")}`);
  return { ja3, ja4: `${a}_${b}_${c}`, sessionIDLen, extensions, ciphers, sigalgs, groups, alpn };
}

async function captureHello(connect: (port: number) => Socket): Promise<Buffer> {
  const server = createServer((socket) => {
    let raw = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      raw = Buffer.concat([raw, chunk]);
      if (raw.length >= 5 && raw.length >= raw.readUInt16BE(3) + 5) {
        server.emit("hello", raw);
        socket.destroy();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  const socket = connect(address.port);
  socket.on("error", () => undefined);
  try {
    const [raw] = await Promise.race([
      once(server, "hello"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ClientHello capture timeout")), 2000)),
    ]);
    return raw;
  } finally {
    socket.destroy();
    server.close();
  }
}

function assertOfficial(raw: Buffer) {
  const hello = parseHello(raw);
  assert.equal(hello.ja3, OFFICIAL_JA3);
  assert.equal(createHash("md5").update(hello.ja3).digest("hex"), "71dc8c533dd919ae9f4963224a4ba8fd");
  assert.equal(hello.ja4, OFFICIAL_JA4);
  assert.equal(hello.sessionIDLen, 32);
  assert.equal(hello.ciphers.length, 18);
  assert.equal(hello.extensions.length, 10);
  assert.equal(hello.sigalgs.length, 9);
  assert.deepEqual(hello.groups, [29, 23, 24]);
  assert.deepEqual(hello.alpn, []);
}

test("直连 ClientHello 的 JA3/JA4、session_id、扩展与 ALPN 对齐真机", async () => {
  const raw = await captureHello((port) => {
    const socket = new Socket();
    void officialEgress(`https://www.workbuddy.cn:${port}/`, { proxy: null, connectHost: "127.0.0.1" }).catch(() => undefined);
    return socket;
  });
  assertOfficial(raw);
});

test("HTTP CONNECT 隧道后使用同一官方 ClientHello", async () => {
  const proxy = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.once("data", (request) => {
      assert.match(request.toString("latin1"), /^CONNECT www\.workbuddy\.cn:443 HTTP\/1\.1\r\n/);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", (hello) => proxy.emit("hello", hello));
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  assert(address && typeof address === "object");
  try {
    void officialEgress("https://www.workbuddy.cn/", { proxy: `http://127.0.0.1:${address.port}` }).catch(() => undefined);
    const [raw] = await once(proxy, "hello");
    assertOfficial(raw);
  } finally {
    proxy.close();
  }
});

test("uTLS 完成真实握手并传输 HTTP，响应结束后连接可复用", async (t) => {
  const server = createTlsServer({
    key: readFileSync(new URL("./fixtures/tls-key.pem", import.meta.url)),
    cert: readFileSync(new URL("./fixtures/tls-cert.pem", import.meta.url)),
  }, (socket) => {
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("latin1");
      while (pending.includes("\r\n\r\n")) {
        pending = pending.slice(pending.indexOf("\r\n\r\n") + 4);
        socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok");
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert(address && typeof address === "object");
  const url = `https://www.workbuddy.cn:${address.port}/`;
  const rootCA = readFileSync(new URL("./fixtures/tls-cert.pem", import.meta.url), "utf8");
  const response = await officialEgress(url, { proxy: null, connectHost: "127.0.0.1", rootCA });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  const reused = await officialEgress(url, { proxy: null, connectHost: "127.0.0.1", rootCA });
  assert.equal(await reused.text(), "ok");
});

test.after(() => closeOfficialEgressConnections());
