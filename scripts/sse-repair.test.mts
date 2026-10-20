// sse-repair.test.mts — 流式管线（sse.ts streamPassthrough + MarkupRepair）集成测试。
import assert from "node:assert/strict";
import { streamPassthrough } from "file:///C:/Users/16321/Downloads/workbuddy2api-panel-main/wb2api-next/src/lib/upstream/sse.ts";
import { MarkupRepair } from "file:///C:/Users/16321/Downloads/workbuddy2api-panel-main/wb2api-next/src/lib/upstream/dsml.ts";

type Obj = Record<string, unknown>;
const PIPE = "｜｜";
const markupOpen = "<" + PIPE + "DSML" + PIPE + " calls>";
const markupClose = "</" + PIPE + "DSML" + PIPE + " calls>";
const markupInvokeClose = "</" + PIPE + "DSML" + PIPE + " invoke>";
const markupParamClose = "</" + PIPE + "DSML" + PIPE + " parameter>";
function mkParam(name: string, value: string): string {
  return "<" + PIPE + "DSML" + PIPE + ' parameter name="' + name + '" string="true">' + value + markupParamClose;
}
function mkInvoke(name: string, ...params: string[]): string {
  const body = params.length > 0 ? "\n" + params.join("\n") + "\n" : "";
  return "<" + PIPE + "DSML" + PIPE + ' invoke name="' + name + '">' + body + markupInvokeClose;
}
function mkBlock(...invokes: string[]): string {
  return markupOpen + "\n" + invokes.join("\n") + "\n" + markupClose;
}

function chunk(content: string, finish: string | null): string {
  const c: Obj = { index: 0, delta: content ? { content } : {} };
  if (finish !== null) c.finish_reason = finish;
  return "data: " + JSON.stringify({ object: "chat.completion.chunk", model: "m", created: 1, choices: [c] }) + "\n\n";
}

async function run(sseText: string, repair: MarkupRepair | null): Promise<{ frames: Obj[]; raw: string }> {
  const enc = new TextEncoder();
  const upstream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      ctrl.enqueue(enc.encode(sseText));
      ctrl.close();
    },
  });
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const p = streamPassthrough(upstream, writable, repair);
  const buf: Uint8Array[] = [];
  const rd = readable.getReader();
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    buf.push(value!);
  }
  await p;
  const raw = new TextDecoder().decode(
    buf.reduce((a, b) => { const r = new Uint8Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; }, new Uint8Array(0)),
  );
  const frames: Obj[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("data: ") && !line.startsWith("data: [DONE]")) {
      frames.push(JSON.parse(line.slice(6)) as Obj);
    }
  }
  return { frames, raw };
}

let n = 0;
function t(name: string, fn: () => Promise<void>) {
  return fn().then(() => { n++; console.log("PASS " + name); });
}

// 1. content 帧里嵌标记块 + stop 收尾：还原 tool_calls 帧 + finish 改写 tool_calls。
await t("StreamMarkupToToolCalls", async () => {
  const block = mkBlock(mkInvoke("exec_command", mkParam("cmd", "ls")));
  const sse = chunk("先看一眼。", null) + chunk(block, null) + chunk("", "stop") + "data: [DONE]\n\n";
  const { frames } = await run(sse, new MarkupRepair(new Set(["exec_command"]), true));
  const tcFrames = frames.filter((f) => {
    const ch = (f["choices"] as Obj[])[0];
    return Array.isArray((ch["delta"] as Obj)?.["tool_calls"]);
  });
  assert.equal(tcFrames.length, 1);
  const tc = ((tcFrames[0]["choices"] as Obj[])[0]["delta"] as Obj)["tool_calls"] as Obj[];
  assert.equal((tc[0]["function"] as Obj)["name"], "exec_command");
  assert.equal((tc[0]["function"] as Obj)["arguments"], '{"cmd":"ls"}');
  const finishes = frames.map((f) => (f["choices"] as Obj[])[0]["finish_reason"]).filter(Boolean);
  assert.deepEqual(finishes, ["tool_calls"]);
  const firstContent = ((frames[0]["choices"] as Obj[])[0]["delta"] as Obj)["content"];
  assert.equal(firstContent, "先看一眼。");
});

// 2. 标记被切成两个增量（跨帧截断）：起始标记被切断也必须还原。
await t("StreamCrossFrameSplit", async () => {
  const block = mkBlock(mkInvoke("exec_command", mkParam("cmd", "pwd")));
  const cut = Math.floor(markupOpen.length / 2) + 3; // 切在标记中段
  const sse = chunk(block.slice(0, cut), null) + chunk(block.slice(cut), null) + chunk("", "stop") + "data: [DONE]\n\n";
  const { frames, raw } = await run(sse, new MarkupRepair(new Set(["exec_command"]), true));
  const tcFrames = frames.filter((f) => Array.isArray((((f["choices"] as Obj[])[0]["delta"] as Obj) || {})["tool_calls"]));
  assert.equal(tcFrames.length, 1);
  assert.ok(!raw.includes(PIPE), "输出仍残留标记");
});

// 3. 无 repair（null）：标记原文透传（回归——关闭修复时管线不变）。
await t("StreamNoRepairPassthrough", async () => {
  const block = mkBlock(mkInvoke("exec_command", mkParam("cmd", "pwd")));
  const sse = chunk(block, null) + chunk("", "stop") + "data: [DONE]\n\n";
  const { frames } = await run(sse, null);
  const contents = frames
    .map((f) => ((f["choices"] as Obj[])[0]["delta"] as Obj)?.["content"])
    .filter((v) => typeof v === "string");
  assert.equal(contents.join(""), block);
  const finishes = frames.map((f) => (f["choices"] as Obj[])[0]["finish_reason"]).filter(Boolean);
  assert.deepEqual(finishes, ["stop"]);
});

// 4. 未闭合块 + 流结束：flush 回吐原文，绝不吞字节。
await t("StreamUnclosedBlockFlushes", async () => {
  const partial = markupOpen + "\n" + mkInvoke("exec_command", mkParam("cmd", "pwd"));
  const sse = chunk("前缀。" + partial, null) + "data: [DONE]\n\n";
  const { raw } = await run(sse, new MarkupRepair(new Set(["exec_command"]), true));
  assert.ok(raw.includes(PIPE), "未闭合块应回吐标记原文");
});

// 5. 还原过调用但上游没给收尾帧：流尾补 finish_reason: tool_calls。
await t("StreamSynthFinishFrame", async () => {
  const block = mkBlock(mkInvoke("exec_command", mkParam("cmd", "pwd")));
  const sse = chunk(block, null) + "data: [DONE]\n\n";
  const { frames } = await run(sse, new MarkupRepair(new Set(["exec_command"]), true));
  const finishes = frames.map((f) => (f["choices"] as Obj[])[0]["finish_reason"]).filter(Boolean);
  assert.deepEqual(finishes, ["tool_calls"]);
});

// 6. 上游已发真实 tool_calls（index 0）+ 标记块泄漏：合成 index 接续不撞车。
await t("StreamSynthIndexContinues", async () => {
  const realTC = "data: " + JSON.stringify({
    object: "chat.completion.chunk", model: "m", created: 1,
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_real", type: "function", function: { name: "exec_command", arguments: "{}" } }] } }],
  }) + "\n\n";
  const block = mkBlock(mkInvoke("exec_command", mkParam("cmd", "pwd")));
  const sse = realTC + chunk(block, null) + chunk("", "stop") + "data: [DONE]\n\n";
  const { frames } = await run(sse, new MarkupRepair(new Set(["exec_command"]), true));
  const idxs: number[] = [];
  for (const f of frames) {
    const tcs = (((f["choices"] as Obj[])[0]["delta"] as Obj) || {})["tool_calls"];
    if (Array.isArray(tcs)) for (const tc of tcs) idxs.push((tc as Obj)["index"] as number);
  }
  assert.deepEqual(idxs.sort(), [0, 1]);
});

console.log("\n" + n + " 项流式修复集成测试全部 PASS");