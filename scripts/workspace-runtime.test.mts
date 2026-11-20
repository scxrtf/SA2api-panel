import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { WorkspaceStore } from "../src/lib/workspace/store";
import { Bridge } from "../workers/workspace/bridge";
import { codexRun, findCodex } from "../workers/workspace/codex";
import { collectFiles, git, worktree } from "../workers/workspace/files";
import { integrateArtifact } from "../src/lib/workspace/integration";
import { forwardResponses } from "../src/lib/responses-gateway";
const hasSqlite = !!process.getBuiltinModule?.("node:sqlite");
const hasPi = existsSync(new URL("../workers/workspace/node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url));

async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "wb-workspace-test-"));
  return { path, async remove() {
    assert.equal(dirname(resolve(path)), resolve(tmpdir()));
    assert.ok(basename(path).startsWith("wb-workspace-test-"));
    await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  } };
}
type Body = Record<string, unknown>;
async function mock(onRequest: (req: IncomingMessage, res: ServerResponse, body: Body) => void) {
  const seen: Body[] = [];
  let failure: unknown;
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Body;
      seen.push(body);
      onRequest(req, res, body);
    } catch (error) { failure = error; res.writeHead(500).end(); }
  });
  server.listen(0, "127.0.0.1");
  await new Promise<void>((done) => server.once("listening", done));
  const port = (server.address() as { port: number }).port;
  return { seen, url: `http://127.0.0.1:${port}/v1`, check: () => assert.equal(failure, undefined),
    close: () => new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }) };
}
function set(input: Record<string, string>) {
  const old = Object.fromEntries(Object.keys(input).map((key) => [key, process.env[key]]));
  Object.assign(process.env, input);
  return () => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };
}

test("Pi SDK makes a real streaming tool round-trip and writes workbench events", { timeout: 55_000, skip: !hasSqlite || !hasPi }, async () => {
  const { piRun } = await import("../workers/workspace/pi");
  const dir = await temporary();
  const repo = join(dir.path, "source");
  await mkdir(repo);
  await writeFile(join(repo, "README.md"), "Pi fixture payload");
  const endpoint = await mock((req, res, body) => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer pi-fixture-local");
    const roundTrip = (body.messages as { role: string; content: string }[]).some((message) => message.role === "tool" && /Pi fixture payload/.test(message.content));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: Body, reason: string | null) => res.write("data: " + JSON.stringify({
      id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: "workspace-test-model",
      choices: [{ index: 0, delta, finish_reason: reason }],
    }) + "\n\n");
    if (roundTrip) { chunk({ role: "assistant", content: "Pi 读取并核对了测试文件。" }, null); chunk({}, "stop"); }
    else {
      chunk({ role: "assistant", tool_calls: [{
        index: 0, id: "call_fixture", type: "function", function: { name: "workspace_read", arguments: '{"path":"README.md"}' },
      }] }, null);
      chunk({}, "tool_calls");
    }
    res.end("data: [DONE]\n\n");
  });
  const restore = set({
    WB2_WORKSPACE_PI_MODEL: "workspace-test-model", WB2_WORKSPACE_GATEWAY_KEY: "pi-fixture-local",
    WB2_WORKSPACE_GATEWAY_URL: endpoint.url, WB2_WORKSPACE_DATA_DIR: dir.path,
  });
  const store = new WorkspaceStore(join(dir.path, "trace.sqlite"));
  try {
    store.heartbeat({ at: Date.now(), pi: true, codex: false });
    const run = store.send({ key: "pi", engine: "pi", mode: "single", prompt: "read README.md" });
    const ticket = store.claim("pi-test", ["pi"], 1)!;
    store.setSessionRuntime(ticket, { cwd: repo });
    const session = store.session(run.sessionId)!;
    const bridge = new Bridge(store, ticket, session);
    const result = await piRun(bridge, session, "Read README.md via the project tool.", AbortSignal.timeout(35000));
    endpoint.check();
    assert.match(result.text, /Pi 读取/);
    assert.equal(endpoint.seen.length, 2);
    assert.ok(store.snapshot().activities.some((event) => event.kind === "tool" && event.status === "completed" && event.text === "README.md"));
    assert.ok(store.session(run.sessionId)?.engineRef?.endsWith(".jsonl"));
  } finally { store.close(); restore(); await endpoint.close(); await dir.remove(); }
});

test("Responses proxy retains function items, full replay input, and SSE framing", { timeout: 15_000 }, async () => {
  const endpoint = await mock((req, res, body) => {
    assert.equal(req.url, "/v1/responses");
    assert.equal(req.headers.authorization, "Bearer native-fixture");
    assert.equal(req.headers["x-not-forwarded"], undefined);
    assert.deepEqual(body.input, [{ type: "function_call_output", call_id: "call_fixture", output: "OK" }]);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_next"}}\n\n');
    res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  const restore = set({
    WB2A_API_KEY: "gateway-main-fixture", WB2A_RESPONSES_UPSTREAM: endpoint.url, WB2A_RESPONSES_KEY: "native-fixture",
    WB2A_RESPONSES_MODELS: "workspace-native", USE_CLOUDBASE_REST: "0",
    DATABASE_URL: "postgresql://nobody:unused@127.0.0.1:1/test?connect_timeout=1",
  });
  try {
    const request = new Request("http://localhost/api/v1/responses", {
      method: "POST", headers: { Authorization: "Bearer gateway-main-fixture", "X-Not-Forwarded": "private" },
      body: JSON.stringify({ model: "workspace-native", stream: true, input: [{ type: "function_call_output", call_id: "call_fixture", output: "OK" }] }),
    });
    const response = await forwardResponses(request, "responses");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Accel-Buffering"), "no");
    assert.match(await response.text(), /call_next.*response\.completed/s);
    endpoint.check();
  } finally { restore(); await endpoint.close(); }
});

test("installed Codex App Server emits a real thread, turn and reply using a loopback Responses fixture",
  { skip: !hasSqlite || process.env.WB2_WORKSPACE_TEST_CODEX !== "1", timeout: 45_000 }, async () => {
    const binary = findCodex();
    assert.ok(binary, "Codex CLI not found");
    const dir = await temporary();
    const codexHome = join(dir.path, "codex");
    const cwd = join(dir.path, "source");
    await mkdir(codexHome); await mkdir(cwd);
    const endpoint = await mock((req, res, body) => {
      assert.equal(req.url, "/v1/responses");
      assert.equal(req.headers.authorization, "Bearer codex-fixture");
      assert.equal(body.stream, true);
      const finalText = "Codex 工作区离线联调成功。";
      const item = { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: finalText, annotations: [] }] };
      const response = { id: "resp_test", object: "response", model: "gpt-5.4", created_at: 1, status: "completed", output: [item], usage: {
        input_tokens: 10, output_tokens: 8, total_tokens: 18, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
      } };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let index = 0;
      const write = (type: string, fields: Body) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: index++, ...fields })}\n\n`);
      write("response.created", { response: { ...response, status: "in_progress", output: [] } });
      write("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
      write("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: finalText });
      write("response.output_item.done", { output_index: 0, item });
      write("response.completed", { response });
      res.end();
    });
    await writeFile(join(codexHome, "config.toml"), [
      'model = "gpt-5.4"', 'model_provider = "fixture"', '[model_providers.fixture]', 'name = "Loopback fixture"',
      `base_url = "${endpoint.url}"`, 'env_key = "WB2_WORKSPACE_CODEX_API_KEY"', 'wire_api = "responses"',
      'requires_openai_auth = false', 'supports_websockets = false', '[analytics]', 'enabled = false', '',
    ].join("\n"));
    const restore = set({ WB2_WORKSPACE_CODEX_HOME: codexHome, WB2_WORKSPACE_CODEX_API_KEY: "codex-fixture",
      WB2_WORKSPACE_CODEX_MODEL: "gpt-5.4", WB2_WORKSPACE_DATA_DIR: dir.path });
    const store = new WorkspaceStore(join(dir.path, "trace.sqlite"));
    try {
      store.heartbeat({ at: Date.now(), pi: false, codex: true });
      const run = store.send({ key: "codex", engine: "codex", mode: "single", prompt: "say hello" });
      const ticket = store.claim("codex-test", ["codex"], 1)!;
      store.setSessionRuntime(ticket, { cwd });
      const session = store.session(run.sessionId)!;
      const bridge = new Bridge(store, ticket, session);
      const outcome = await codexRun(bridge, session, "Reply in one line.", AbortSignal.timeout(25000), binary);
      endpoint.check();
      assert.match(outcome.text, /Codex 工作区离线联调成功/);
      assert.ok(store.session(run.sessionId)?.engineRef);
      assert.ok(store.snapshot().nodes.some((node) => node.kind === "reply"));
    } finally { store.close(); restore(); await endpoint.close(); await dir.remove(); }
  });

test("real Git checkout isolates edits and only applies a verified patch to a new integration checkout", { timeout: 55_000, skip: !hasSqlite }, async () => {
  const dir = await temporary();
  const repo = join(dir.path, "project");
  await mkdir(repo);
  const restore = set({ WB2_WORKSPACE_ROOT: repo, WB2_WORKSPACE_DATA_DIR: join(dir.path, "data") });
  const store = new WorkspaceStore(":memory:");
  try {
    await git(repo, ["init", "--quiet"]);
    await git(repo, ["config", "--local", "core.autocrlf", "false"]);
    await writeFile(join(repo, "README.md"), "baseline\n");
    await git(repo, ["add", "--", "README.md"]);
    await git(repo, ["-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "--quiet", "-m", "initial"]);
    store.heartbeat({ at: Date.now(), pi: true, codex: true });
    const run = store.send({ key: "git", engine: "pi", mode: "single", prompt: "update docs" });
    const ticket = store.claim("git", ["pi"], 1)!;
    const session = store.session(run.sessionId)!;
    const checkout = await worktree(session);
    store.setSessionRuntime(ticket, checkout);
    await writeFile(join(repo, "README.md"), "unsaved user's changes\n");
    assert.equal(await readFile(join(checkout.cwd, "README.md"), "utf8"), "baseline\n");
    await writeFile(join(checkout.cwd, "README.md"), "assistant edit\n");
    await writeFile(join(checkout.cwd, "delivery.md"), "actual output");
    const patch = (await collectFiles(checkout.cwd, checkout.base)).find((file) => file.patch)!;
    assert.match(patch.bytes.toString(), /delivery\.md/);
    const bridge = new Bridge(store, ticket, session);
    const source = bridge.file(patch.name, patch.bytes, undefined, true)!;
    const conflict = bridge.file("changes.diff", Buffer.from("not a patch"), undefined, true)!;
    store.finish(ticket, "completed");
    const output = await integrateArtifact(store, source.id);
    assert.equal(await integrateArtifact(store, source.id), output);
    assert.match(await readFile(join(output, "README.md"), "utf8"), /assistant edit/);
    assert.equal(await readFile(join(output, "delivery.md"), "utf8"), "actual output");
    assert.equal(await readFile(join(repo, "README.md"), "utf8"), "unsaved user's changes\n");
    assert.ok(store.snapshot().nodes.some((node) => node.id === `integration:${source.id}`));
    await assert.rejects(() => integrateArtifact(store, conflict.id), /存在冲突/);
  } finally { store.close(); restore(); await dir.remove(); }
});
