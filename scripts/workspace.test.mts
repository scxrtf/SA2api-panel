import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceStore } from "../src/lib/workspace/store";
import { applyEvent, blankSnapshot, runNode } from "../src/lib/workspace/contracts";
import { Bridge } from "../workers/workspace/bridge";
import { codexEvents } from "../workers/workspace/codex";
import { safeRelative } from "../workers/workspace/files";
import { responsesEndpoint } from "../src/lib/responses-gateway";
const hasSqlite = !!process.getBuiltinModule?.("node:sqlite");

function setup() {
  const store = new WorkspaceStore(":memory:");
  store.heartbeat({ at: Date.now(), codex: true, pi: true });
  return store;
}

test("Pi and Codex claim two branches, persist artifacts, and schedule exactly one parent join", { skip: !hasSqlite }, () => {
  const store = setup();
  try {
    const request = { key: "once", engine: "pi", mode: "mixed", prompt: "release notes" } as const;
    const parent = store.send(request);
    assert.equal(store.send(request).id, parent.id);
    assert.throws(() => store.send({ ...request, prompt: "different" }), /同一请求标识/);
    const first = store.claim("a", ["pi", "codex"], 2)!;
    const second = store.claim("b", ["pi", "codex"], 2)!;
    assert.equal(store.claim("c", ["pi", "codex"], 2), undefined);
    assert.deepEqual([first, second].map(({ job }) => store.session(job.sessionId)!.engine), ["pi", "codex"]);
    for (const [ticket, text] of [[first, "implemented"], [second, "reviewed"]] as const) {
      const bridge = new Bridge(store, ticket, store.session(ticket.job.sessionId)!);
      bridge.replyDelta("first", text.slice(0, 4));
      bridge.reply("first", text);
      const result = bridge.result();
      const artifact = bridge.file("summary.md", Buffer.from(text), result.outputId)!;
      assert.equal(store.artifact(artifact.id)?.bytes.toString(), text);
      assert.equal(artifact.sha256.length, 64);
      assert.equal(store.finish(ticket, "completed", result.text), true);
      assert.equal(store.finish(ticket, "completed", "duplicate"), false);
    }
    const joined = store.claim("a", ["pi", "codex"], 2)!;
    assert.equal(joined.job.id, parent.id);
    assert.equal(joined.job.phase, "join");
    assert.match(joined.job.context ?? "", /implemented.*reviewed/s);
    assert.equal(store.deliveryFor(joined).length, 2);
    const snapshot = store.snapshot();
    assert.equal(snapshot.nodes.find((node) => node.kind === "merge")?.parents.length, 2);
    assert.equal(store.events(0, 500).reduce(applyEvent, blankSnapshot()).nodes.length, snapshot.nodes.length);
    assert.equal(store.events(snapshot.cursor).length, 0);
  } finally { store.close(); }
});

test("Codex notification projection links native child, commands, final reply, and beacons", { skip: !hasSqlite }, () => {
  const store = setup();
  try {
    const run = store.send({ key: "x", engine: "codex", mode: "single", prompt: "check docs" });
    const ticket = store.claim("w", ["codex"], 2)!;
    const bridge = new Bridge(store, ticket, store.session(run.sessionId)!);
    const on = codexEvents(bridge, () => "root_thread");
    on("item/completed", { threadId: "child_thread", item: { type: "agentMessage", id: "child-message", text: "子代理输出" } });
    on("item/completed", { threadId: "root_thread", item: { type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed", receiverThreadIds: ["child_thread"] } });
    on("item/started", { threadId: "root_thread", item: { type: "commandExecution", id: "tool1" } });
    on("item/completed", { threadId: "root_thread", item: { type: "commandExecution", id: "tool1", exitCode: 0, status: "completed" } });
    on("item/agentMessage/delta", { threadId: "root_thread", itemId: "reply", delta: "结果" });
    on("item/completed", { threadId: "root_thread", item: { type: "agentMessage", id: "reply", text: "结果已汇总" } });
    const snap = store.snapshot();
    const child = snap.sessions.find((session) => session.parentId === run.sessionId)!;
    assert.equal(child.engine, "codex");
    assert.ok(snap.activities.some((entry) => entry.sessionId === child.id && entry.text === "子代理输出"));
    assert.ok(snap.activities.some((entry) => entry.text === "退出码 0" && entry.status === "completed"));
    assert.equal(bridge.result().text, "结果已汇总");
    const events = store.events(0);
    assert.ok(events.some((event) => event.beacon?.nodeId === runNode(run.id)));
    assert.ok(events.some((event) => event.beacon?.fromId === bridge.result().outputId));
  } finally { store.close(); }
});

test("stopping a parent cancels queued children and waits for an active lease", { skip: !hasSqlite }, () => {
  const store = setup();
  try {
    const root = store.send({ key: "p", engine: "pi", mode: "parallel", prompt: "one test" });
    const child = store.claim("a", ["pi"], 1)!;
    assert.equal(store.stop(root.id).status, "stopping");
    assert.equal(store.renew(child), "stopping");
    assert.equal(store.finish(child, "completed"), true);
    assert.equal(store.job(child.job.id)?.status, "cancelled");
    assert.equal(store.job(root.id)?.status, "cancelled");
    assert.equal(store.claim("b", ["pi"], 1), undefined);
    assert.ok(store.retry("retry", root.id).retryOf);
  } finally { store.close(); }
});

test("fork context stops at selected durable node and replay omits future input", { skip: !hasSqlite }, () => {
  const store = setup();
  try {
    const first = store.send({ key: "first", engine: "pi", mode: "single", prompt: "original" });
    const ticket = store.claim("w", ["pi"], 2)!;
    const bridge = new Bridge(store, ticket, store.session(first.sessionId)!);
    bridge.reply("one", "checkpoint");
    const node = bridge.result().outputId!;
    bridge.reply("two", "later output");
    store.finish(ticket, "completed");
    store.send({ key: "follow", sessionId: first.sessionId, engine: "pi", mode: "single", prompt: "later prompt" });
    const fork = store.send({ key: "fork", sessionId: first.sessionId, forkNodeId: node, engine: "codex", mode: "single", prompt: "branch" });
    assert.match(store.job(fork.id)?.context ?? "", /original.*checkpoint/s);
    assert.doesNotMatch(store.job(fork.id)?.context ?? "", /later/);
    assert.ok(store.snapshot().nodes.some((entry) => entry.kind === "fork" && entry.parents.includes(node)));
  } finally { store.close(); }
});

test("filesystem and native Responses addresses are scoped before use", () => {
  for (const path of ["../outside", ".git/config", ".env.local", "C:/root", "docs/prn.txt", "file.txt:ads", "docs/a.", "dirs\\..\\secret"]) assert.equal(safeRelative(path), false, path);
  assert.equal(safeRelative("docs/安装说明.md"), true);
  assert.equal(responsesEndpoint("https://example.test/v1", "responses").href, "https://example.test/v1/responses");
  assert.equal(responsesEndpoint("https://example.test/api/v1/responses", "compact").pathname, "/api/v1/responses/compact");
  assert.throws(() => responsesEndpoint("http://external.test/v1", "responses"));
  assert.throws(() => responsesEndpoint("https://key@example.test/v1", "responses"));
});
