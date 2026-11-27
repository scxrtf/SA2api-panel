// Test-only isolation. Never load this module from production code.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { mock } from "node:test";
import { Socket } from "node:net";

const originalFetch = globalThis.fetch;
const loopback = (host: string) => ["127.0.0.1", "localhost", "[::1]", "::1"].includes(host.toLowerCase());
const originalConnect = Socket.prototype.connect;
Socket.prototype.connect = function (...args: unknown[]) {
  // Node's createConnection can pass its internally normalized [options, cb]
  // tuple as a single argument; support it as well as public connect overloads.
  const normalized = Array.isArray(args[0]) ? args[0] : args;
  const first = normalized[0];
  const options = first && typeof first === "object" ? first as { host?: string; hostname?: string; path?: string } : null;
  const host = options?.host ?? options?.hostname ?? (typeof normalized[1] === "string" ? normalized[1] : "localhost");
  if (!options?.path && !loopback(host)) throw new Error(`offline test blocked TCP connection: ${host}`);
  return Reflect.apply(originalConnect, this, args);
} as Socket["connect"];

// A forgotten stub must fail a test rather than consume real upstream credits.
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!loopback(url.hostname)) throw new Error(`offline test blocked network: ${url.origin}`);
  return originalFetch(input, init);
};

process.env.USE_CLOUDBASE_REST = "0";
process.env.WB2API_OFFLINE_TEST = "1";
process.env.CLOUDBASE_POSTGREST_URL = "http://127.0.0.1:9";
process.env.CLOUDBASE_API_KEY = "offline-test";
delete process.env.DATABASE_URL;
delete process.env.DIRECT_URL;
for (const key of Object.keys(process.env)) if (key.startsWith("WB2A_RESPONSES_")) delete process.env[key];
delete process.env.WB2A_SUPER_PASSWORD;
delete process.env.WB2A_MACHINE_PASSWORD;
delete process.env.RUN_BALANCE_INTEGRATION;
if (process.env.WB2API_TEST_MODEL_JSON !== "1") process.env.WB2API_MODEL_JSON_DISABLE = "1";
else delete process.env.WB2API_MODEL_JSON_DISABLE;
process.env.WB2API_DATA_DIR ||= mkdtempSync(join(tmpdir(), "wb2api-offline-data-"));

// Fail closed if a test forgets its DB fixture. The application catches some
// read errors by design, but no query can reach a real database from this suite.
const unavailableModel = new Proxy({}, {
  get(_target, operation) {
    return async () => { throw new Error(`offline test requires DB fixture: ${String(operation)}`); };
  },
});
(globalThis as typeof globalThis & { prisma?: unknown }).prisma = new Proxy({}, {
  get() { return unavailableModel; },
});

const testFile = basename(process.argv[1] ?? "");
const realWireTest = /^official-(?:egress|client-hello)(?:[.-])/.test(testFile);
const egressModule = new URL("../src/lib/upstream/official-egress.ts", import.meta.url).href;
if (realWireTest) {
  const actual = await import(egressModule);
  mock.module(egressModule, {
    namedExports: {
      ...actual,
      officialEgress: (input: string | URL, init: { proxy?: string | null; connectHost?: string } = {}) => {
        const url = new URL(String(input));
        // The TLS helper is a separate Go process, so validate its effective
        // destination here too instead of relying only on the Node TCP guard.
        const destination = init.proxy ? new URL(init.proxy).hostname : init.connectHost ?? url.hostname;
        if (!loopback(destination)) throw new Error(`offline test blocked native egress: ${destination}`);
        return actual.officialEgress(input, init);
      },
    },
  });
} else {
  // Business-logic tests already replace fetch with deterministic fixtures.
  // Redirect only this test process's native egress to those same fixtures;
  // wire/TLS tests deliberately retain the actual transport and local servers.
  mock.module(egressModule, {
    namedExports: {
      officialEgress: (input: string | URL, init?: RequestInit) => globalThis.fetch(input, init),
      closeOfficialEgressConnections() {},
      officialRequestFixture() { throw new Error("wire fixtures require an official-egress test"); },
    },
  });
}
