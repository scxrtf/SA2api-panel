import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { gatewayInput, observeGateway } from "../src/lib/workspace/gateway-observer";
import { gatewayStore, WorkspaceStore } from "../src/lib/workspace/store";

const hasSqlite = !!process.getBuiltinModule?.("node:sqlite");
const source = (machine: string, thread?: string, parent?: string) => {
  const headers = new Headers({ "User-Agent": "Codex Desktop", "X-WB2A-Machine-Id": machine });
  if (thread) headers.set("X-WB2A-Session-Id", thread);
  if (parent) headers.set("X-WB2A-Parent-Session-Id", parent);
  return new Request("http://localhost/api/v1/responses", { method: "POST", headers });
};
const identity = { name: "fixture-key" };
const input = { model: "fixture-model", input: [{ role: "user", content: "same initial input" }] };
const describe = (machine: string, thread?: string, parent?: string) =>
  gatewayInput(source(machine, thread, parent), input, "responses", identity).input;

test("explicit sessions and child branches are scoped to the requesting device, never scheduled", { skip: !hasSqlite }, () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const a = store.beginGateway(describe("laptop-a", "session-1"));
    const b = store.beginGateway(describe("laptop-b", "session-1"));
    const again = store.beginGateway(describe("laptop-a", "session-1"));
    const child = store.beginGateway(describe("laptop-a", "child-1", "session-1"));
    assert.notEqual(a.sessionId, b.sessionId);
    assert.equal(a.sessionId, again.sessionId);
    assert.equal(store.session(child.sessionId)?.rootId, a.sessionId);
    const snapshot = store.gatewaySnapshot(a.sessionId);
    assert.ok(snapshot.nodes.some((node) => node.sessionId === child.sessionId && node.kind === "fork"));
    assert.ok(snapshot.nodes.every((node) => node.sessionId !== b.sessionId));
    assert.equal(store.claim("worker", ["codex"], 4), undefined);
  } finally { store.close(); }
});

test("Codex native thread-id takes precedence over the common session-id", { skip: !hasSqlite }, () => {
  const store = new WorkspaceStore(":memory:");
  try {
    const native = (thread: string) => gatewayInput(new Request("http://localhost/api/v1/responses", {
      headers: { "User-Agent": "codex_exec/0.170.0", "X-WB2A-Machine-Id": "codex-native-desk", "thread-id": thread, "session-id": "shared-id" },
    }), input, "responses", identity).input;
    const first = store.beginGateway(native("thread-a"));
    assert.equal(store.beginGateway(native("thread-a")).sessionId, first.sessionId);
    assert.notEqual(store.beginGateway(native("thread-b")).sessionId, first.sessionId);
    assert.equal(store.session(first.sessionId)?.gateway?.correlation, "explicit");
  } finally { store.close(); }
});

function stream(raw: string) {
  const bytes = new TextEncoder().encode(raw);
  return new Response(new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 13) controller.enqueue(bytes.slice(offset, offset + 13));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream", "X-Request-Id": "upstream-1" } });
}
async function fixture(t: { after: (cleanup: () => Promise<void> | void) => void }, storeText = false) {
  const dir = await mkdtemp(join(tmpdir(), "wb-gateway-trace-"));
  const env = { WB2_WORKSPACE_ENABLED: "1", WB2_WORKSPACE_CAPTURE: "1", WB2_WORKSPACE_TRACE_TEXT: storeText ? "1" : "0", WB2_WORKSPACE_DATA_DIR: dir };
  const before = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  const store = gatewayStore();
  t.after(async () => {
    store.close();
    for (const [key, value] of Object.entries(before)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("wb-gateway-trace-"));
    await rm(dir, { recursive: true, force: true });
  });
  return store;
}

test("native SSE bytes and headers pass unchanged; response and tool results link only within their machine", { skip: !hasSqlite }, async (t) => {
  const store = await fixture(t);
  const raw = [
    'event: response.created\r\ndata: {"type":"response.created","response":{"id":"resp-a"}}\r\n\r\n',
    'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call-read","name":"read_file","arguments":"SECRET-ARGS"}}\n\n',
    'data: {"type":"response.output_text.delta","delta":"私有正文"}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp-a","output":[]}}\n\n',
  ].join("");
  const early = await observeGateway(source("device-a"), input, "responses", identity, async () => stream(raw));
  assert.equal(early.headers.get("x-request-id"), "upstream-1");
  assert.equal(await early.text(), raw);
  const initial = store.gatewaySnapshot();
  assert.ok(initial.nodes.some((node) => node.label === "模型请求工具：read_file"));
  assert.doesNotMatch(JSON.stringify(initial), /私有正文|SECRET-ARGS|same initial input/);
  const first = initial.sessions[0].id;
  const follow = { model: input.model, previous_response_id: "resp-a", input: [{ type: "function_call_output", call_id: "call-read", output: "not stored" }] };
  for (const machine of ["device-a", "device-b"]) {
    const next = await observeGateway(source(machine), follow, "responses", identity, async () => Response.json({ id: `resp-${machine}`, output: [] }));
    await next.text();
  }
  const final = store.gatewaySnapshot(first);
  assert.equal(final.sessions.length, 2);
  assert.equal(final.sessions.find((session) => session.id === first)?.gateway?.correlation, "response");
  assert.equal(final.nodes.filter((node) => node.kind === "run").length, 2);
  assert.ok(final.nodes.some((node) => node.label === "工具结果：read_file" && node.parents.length === 2));
});

test("text replay links a verified preceding reply; equal initial prompts are distinct", { skip: !hasSqlite }, async (t) => {
  const store = await fixture(t, true);
  const user = { role: "user", content: "hello" };
  const send = async (messages: unknown[], answer: string) => {
    const result = await observeGateway(source("history-laptop"), { model: "fixture-model", messages }, "chat", identity,
      async () => Response.json({ choices: [{ message: { role: "assistant", content: answer } }] }));
    await result.text();
  };
  await send([user], "first reply");
  const first = store.gatewaySnapshot().sessions[0].id;
  await send([user], "different reply");
  assert.equal(store.gatewaySnapshot().sessions.length, 2);
  await send([user, { role: "assistant", content: "first reply" }, { role: "user", content: "follow-up" }], "second reply");
  const snapshot = store.gatewaySnapshot(first);
  assert.equal(snapshot.sessions.length, 2);
  assert.equal(snapshot.sessions.find((session) => session.id === first)?.gateway?.correlation, "history");
  assert.ok(snapshot.activities.some((entry) => entry.text === "follow-up"));
});

test("missing terminal SSE event does not falsely complete a request", { skip: !hasSqlite }, async (t) => {
  const store = await fixture(t);
  const response = await observeGateway(source("aborted-device"), input, "responses", identity,
    async () => stream('data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: [DONE]\n\n'));
  await response.text();
  assert.equal(store.gatewaySnapshot().sessions[0].gateway?.lastStatus, "interrupted");
});
