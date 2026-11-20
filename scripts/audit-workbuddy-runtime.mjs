// Read the runtime identity and ClientHello of a verified Electron RunAsNode
// executable. No application main, user profile, login or remote API is loaded.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";

const exe = process.argv[2];
if (!exe) throw new Error("Usage: node scripts/audit-workbuddy-runtime.mjs <Electron executable> [output.json]");
const bytes = readFileSync(exe);
const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
const fuse = bytes.indexOf(sentinel);
assert(fuse >= 0, "Electron fuse sentinel is required before executing Node mode");
assert.equal(bytes[fuse + sentinel.length], 1, "only fuse wire version 1 is understood");
assert(bytes[fuse + sentinel.length + 1] > 0, "RunAsNode fuse must be present");
assert.equal(bytes[fuse + sentinel.length + 2], 49, "RunAsNode must be enabled; application main will not be launched");

const server = createServer();
const sockets = new Set();
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("error", () => undefined);
  socket.once("close", () => sockets.delete(socket));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const code = `console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,electron:process.versions.electron,openssl:process.versions.openssl}));const c=require('node:tls').connect({host:'127.0.0.1',port:${port},servername:'www.workbuddy.cn'});c.on('error',()=>process.exit(0));setTimeout(()=>process.exit(2),3000).unref();`;
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
delete env.NODE_OPTIONS;
const child = spawn(resolve(exe), ["-e", code], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
const output = [];
const errors = [];
child.stdout.on("data", (chunk) => output.push(chunk));
child.stderr.on("data", (chunk) => errors.push(chunk));
const timer = setTimeout(() => { child.kill(); for (const socket of sockets) socket.destroy(); }, 5000);
let hello;
try {
  hello = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", () => { if (!hello) reject(new Error("runtime ended before ClientHello: " + Buffer.concat(errors).toString())); });
    server.once("connection", (socket) => {
      let data = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        data = Buffer.concat([data, chunk]);
        if (data.length >= 5 && data.length >= 5 + data.readUInt16BE(3)) {
          hello = data.subarray(0, 5 + data.readUInt16BE(3));
          accept(hello);
          socket.destroy();
        }
      });
    });
  });
  await once(child, "exit");
} finally {
  clearTimeout(timer);
  child.kill();
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => server.close(done));
}

let at = 9;
const version = hello.readUInt16BE(at);
at += 34;
const sessionIDBytes = hello[at++];
at += sessionIDBytes;
const cipherBytes = hello.readUInt16BE(at); at += 2;
const ciphers = [];
for (let i = 0; i < cipherBytes; i += 2) ciphers.push(hello.readUInt16BE(at + i));
at += cipherBytes;
at += 1 + hello[at];
const end = at + 2 + hello.readUInt16BE(at); at += 2;
const extensions = [], groups = [], points = [], sigalgs = [], versions = [], alpn = [];
while (at < end) {
  const type = hello.readUInt16BE(at), length = hello.readUInt16BE(at + 2);
  const data = hello.subarray(at + 4, at + 4 + length);
  extensions.push(type);
  if (type === 10) for (let i = 2; i < data.length; i += 2) groups.push(data.readUInt16BE(i));
  if (type === 11) points.push(...data.subarray(1));
  if (type === 13) for (let i = 2; i < data.length; i += 2) sigalgs.push(data.readUInt16BE(i));
  if (type === 43) for (let i = 1; i < data.length; i += 2) versions.push(data.readUInt16BE(i));
  if (type === 16) for (let i = 2; i < data.length;) { const size = data[i++]; alpn.push(data.subarray(i, i + size).toString()); i += size; }
  at += 4 + length;
}
const grease = (n) => (n & 0x0f0f) === 0x0a0a && (n >> 8) === (n & 0xff);
const filtered = (values) => values.filter((n) => !grease(n));
const hex = (n) => n.toString(16).padStart(4, "0");
const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const count = (n) => Math.min(99, n).toString().padStart(2, "0");
const cs = filtered(ciphers), exts = filtered(extensions), signatures = filtered(sigalgs);
const tag = alpn[0] ? alpn[0][0] + alpn[0].at(-1) : "00";
const prefix = `t1${(Math.max(version, ...filtered(versions)) & 0xff) - 1}${exts.includes(0) ? "d" : "i"}${count(cs.length)}${count(exts.length)}${tag}`;
const ja3 = [version, cs.join("-"), exts.join("-"), filtered(groups).join("-"), points.join("-")].join(",");
const ja4 = `${prefix}_${hash(cs.toSorted((a, b) => a - b).map(hex).join(","))}_${hash(exts.filter((n) => n !== 0 && n !== 16).toSorted((a, b) => a - b).map(hex).join(",") + "_" + signatures.map(hex).join(","))}`;
const report = {
  scope: "Electron RunAsNode default TLS to a loopback listener, not an application API capture",
  executable: resolve(exe), sha256: createHash("sha256").update(bytes).digest("hex"),
  runtime: JSON.parse(Buffer.concat(output).toString().trim().split("\n").find((line) => line.startsWith("{"))),
  ja3, ja3MD5: createHash("md5").update(ja3).digest("hex"), ja4,
  sessionIDBytes, ciphers, extensions, groups, sigalgs, alpn,
};
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
