// Official desktop egress: Node HTTP/1.1 transport with wire-exact headers.
// Global fetch/undici normalizes header spelling/order, so the official routes
// use this module instead of fetch. The local uTLS helper reproduces the official
// Node/OpenSSL ClientHello without depending on the host's OpenSSL version.
import { spawn } from "child_process";
import { Socket } from "net";
import { PassThrough, Readable, Transform } from "stream";
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
  let body = init.body === undefined
    ? Buffer.alloc(0)
    : Buffer.isBuffer(init.body)
      ? init.body
      : Buffer.from(init.body);
  const headers: HeaderEntry[] = Object.entries(init.headers ?? {}).map(([name, value]) => ({
    name: OFFICIAL_HEADER_SPELLING[name.toLowerCase()] ?? name,
    value,
  }));
  const has = (name: string) => headers.some((h) => h.name.toLowerCase() === name.toLowerCase());

  if (path === "/v2/chat/completions" && body.length > 1024 && !has("Content-Encoding")) {
    body = gzipSync(body);
    headers.push({ name: "Content-Encoding", value: "gzip" });
  }
  if (init.body !== undefined && !has("Content-Length")) {
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
  const host = url.hostname.toLowerCase();
  return list.split(",").map((v) => v.trim().toLowerCase()).some((item) => {
    if (!item) return false;
    if (item === "*") return true;
    const [entryHost, entryPort] = item.startsWith("[")
      ? [item.slice(1, item.indexOf("]")), item.includes("]:") ? item.split("]:")[1] : ""]
      : item.split(":");
    if (entryPort && entryPort !== url.port && !(entryPort === "443" && !url.port && url.protocol === "https:")) {
      return false;
    }
    const domain = entryHost.replace(/^\./, "");
    return host === domain || host.endsWith(`.${domain}`);
  });
}

function proxyFor(url: URL, explicit?: string | null): URL | null {
  if (explicit === null || noProxyMatch(url)) return null;
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
    const helper = spawn(helperPath(), [], { stdio: ["pipe", "pipe", "pipe"] });
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
      serverName: url.hostname,
      host: connectHost ?? url.hostname,
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
    socket.connect(Number(endpoint.port || (endpoint.protocol === "https:" ? 443 : 80)), endpoint.hostname);
  });
  return plain;
}

class PooledConnection {
  // 显式标注为 Buffer（Buffer<ArrayBufferLike>）：Buffer.alloc(0) 会被推断成
  // Buffer<ArrayBuffer>，而 Buffer.concat() 在 @types/node 22 返回
  // Buffer<ArrayBufferLike>，赋值处会报 TS2322。
  private buffer: Buffer = Buffer.alloc(0);
  private parser: ResponseParser | null = null;
  private state: "head" | "length" | "chunk-size" | "chunk-data" | "chunk-trailer" | "eof" = "head";
  private remaining = 0;
  private reusable = true;
  private requestReusable = true;
  private idleTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(readonly key: string, private socket: Socket, private onIdle: (conn: PooledConnection) => void) {
    socket.on("data", (chunk: Buffer) => this.consume(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      this.closed = true;
      this.clearIdle();
      if (this.parser) {
        if (this.state === "eof") {
          this.parser.end();
          this.parser = null;
        } else this.fail(new Error("upstream connection closed before response completed"));
      }
    });
  }

  get idle(): boolean { return !this.closed && !this.parser && !this.socket.destroyed; }

  start(parser: ResponseParser, requestReusable: boolean): void {
    if (!this.idle) throw new Error("upstream connection is not idle");
    this.clearIdle();
    this.parser = parser;
    this.state = "head";
    this.remaining = 0;
    this.reusable = true;
    this.requestReusable = requestReusable;
    this.buffer = Buffer.alloc(0);
  }

  write(data: Buffer): void { this.socket.write(data); }
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
    parser?.fail(error);
    this.socket.destroy();
  }

  private complete(): void {
    const parser = this.parser;
    this.parser = null;
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
    const connection = (headers.get("connection") ?? "").toLowerCase();
    this.reusable = this.requestReusable && !connection.includes("close");
    const result = { status, statusText: match[2] ?? "", headers };
    this.parser?.head(result);
    const noBody = status === 204 || status === 205 || status === 304;
    if (noBody) { this.complete(); return true; }
    const transfer = (headers.get("transfer-encoding") ?? "").toLowerCase();
    const length = headers.get("content-length");
    if (transfer.includes("chunked")) this.state = "chunk-size";
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
          if (this.buffer.length > MAX_HEADER_BYTES && !this.buffer.includes("\r\n\r\n")) {
            this.fail(new Error("upstream response headers too large")); return;
          }
          const end = this.buffer.indexOf("\r\n\r\n");
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
          if (end < 0) return;
          const sizeText = this.buffer.subarray(0, end).toString("latin1").split(";")[0];
          if (!/^[0-9a-fA-F]+$/.test(sizeText)) { this.fail(new Error("invalid chunk size")); return; }
          this.remaining = parseInt(sizeText, 16);
          this.buffer = this.buffer.subarray(end + 2);
          this.state = this.remaining === 0 ? "chunk-trailer" : "chunk-data";
        } else if (this.state === "chunk-data") {
          if (this.buffer.length < this.remaining + 2) return;
          this.parser.data(this.buffer.subarray(0, this.remaining));
          if (this.buffer[this.remaining] !== 13 || this.buffer[this.remaining + 1] !== 10) {
            this.fail(new Error("invalid chunk terminator")); return;
          }
          this.buffer = this.buffer.subarray(this.remaining + 2);
          this.state = "chunk-size";
        } else if (this.state === "chunk-trailer") {
          if (this.buffer.length >= 2 && this.buffer[0] === 13 && this.buffer[1] === 10) {
            this.buffer = this.buffer.subarray(2);
            this.complete();
          } else {
            const end = this.buffer.indexOf("\r\n\r\n");
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

function takeIdle(key: string): PooledConnection | null {
  const pool = pools.get(key);
  while (pool?.length) {
    const conn = pool.shift()!;
    if (conn.idle) return conn;
  }
  return null;
}

function releaseIdle(conn: PooledConnection): void {
  const pool = pools.get(conn.key) ?? [];
  pool.push(conn);
  pools.set(conn.key, pool);
  conn.idleLater();
}

export function closeOfficialEgressConnections(): void {
  for (const pool of pools.values()) for (const conn of pool) conn.destroy();
  pools.clear();
}

function rawResponseStream(conn: PooledConnection, signal?: AbortSignal): {
  stream: ReadableStream<Uint8Array>;
  parser: ResponseParser;
  head: Promise<{ status: number; statusText: string; headers: Headers }>;
} {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  let resolveHead!: (value: { status: number; statusText: string; headers: Headers }) => void;
  let rejectHead!: (reason: unknown) => void;
  const head = new Promise<{ status: number; statusText: string; headers: Headers }>((resolve, reject) => {
    resolveHead = resolve; rejectHead = reject;
  });
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel(reason) {
      cleanupAbort();
      conn.destroy(reason ?? new DOMException("Response body cancelled", "AbortError"));
    },
  });
  const abort = () => conn.destroy(abortReason(signal!));
  const cleanupAbort = () => signal?.removeEventListener("abort", abort);
  const parser: ResponseParser = {
    head(value) { settled = true; resolveHead(value); },
    data(chunk) { controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); },
    end() { cleanupAbort(); controller.close(); },
    fail(error) {
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
  const output = new PassThrough();
  let decoder: ReturnType<typeof createGunzip> | ReturnType<typeof createBrotliDecompress> |
    ReturnType<typeof createInflate> | ReturnType<typeof createInflateRaw> | null = null;
  let prefix = Buffer.alloc(0);
  const input = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        if (!decoder) {
          prefix = Buffer.concat([prefix, chunk]);
          if (normalized === "deflate" && prefix.length < 2) { callback(); return; }
          if (normalized === "gzip" || normalized === "x-gzip") decoder = createGunzip();
          else if (normalized === "br") decoder = createBrotliDecompress();
          else {
            const zlibHeader = (prefix[0] & 0x0f) === 8 && ((prefix[0] << 8) | prefix[1]) % 31 === 0;
            decoder = zlibHeader ? createInflate() : createInflateRaw();
          }
          decoder.on("error", (error) => output.destroy(error));
          decoder.pipe(output);
          decoder.write(prefix, callback);
          prefix = Buffer.alloc(0);
          return;
        }
        decoder.write(chunk, callback);
      } catch (error) { callback(error as Error); }
    },
    flush(callback) { if (decoder) decoder.end(callback); else callback(); },
  });
  input.on("error", (error) => output.destroy(error));
  const pump = (async () => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!input.write(value)) await new Promise<void>((resolve) => input.once("drain", resolve));
      }
      input.end();
    } catch (error) { output.destroy(error as Error); }
  })();
  void pump.catch(() => undefined);
  return Readable.toWeb(output) as ReadableStream<Uint8Array>;
}

export async function officialEgress(input: string | URL, init: OfficialEgressInit = {}): Promise<Response> {
  const url = typeof input === "string" ? new URL(input) : input;
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`unsupported URL protocol: ${url.protocol}`);
  if (init.signal?.aborted) throw abortReason(init.signal);
  const proxy = proxyFor(url, init.proxy);
  const key = `${url.origin}|${proxy?.origin ?? "direct"}`;
  let conn = takeIdle(key);
  if (!conn) conn = new PooledConnection(key, await openSocket(url, proxy, init.signal, init.connectHost, init.rootCA), releaseIdle);

  const { stream, parser, head } = rawResponseStream(conn, init.signal);
  const connection = Object.entries(init.headers ?? {})
    .find(([name]) => name.toLowerCase() === "connection")?.[1] ?? "keep-alive";
  conn.start(parser, !connection.toLowerCase().split(",").some((token) => token.trim() === "close"));
  const timer = init.timeoutMs && init.timeoutMs > 0
    ? setTimeout(() => conn?.destroy(new DOMException("upstream header timeout", "TimeoutError")), init.timeoutMs)
    : null;
  timer?.unref();
  try {
    const target = proxy && url.protocol === "http:" ? new URL(url) : url;
    const serialized = serializeRequest(target, init);
    if (proxy && url.protocol === "http:") {
      // Plain HTTP proxies require absolute-form. Rebuild only the request line.
      const end = serialized.indexOf("\r\n");
      const line = `${(init.method ?? "GET").toUpperCase()} ${url.toString()} HTTP/1.1`;
      conn.write(Buffer.concat([Buffer.from(line, "latin1"), serialized.subarray(end)]));
    } else conn.write(serialized);
    const result = await head;
    if (timer) clearTimeout(timer);
    const body = decodeResponse(stream, result.headers.get("content-encoding") ?? "");
    const noBody = result.status === 204 || result.status === 205 || result.status === 304;
    return new Response(noBody ? null : body, {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  } catch (error) {
    if (timer) clearTimeout(timer);
    conn.destroy(error);
    throw error;
  }
}

// Exported for the wire fixture only; not used by application request builders.
export function officialRequestFixture(url: string, init: OfficialEgressInit): string {
  const packet = serializeRequest(new URL(url), init);
  const end = packet.indexOf("\r\n\r\n");
  return packet.subarray(0, end).toString("latin1");
}
