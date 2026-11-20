// Desktop RPC egress: HTTP/1.1 transport preserving the configured header profile.
// Global fetch/undici normalizes header spelling/order, so the official routes
// use this module instead of fetch. The local uTLS helper pins a Node/OpenSSL-like
// ClientHello; matching this fixture is not proof of whole-client equivalence.
import { spawn } from "child_process";
import { Socket } from "net";
import { validateHeaderName, validateHeaderValue } from "http";
import { PassThrough, Readable, pipeline } from "stream";
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createInflateRaw,
  gzipSync,
} from "zlib";
import { resolve } from "path";

export interface OfficialEgressInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
  /** Convenience response-header timeout. The signal also covers body reads. */
  timeoutMs?: number;
  /** Undefined uses HTTP(S)_PROXY; null forces a direct connection. */
  proxy?: string | null;
  /** Test fixture only: dial a separate address while preserving URL/SNI. */
  connectHost?: string;
  /** Test fixture only: additional PEM root for a local TLS server. */
  rootCA?: string;
}

type HeaderEntry = { name: string; value: string };
type ResponseParser = {
  head: (value: { status: number; statusText: string; headers: Headers }) => void;
  data: (chunk: Buffer) => void;
  end: () => void;
  fail: (error: unknown) => void;
};

const OFFICIAL_HEADER_SPELLING: Record<string, string> = {
  accept: "Accept",
  "accept-encoding": "Accept-Encoding",
  "accept-language": "Accept-Language",
  authorization: "Authorization",
  connection: "Connection",
  cookie: "Cookie",
  "content-encoding": "Content-Encoding",
  "content-length": "Content-Length",
  "content-type": "Content-Type",
  host: "Host",
  origin: "Origin",
  referer: "Referer",
  "user-agent": "User-Agent",
  "x-agent-intent": "X-Agent-Intent",
  "x-agent-purpose": "X-Agent-Purpose",
  "x-agent-runtime": "X-Agent-Runtime",
  "x-agent-type": "X-Agent-Type",
  "x-b3-sampled": "X-B3-Sampled",
  "x-domain": "X-Domain",
  "x-private-data": "X-Private-Data",
  "x-product": "X-Product",
  "x-refresh-token": "X-Refresh-Token",
  "x-auth-refresh-source": "X-Auth-Refresh-Source",
  "x-client-platform": "X-Client-Platform",
  "x-requested-with": "X-Requested-With",
  "x-user-id": "X-User-Id",
  "x-stainless-arch": "x-stainless-arch",
  "x-stainless-lang": "x-stainless-lang",
  "x-stainless-os": "x-stainless-os",
  "x-stainless-package-version": "x-stainless-package-version",
  "x-stainless-retry-count": "x-stainless-retry-count",
  "x-stainless-runtime": "x-stainless-runtime",
  "x-stainless-runtime-version": "x-stainless-runtime-version",
  "acp-connection-id": "acp-connection-id",
  "x-codebuddy-request": "x-codebuddy-request",
  baggage: "baggage",
  traceparent: "traceparent",
  b3: "b3",
  "x-conversation-id": "X-Conversation-ID",
  "x-conversation-message-id": "X-Conversation-Message-ID",
  "x-conversation-request-id": "X-Conversation-Request-ID",
  "x-request-id": "X-Request-ID",
  "x-root-request-id": "X-Root-Request-ID",
  "x-trace-id": "X-Trace-ID",
  "x-ide-type": "X-IDE-Type",
  "x-ide-name": "X-IDE-Name",
  "x-ide-version": "X-IDE-Version",
  "x-b3-traceid": "X-B3-TraceId",
  "x-b3-parentspanid": "X-B3-ParentSpanId",
  "x-b3-spanid": "X-B3-SpanId",
};

const CHAT_ORDER = [
  "Accept", "Content-Type", "X-Requested-With",
  "x-stainless-arch", "x-stainless-lang", "x-stainless-os",
  "x-stainless-package-version", "x-stainless-retry-count",
  "x-stainless-runtime", "x-stainless-runtime-version",
  "X-Conversation-ID", "X-Agent-Purpose", "X-IDE-Type", "X-IDE-Name",
  "X-IDE-Version", "X-Agent-Intent", "X-Agent-Runtime", "X-Private-Data",
  "acp-connection-id", "x-codebuddy-request", "X-Request-ID",
  "X-Conversation-Message-ID", "X-Conversation-Request-ID",
  "X-Root-Request-ID", "X-Agent-Type", "baggage", "Content-Encoding",
  "traceparent", "b3", "X-B3-TraceId", "X-B3-ParentSpanId", "X-B3-SpanId",
  "X-B3-Sampled", "X-Trace-ID", "X-Product", "User-Agent", "Authorization",
  "X-User-Id", "X-Domain", "Content-Length", "Accept-Encoding", "Host",
  "Connection",
];

const REPORT_ORDER = [
  "Accept", "Content-Type", "X-Request-ID", "X-Product", "User-Agent",
  "Authorization", "X-User-Id", "X-Domain", "Content-Length",
  "Accept-Encoding", "Host", "Connection",
];

const REFRESH_ORDER = [
  "Accept", "Content-Type", "X-Domain", "X-Refresh-Token",
  "X-Auth-Refresh-Source", "User-Agent", "X-Request-ID", "X-Product",
  "Authorization", "X-User-Id", "Content-Length", "Accept-Encoding", "Host",
  "Connection",
];

const BUSY_ORDER = [
  "Accept", "Content-Type", "User-Agent", "X-Request-ID", "X-Product",
  "Authorization", "X-User-Id", "X-Domain", "Content-Length", "Host",
  "Connection",
];

const V3_CONFIG_ORDER = [
  "Accept", "Connection", "User-Agent", "X-Request-ID", "X-Product", "Host",
];

const HEADER_ORDERS: Record<string, string[]> = {
  "/v2/chat/completions": CHAT_ORDER,
  "/v2/report": REPORT_ORDER,
  "/v2/plugin/auth/token/refresh": REFRESH_ORDER,
  "/v2/chat/busy": BUSY_ORDER,
  "/v3/config": V3_CONFIG_ORDER,
};

const IDLE_TIMEOUT_MS = 30_000;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_IDLE_PER_ORIGIN = 8;
const MAX_IDLE_CONNECTIONS = 64;

const TLS_HELPER_TIMEOUT_MS = 10_000;

export class OfficialTLSSocket extends Socket {
  constructor(private helper: ReturnType<typeof spawn>) {
    super({ readable: true, writable: true });
    // The peer can close between helper readiness and PooledConnection wiring.
    this.on("error", () => undefined);
  }

  _read(): void { this.helper.stdout?.resume(); }
  _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.helper.stdin?.write(chunk, encoding, callback);
  }
  _final(callback: (error?: Error | null) => void): void {
    this.helper.stdin?.end();
    callback();
  }
  _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.helper.kill();
    callback(error);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function hostHeader(url: URL): string {
  const standard = (url.protocol === "https:" && url.port === "443") ||
    (url.protocol === "http:" && url.port === "80");
  return url.hostname + (!standard && url.port ? `:${url.port}` : "");
}

function requestTarget(url: URL): string {
  return url.pathname + url.search;
}

function orderedHeaders(path: string, entries: HeaderEntry[]): HeaderEntry[] {
  const order = HEADER_ORDERS[path];
  if (!order) return entries;
  const rank = new Map(order.map((name, index) => [name.toLowerCase(), index]));
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const ar = rank.get(a.entry.name.toLowerCase()) ?? order.length + a.index;
      const br = rank.get(b.entry.name.toLowerCase()) ?? order.length + b.index;
      return ar - br || a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function serializeRequest(url: URL, init: OfficialEgressInit): Buffer {
  const path = url.pathname;
  const method = (init.method ?? "GET").toUpperCase();
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method)) throw new TypeError("invalid HTTP method");
  if (url.username || url.password) throw new TypeError("URL credentials are not supported");
  let body = init.body === undefined
    ? Buffer.alloc(0)
    : Buffer.isBuffer(init.body)
      ? init.body
      : Buffer.from(init.body);
  const seen = new Set<string>();
  const headers: HeaderEntry[] = Object.entries(init.headers ?? {}).map(([name, value]) => {
    validateHeaderName(name);
    validateHeaderValue(name, value);
    const lower = name.toLowerCase();
    if (seen.has(lower)) throw new TypeError(`duplicate request header: ${name}`);
    seen.add(lower);
    return { name: OFFICIAL_HEADER_SPELLING[lower] ?? name, value };
  });
  const has = (name: string) => headers.some((h) => h.name.toLowerCase() === name.toLowerCase());
  if (has("Transfer-Encoding")) throw new TypeError("request Transfer-Encoding is not supported");

  // WorkBuddy 5.9.3's enabled RequestBodyGzip processor compresses every nonempty
  // default chat POST body; it has no 1024-byte threshold.
  if (path === "/v2/chat/completions" && method === "POST" && body.length > 0 && !has("Content-Encoding")) {
    body = gzipSync(body);
    headers.push({ name: "Content-Encoding", value: "gzip" });
  }
  const length = headers.find((h) => h.name.toLowerCase() === "content-length");
  if (length && (!/^\d+$/.test(length.value) || Number(length.value) !== body.length)) {
    throw new TypeError("request Content-Length does not match serialized body");
  }
  if (init.body !== undefined && !length) {
    headers.push({ name: "Content-Length", value: String(body.length) });
  }
  if (path === "/v2/chat/completions" && !has("Accept-Encoding")) {
    headers.push({ name: "Accept-Encoding", value: "gzip, compress, deflate, br" });
  }
  if (!has("Host")) headers.push({ name: "Host", value: hostHeader(url) });
  if (!has("Connection")) headers.push({ name: "Connection", value: "keep-alive" });

  const head = [
    `${method} ${requestTarget(url)} HTTP/1.1`,
    ...orderedHeaders(path, headers).map(({ name, value }) => `${name}: ${value}`),
    "", "",
  ].join("\r\n");
  return Buffer.concat([Buffer.from(head, "latin1"), body]);
}

function noProxyMatch(url: URL): boolean {
  const list = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return list.split(",").map((v) => v.trim().toLowerCase()).some((item) => {
    if (!item) return false;
    if (item === "*") return true;
    const [entryHost, entryPort] = item.startsWith("[")
      ? [item.slice(1, item.indexOf("]")), item.includes("]:") ? item.split("]:")[1] : ""]
      : item.split(":");
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    if (entryPort && entryPort !== port) {
      return false;
    }
    const domain = entryHost.replace(/^\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

function proxyFor(url: URL, explicit?: string | null): URL | null {
  if (explicit === null || (explicit === undefined && noProxyMatch(url))) return null;
  const value = explicit ?? (url.protocol === "https:"
    ? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.HTTP_PROXY ?? process.env.http_proxy
    : process.env.HTTP_PROXY ?? process.env.http_proxy);
  if (!value) return null;
  const proxy = new URL(value);
  if (proxy.protocol !== "http:") throw new Error(`unsupported proxy protocol: ${proxy.protocol}`);
  return proxy;
}

function helperPath(): string {
  const filename = process.platform === "win32" ? "official-tls.exe" : "official-tls";
  return resolve(process.cwd(), "native", "official-tls", "bin", filename);
}

async function officialTLSConnection(url: URL, proxy: URL | null, signal?: AbortSignal, connectHost?: string, rootCA?: string): Promise<Socket> {
  if (signal?.aborted) throw abortReason(signal);
  return await new Promise<Socket>((resolveSocket, reject) => {
    const helper = spawn(helperPath(), [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const socket = new OfficialTLSSocket(helper);
    let ready = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      helper.stdout?.off("data", onData);
      helper.stderr?.off("data", onStderr);
      helper.off("error", fail);
      helper.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      helper.stdout?.pause();
      helper.stdout?.on("data", (chunk: Buffer) => {
        if (!socket.push(chunk)) helper.stdout?.pause();
      });
      helper.stdout?.on("end", () => socket.push(null));
      helper.once("error", (error) => socket.destroy(error));
      helper.once("exit", (code, exitSignal) => {
        if (!socket.destroyed && (code !== 0 || exitSignal)) {
          socket.destroy(new Error(`official TLS helper exited (${code ?? exitSignal}): ${stderr.toString().trim()}`));
        }
      });
      resolveSocket(socket);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      helper.kill();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      ready = Buffer.concat([ready, chunk]);
      const end = ready.indexOf(10);
      if (end < 0) return;
      if (ready.subarray(0, end).toString("ascii") !== "READY") {
        fail(new Error("official TLS helper returned an invalid handshake marker"));
        return;
      }
      const remainder = ready.subarray(end + 1);
      if (remainder.length) socket.push(remainder);
      succeed();
    };
    const onStderr = (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]); };
    const onExit = (code: number | null) => {
      fail(new Error(`official TLS handshake failed (${code ?? "signal"}): ${stderr.toString().trim()}`));
    };
    const onAbort = () => fail(abortReason(signal!));
    const timer = setTimeout(() => fail(new Error("official TLS handshake timeout")), TLS_HELPER_TIMEOUT_MS);
    helper.stdout?.on("data", onData);
    helper.stderr?.on("data", onStderr);
    helper.once("error", fail);
    helper.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    helper.stdin?.write(JSON.stringify({
      serverName: url.hostname.replace(/^\[|\]$/g, ""),
      host: connectHost ?? url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || 443),
      ...(proxy ? { proxy: proxy.toString() } : {}),
      ...(rootCA ? { rootCA } : {}),
    }) + "\n");
  });
}

async function openSocket(url: URL, proxy: URL | null, signal?: AbortSignal, connectHost?: string, rootCA?: string): Promise<Socket> {
  if (signal?.aborted) throw abortReason(signal);
  if (url.protocol === "https:") return await officialTLSConnection(url, proxy, signal, connectHost, rootCA);

  const endpoint = proxy ?? url;
  const plain = await new Promise<Socket>((resolve, reject) => {
    const socket = new Socket();
    const cleanup = () => {
      socket.off("error", fail);
      socket.off("connect", onConnect);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => { cleanup(); socket.destroy(); reject(error); };
    const onConnect = () => { cleanup(); resolve(socket); };
    const onAbort = () => fail(abortReason(signal!));
    socket.once("connect", onConnect);
    socket.once("error", fail);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.connect(Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)), endpoint.hostname.replace(/^\[|\]$/g, ""));
  });
  return plain;
}

class PooledConnection {
  // 显式标注为 Buffer（Buffer<ArrayBufferLike>）：Buffer.alloc(0) 会被推断成
  // Buffer<ArrayBuffer>，而 Buffer.concat() 在 @types/node 22 返回
  // Buffer<ArrayBufferLike>，赋值处会报 TS2322。
  private buffer: Buffer = Buffer.alloc(0);
  private parser: ResponseParser | null = null;
  private state: "head" | "length" | "chunk-size" | "chunk-data" | "chunk-crlf" | "chunk-trailer" | "eof" = "head";
  private remaining = 0;
  private reusable = true;
  private requestReusable = true;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private method = "GET";

  constructor(readonly key: string, private socket: Socket, private onIdle: (conn: PooledConnection) => void) {
    socket.on("data", (chunk: Buffer) => this.consume(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      this.closed = true;
      this.clearIdle();
      removeIdle(this);
      if (this.parser) {
        if (this.state === "eof") {
          this.parser.end();
          this.parser = null;
        } else this.fail(new Error("upstream connection closed before response completed"));
      }
    });
  }

  get idle(): boolean { return !this.closed && !this.parser && !this.socket.destroyed; }

  start(parser: ResponseParser, requestReusable: boolean, method: string): void {
    if (!this.idle) throw new Error("upstream connection is not idle");
    this.clearIdle();
    this.parser = parser;
    this.state = "head";
    this.remaining = 0;
    this.reusable = true;
    this.requestReusable = requestReusable;
    this.method = method;
    this.buffer = Buffer.alloc(0);
    this.socket.resume();
  }

  write(data: Buffer): void { this.socket.write(data); }
  pause(): void { this.socket.pause(); }
  resume(): void { this.socket.resume(); }
  owns(parser: ResponseParser): boolean { return this.parser === parser; }
  destroy(error?: unknown): void {
    if (error) this.fail(error);
    this.socket.destroy();
  }

  idleLater(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.socket.destroy(), IDLE_TIMEOUT_MS);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private fail(error: unknown): void {
    const parser = this.parser;
    this.parser = null;
    this.closed = true;
    this.clearIdle();
    removeIdle(this);
    parser?.fail(error);
    this.socket.destroy();
  }

  private complete(): void {
    const parser = this.parser;
    this.parser = null;
    // This transport does not pipeline: unsolicited bytes after a response must
    // never be reused as the next request's response.
    if (this.buffer.length > 0) this.reusable = false;
    this.buffer = Buffer.alloc(0);
    parser?.end();
    if (!this.closed && this.reusable && !this.socket.destroyed) this.onIdle(this);
    else this.socket.destroy();
  }

  private parseHead(end: number): boolean {
    const text = this.buffer.subarray(0, end).toString("latin1");
    this.buffer = this.buffer.subarray(end + 4);
    const lines = text.split("\r\n");
    const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? "");
    if (!match) { this.fail(new Error("invalid upstream HTTP status line")); return false; }
    const status = Number(match[1]);
    if (status >= 100 && status < 200 && status !== 101) {
      this.state = "head";
      return true;
    }
    const headers = new Headers();
    for (const line of lines.slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
    }
    if (status < 200 || status > 599) { this.fail(new Error("unsupported upstream HTTP status")); return false; }
    const connection = (headers.get("connection") ?? "").toLowerCase().split(",").map((v) => v.trim());
    this.reusable = this.requestReusable && !connection.includes("close") &&
      (lines[0].startsWith("HTTP/1.1") || connection.includes("keep-alive"));
    const transfer = (headers.get("transfer-encoding") ?? "").toLowerCase();
    const length = headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) {
      this.fail(new Error("invalid upstream Content-Length framing")); return false;
    }
    if (transfer && (transfer !== "chunked" || length !== null)) {
      this.fail(new Error("ambiguous or unsupported upstream response framing")); return false;
    }
    const result = { status, statusText: match[2] ?? "", headers };
    this.parser?.head(result);
    const noBody = this.method === "HEAD" || status === 204 || status === 205 || status === 304;
    if (noBody) { this.complete(); return true; }
    if (transfer === "chunked") this.state = "chunk-size";
    else if (length !== null && /^\d+$/.test(length)) {
      this.remaining = Number(length);
      if (this.remaining === 0) { this.complete(); return true; }
      this.state = "length";
    } else {
      this.state = "eof";
      this.reusable = false;
    }
    return true;
  }

  private consume(chunk: Buffer): void {
    if (!this.parser) { this.destroy(new Error("unexpected data on idle upstream connection")); return; }
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    try {
      while (this.parser && this.buffer.length > 0) {
        if (this.state === "head") {
          const end = this.buffer.indexOf("\r\n\r\n");
          if (end > MAX_HEADER_BYTES || (end < 0 && this.buffer.length > MAX_HEADER_BYTES)) {
            this.fail(new Error("upstream response headers too large")); return;
          }
          if (end < 0) return;
          if (!this.parseHead(end)) return;
        } else if (this.state === "length") {
          const size = Math.min(this.remaining, this.buffer.length);
          this.parser.data(this.buffer.subarray(0, size));
          this.buffer = this.buffer.subarray(size);
          this.remaining -= size;
          if (this.remaining === 0) this.complete();
          else return;
        } else if (this.state === "chunk-size") {
          const end = this.buffer.indexOf("\r\n");
          if (end > MAX_HEADER_BYTES || (end < 0 && this.buffer.length > MAX_HEADER_BYTES)) {
            this.fail(new Error("upstream chunk header too large")); return;
          }
          if (end < 0) return;
          const sizeText = this.buffer.subarray(0, end).toString("latin1").split(";")[0];
          if (!/^[0-9a-fA-F]+$/.test(sizeText)) { this.fail(new Error("invalid chunk size")); return; }
          this.remaining = parseInt(sizeText, 16);
          if (!Number.isSafeInteger(this.remaining)) { this.fail(new Error("upstream chunk size too large")); return; }
          this.buffer = this.buffer.subarray(end + 2);
          this.state = this.remaining === 0 ? "chunk-trailer" : "chunk-data";
        } else if (this.state === "chunk-data") {
          const size = Math.min(this.remaining, this.buffer.length);
          this.parser.data(this.buffer.subarray(0, size));
          this.buffer = this.buffer.subarray(size);
          this.remaining -= size;
          if (this.remaining > 0) return;
          this.state = "chunk-crlf";
        } else if (this.state === "chunk-crlf") {
          if (this.buffer.length < 2) return;
          if (this.buffer[0] !== 13 || this.buffer[1] !== 10) {
            this.fail(new Error("invalid chunk terminator")); return;
          }
          this.buffer = this.buffer.subarray(2);
          this.state = "chunk-size";
        } else if (this.state === "chunk-trailer") {
          if (this.buffer.length >= 2 && this.buffer[0] === 13 && this.buffer[1] === 10) {
            this.buffer = this.buffer.subarray(2);
            this.complete();
          } else {
            const end = this.buffer.indexOf("\r\n\r\n");
            if (end > MAX_HEADER_BYTES || (end < 0 && this.buffer.length > MAX_HEADER_BYTES)) {
              this.fail(new Error("upstream trailers too large")); return;
            }
            if (end < 0) return;
            this.buffer = this.buffer.subarray(end + 4);
            this.complete();
          }
        } else {
          this.parser.data(this.buffer);
          this.buffer = Buffer.alloc(0);
          return;
        }
      }
    } catch (error) { this.fail(error); }
  }
}

const pools = new Map<string, PooledConnection[]>();

function removeIdle(conn: PooledConnection): void {
  const pool = pools.get(conn.key);
  if (!pool) return;
  const index = pool.indexOf(conn);
  if (index >= 0) pool.splice(index, 1);
  if (pool.length === 0) pools.delete(conn.key);
}

function takeIdle(key: string): PooledConnection | null {
  const pool = pools.get(key);
  while (pool?.length) {
    const conn = pool.pop()!;
    if (pool.length === 0) pools.delete(key);
    if (conn.idle) return conn;
  }
  return null;
}

function releaseIdle(conn: PooledConnection): void {
  const pool = pools.get(conn.key) ?? [];
  const total = [...pools.values()].reduce((count, entries) => count + entries.length, 0);
  if (pool.length >= MAX_IDLE_PER_ORIGIN || total >= MAX_IDLE_CONNECTIONS) {
    conn.destroy();
    return;
  }
  pool.push(conn);
  pools.set(conn.key, pool);
  conn.idleLater();
}

export function closeOfficialEgressConnections(): void {
  const idle = [...pools.values()].flat();
  pools.clear();
  for (const conn of idle) conn.destroy();
}

function rawResponseStream(conn: PooledConnection, signal?: AbortSignal): {
  stream: ReadableStream<Uint8Array>;
  parser: ResponseParser;
  head: Promise<{ status: number; statusText: string; headers: Headers }>;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  let completed = false;
  let resolveHead!: (value: { status: number; statusText: string; headers: Headers }) => void;
  let rejectHead!: (reason: unknown) => void;
  const head = new Promise<{ status: number; statusText: string; headers: Headers }>((resolve, reject) => {
    resolveHead = resolve; rejectHead = reject;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    pull() { conn.resume(); },
    cancel(reason) {
      cleanupAbort();
      if (!completed) conn.destroy(reason ?? new DOMException("Response body cancelled", "AbortError"));
    },
  });
  const abort = () => conn.destroy(abortReason(signal!));
  const cleanupAbort = () => signal?.removeEventListener("abort", abort);
  const parser: ResponseParser = {
    head(value) { settled = true; resolveHead(value); },
    data(chunk) {
      controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      if ((controller.desiredSize ?? 0) <= 0) conn.pause();
    },
    end() { completed = true; cleanupAbort(); controller.close(); },
    fail(error) {
      completed = true;
      cleanupAbort();
      controller.error(error);
      if (!settled) { settled = true; rejectHead(error); }
    },
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return { stream, parser, head };
}

function decodeResponse(stream: ReadableStream<Uint8Array>, encoding: string): ReadableStream<Uint8Array> {
  const normalized = encoding.trim().toLowerCase();
  if (!normalized || normalized === "identity") return stream;
  const encodings = normalized.split(",").map((value) => value.trim());
  if (encodings.length > 1) {
    return encodings.reduceRight((body, value) => decodeResponse(body, value), stream);
  }
  if (!["gzip", "x-gzip", "br", "deflate"].includes(normalized)) {
    throw new Error(`unsupported upstream Content-Encoding: ${normalized}`);
  }
  const source = Readable.fromWeb(stream as import("stream/web").ReadableStream<Uint8Array>);
  const strategy = {
    highWaterMark: 64 * 1024,
    size: (chunk: Uint8Array) => chunk.byteLength,
  };
  if (normalized !== "deflate") {
    const decoder = normalized === "br" ? createBrotliDecompress() : createGunzip();
    // pipeline propagates errors, backpressure and consumer cancellation both ways.
    pipeline(source, decoder, () => undefined);
    return Readable.toWeb(decoder, { strategy }) as ReadableStream<Uint8Array>;
  }
  // Deflate may be zlib-wrapped or raw. Sniff only the first two bytes, lazily,
  // so returning the response headers never waits for body data.
  const output = new PassThrough();
  output.once("close", () => source.destroy());
  void (async () => {
    const iterator = source[Symbol.asyncIterator]();
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (bytes < 2) {
      const next = await iterator.next();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      chunks.push(chunk); bytes += chunk.length;
    }
    if (bytes < 2) throw new Error("unexpected end of compressed deflate body");
    if (output.destroyed) return;
    const prefix = Buffer.concat(chunks);
    const wrapped = (prefix[0] & 0x0f) === 8 && ((prefix[0] << 8) | prefix[1]) % 31 === 0;
    const input = Readable.from((async function* () {
      yield prefix;
      for await (const chunk of iterator) yield chunk;
    })(), { objectMode: false });
    pipeline(input, wrapped ? createInflate() : createInflateRaw(), output, () => source.destroy());
  })().catch((error: unknown) => output.destroy(error instanceof Error ? error : new Error(String(error))));
  return Readable.toWeb(output, { strategy }) as ReadableStream<Uint8Array>;
}

export async function officialEgress(input: string | URL, init: OfficialEgressInit = {}): Promise<Response> {
  const url = typeof input === "string" ? new URL(input) : input;
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`unsupported URL protocol: ${url.protocol}`);
  if (init.signal?.aborted) throw abortReason(init.signal);
  const serialized = serializeRequest(url, init);
  const proxy = proxyFor(url, init.proxy);
  // Never share sockets across proxy credentials, test dial targets or trust roots.
  const key = JSON.stringify([url.origin, proxy?.href ?? "direct", init.connectHost ?? "", init.rootCA ?? ""]);
  const timeout = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, timeout.signal]) : timeout.signal;
  const timer = init.timeoutMs && init.timeoutMs > 0
    ? setTimeout(() => timeout.abort(new DOMException("upstream header timeout", "TimeoutError")), init.timeoutMs)
    : null;
  timer?.unref();
  let conn = takeIdle(key);
  let owner: ResponseParser | undefined;
  try {
    if (!conn) conn = new PooledConnection(key, await openSocket(url, proxy, signal, init.connectHost, init.rootCA), releaseIdle);
    if (signal.aborted) throw abortReason(signal);
    const { stream, parser, head } = rawResponseStream(conn, signal);
    owner = parser;
    const connection = Object.entries(init.headers ?? {})
      .find(([name]) => name.toLowerCase() === "connection")?.[1] ?? "keep-alive";
    const method = (init.method ?? "GET").toUpperCase();
    conn.start(parser, !connection.toLowerCase().split(",").some((token) => token.trim() === "close"), method);
    if (proxy && url.protocol === "http:") {
      // Plain HTTP proxies require absolute-form. Rebuild only the request line.
      const end = serialized.indexOf("\r\n");
      const line = `${method} ${url.origin}${url.pathname}${url.search} HTTP/1.1`;
      conn.write(Buffer.concat([Buffer.from(line, "latin1"), serialized.subarray(end)]));
    } else conn.write(serialized);
    const result = await head;
    if (timer) clearTimeout(timer);
    const noBody = method === "HEAD" || result.status === 204 || result.status === 205 || result.status === 304;
    const encoding = result.headers.get("content-encoding") ?? "";
    const body = noBody ? null : decodeResponse(stream, encoding);
    // These headers describe compressed/framed wire bytes, not the decoded body.
    result.headers.delete("transfer-encoding");
    if (!noBody && encoding && encoding.toLowerCase() !== "identity") {
      result.headers.delete("content-encoding");
      result.headers.delete("content-length");
    }
    return new Response(noBody ? null : body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  } catch (error) {
    if (timer) clearTimeout(timer);
    if (conn && (!owner || conn.owns(owner))) conn.destroy(error);
    throw error;
  }
}

// Exported for the wire fixture only; not used by application request builders.
export function officialRequestFixture(url: string, init: OfficialEgressInit): string {
  const packet = serializeRequest(new URL(url), init);
  const end = packet.indexOf("\r\n\r\n");
  return packet.subarray(0, end).toString("latin1");
}
