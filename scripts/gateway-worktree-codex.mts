import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { findCodex } from "../workers/workspace/codex";
import { childEnv } from "../workers/workspace/files";
import type { Snapshot } from "../src/lib/workspace/contracts";

const gateway = new URL(process.env.WB2_WORKSPACE_QA_URL || "http://127.0.0.1:3291");
assert.ok(gateway.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(gateway.hostname) && gateway.port === "3291");
const key = process.env.WB2_WORKSPACE_QA_GATEWAY_KEY || "gateway-worktree-fixture";
const binary = findCodex();
assert.ok(binary, "Install a Codex CLI or set WB2_WORKSPACE_CODEX_BIN.");
const exec = promisify(execFile);
const qa = resolve(process.env.WB2_WORKSPACE_QA_DIR || ".runtime/workspace-qa", "gateway-captures");
const fixture = await mkdtemp(join(tmpdir(), "wb2-session-codex-"));
const names = new Set<string>();
let modelRequests = 0;

// Observe which native headers get sent, without exporting their values or prompts.
const proxy = createServer(async (req, res) => {
  const path = req.url;
  if (path !== "/api/v1/responses" || req.method !== "POST" || req.headers.authorization !== "Bearer " + key) {
    res.writeHead(404).end();
    return;
  }
  try {
    for (const name of Object.keys(req.headers)) if (/session|thread|conversation|installation|subagent/.test(name)) names.add(name);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 8 * 1024 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(bytes);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string" && !["host", "content-length", "transfer-encoding", "connection", "accept-encoding"].includes(name)) {
        headers.set(name, value);
      }
    }
    modelRequests++;
    const response = await fetch(new URL(path, gateway), {
      method: "POST", headers, body: Buffer.concat(chunks), signal: AbortSignal.timeout(25_000),
    });
    res.writeHead(response.status, { "Content-Type": response.headers.get("content-type") ?? "application/json" });
    if (response.body) Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]).on("error", () => res.destroy()).pipe(res);
    else res.end();
  } catch { res.writeHead(502).end(); }
});

try {
  await new Promise<void>((done) => proxy.listen(0, "127.0.0.1", done));
  const proxyPort = (proxy.address() as { port: number }).port;
  const version = (await exec(binary, ["--version"], { timeout: 10_000, windowsHide: true })).stdout.trim();
  const stamp = Date.now().toString(36);
  const identities = ["codex-cli-desktop-" + stamp, "codex-cli-laptop-" + stamp];
  async function configure(machine: string) {
    const home = join(fixture, machine, "home"), cwd = join(fixture, machine, "project");
    await mkdir(home, { recursive: true }); await mkdir(cwd, { recursive: true });
    await writeFile(join(home, "config.toml"), [
      'model = "gpt-5.4"', 'model_provider = "fixture"', 'approval_policy = "never"', 'sandbox_mode = "read-only"',
      "[model_providers.fixture]", 'name = "Local gateway QA"', `base_url = "http://127.0.0.1:${proxyPort}/api/v1"`,
      'wire_api = "responses"', 'env_key = "WB2_WORKSPACE_QA_GATEWAY_KEY"', 'requires_openai_auth = false', 'supports_websockets = false',
      `http_headers = { "X-WB2A-Machine-Id" = "${machine}" }`, "[analytics]", "enabled = false", "",
    ].join("\n"));
    return { home, cwd };
  }
  const first = await configure(identities[0]), second = await configure(identities[1]);
  async function run({ home, cwd }: typeof first, prompt: string, previous?: string) {
    const args = previous
      ? ["exec", "resume", "--skip-git-repo-check", "--json", previous, prompt]
      : ["exec", "--skip-git-repo-check", "--json", prompt];
    const process = exec(binary!, args, {
      cwd, windowsHide: true, timeout: 40_000, maxBuffer: 512 * 1024,
      env: { ...childEnv(), CODEX_HOME: home, WB2_WORKSPACE_QA_GATEWAY_KEY: key },
    });
    process.child.stdin?.end();
    const { stdout } = await process;
    const events = stdout.trim().split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { type: string; thread_id?: string });
    assert.ok(events.some(({ type }) => type === "turn.completed"), stdout.slice(-1000));
    const id = events.find(({ type }) => type === "thread.started")?.thread_id;
    assert.ok(id, "Codex did not report a thread ID.");
    return id;
  }
  const thread = await run(first, "Gateway fixture first conversation");
  const resumed = await run(first, "Gateway fixture continuation", thread);
  assert.equal(resumed, thread);
  const independent = await run(first, "Gateway fixture second conversation");
  assert.notEqual(independent, thread);
  await run(second, "Gateway fixture on another device");
  const snapshot = async (session?: string) => {
    const url = new URL("/api/workspace", gateway);
    if (session) url.searchParams.set("session", session);
    const response = await fetch(url, { headers: { Authorization: "Bearer " + key }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200);
    return await response.json() as Snapshot;
  };
  const fresh = await snapshot();
  const a = fresh.sessions.filter(({ gateway }) => gateway?.machineLabel === identities[0]);
  const b = fresh.sessions.filter(({ gateway }) => gateway?.machineLabel === identities[1]);
  assert.deepEqual([a.length, b.length], [2, 1], `Observed client headers: ${[...names].join(", ")}`);
  assert.ok(a.every((s) => s.gateway?.client === "Codex" && s.gateway?.correlation === "explicit"));
  const counts = (await Promise.all(a.map(async ({ id }) => (await snapshot(id)).nodes.filter(({ kind }) => kind === "run").length))).sort();
  assert.deepEqual(counts, [1, 2]);
  assert.equal(modelRequests, 4);
  const result = { version, machineCounts: [2, 1], firstMachineTreeRequests: counts, observedHeaderNames: [...names].sort(), modelRequests };
  await mkdir(qa, { recursive: true });
  await writeFile(join(qa, "native-codex.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} finally {
  proxy.close();
  proxy.closeAllConnections();
  assert.equal(dirname(resolve(fixture)), resolve(tmpdir()));
  assert.ok(basename(fixture).startsWith("wb2-session-codex-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
}
