import assert from "node:assert/strict";
import test from "node:test";
import { aggregate, streamPassthrough } from "../src/lib/upstream/sse.ts";
import { idleMonitorBody } from "../src/lib/upstream/idle.ts";
import { ProviderObservation } from "../src/lib/provider-observation.ts";

const encoder = new TextEncoder();
function frame(delta: Record<string, unknown>, finish?: string): string {
  return "data: " + JSON.stringify({ choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }] }) + "\n\n";
}
function source(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } });
}
async function passthrough(text: string) {
  let output = "";
  const stats = await streamPassthrough(source(text), new WritableStream({
    write(chunk) { output += new TextDecoder().decode(chunk); },
  }));
  return { stats, output };
}

test("池 SSE 提前 EOF 保留部分回复但不伪造成功结束", async () => {
  const { stats, output } = await passthrough(frame({ content: "partial" }));
  assert.equal(stats.assistantContent, "partial");
  assert.equal(JSON.parse(stats.errorFrame).error.code, "upstream_stream_incomplete");
  assert.ok(output.includes("partial"));
  assert.ok(output.endsWith("data: [DONE]\n\n"));
});

test("有 finish_reason 而无 DONE 的兼容流仍正常完成", async () => {
  const { stats, output } = await passthrough(frame({ content: "complete" }, "stop"));
  assert.equal(stats.errorFrame, "");
  assert.equal(stats.finishReason, "stop");
  assert.ok(output.endsWith("data: [DONE]\n\n"));
});

test("空闲超时造成的 EOF 不会记成池通道成功", async (t) => {
  let cancelled = false;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const input = new ReadableStream<Uint8Array>({
    start(c) { controller = c; c.enqueue(encoder.encode(frame({ content: "partial" }))); },
    cancel() { cancelled = true; },
  });
  const fallback = setTimeout(() => { if (!cancelled) controller.close(); }, 250);
  t.after(() => clearTimeout(fallback));
  const stats = await streamPassthrough(idleMonitorBody(input, 15), new WritableStream({ write() {} }));
  assert.equal(cancelled, true);
  assert.equal(JSON.parse(stats.errorFrame).error.code, "upstream_stream_incomplete");
});

test("池 SSE 非法/负/非整数/超界工具索引返回可观测协议错误且不扩张数组", async () => {
  for (const index of [1024, -1, 1.5, "0", null, 1_000_000_000]) {
    const { stats, output } = await passthrough(frame({ tool_calls: [{ index, function: { name: "tool", arguments: "{}" } }] }) + "data: [DONE]\n\n");
    assert.equal(JSON.parse(stats.errorFrame).error.code, "upstream_invalid_tool_index");
    assert.equal(stats.assistantToolCalls.length, 0);
    assert.ok(output.includes("upstream_invalid_tool_index"));
  }
});

test("最高合法工具索引 1023 仍受支持", async () => {
  const { stats } = await passthrough(frame({ tool_calls: [{ index: 1023, function: { name: "tool", arguments: "{}" } }] }, "tool_calls") + "data: [DONE]\n\n");
  assert.equal(stats.errorFrame, "");
  assert.equal(stats.assistantToolCalls.length, 1024);
});

test("非流式聚合对极大工具索引立即失败并取消上游", async () => {
  let cancelled = false;
  const input = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode(frame({ tool_calls: [{ index: 1_000_000_000 }] }))); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(aggregate(input), /invalid tool_call index/);
  assert.equal(cancelled, true);
});

test("供应商观测对非法索引/过量调用明确记失败，不分配无界数组", () => {
  for (const index of [1024, -1, 1.5, "0", null, 1_000_000_000]) {
    const stats = new ProviderObservation(Date.now());
    stats.json({ choices: [{ delta: { tool_calls: [{ index, function: { name: "tool", arguments: "{}" } }] } }] });
    assert.equal(stats.errKind, "provider_invalid_tool_index");
    assert.equal(stats.responseToolCalls.length, 0);
    assert.ok(stats.errorBody.includes("invalid tool_call index"));
  }
  const message = new ProviderObservation(Date.now());
  message.json({ choices: [{ message: { tool_calls: Array.from({ length: 1025 }, () => ({})) } }] });
  assert.equal(message.errKind, "provider_invalid_tool_index");
  assert.equal(message.responseToolCalls.length, 1024);
});

test("非流式聚合提前 EOF 同样失败，有 finish_reason 时保持兼容", async () => {
  await assert.rejects(aggregate(source(frame({ content: "partial" }))), /stream ended before/);
  const { resp } = await aggregate(source(frame({ content: "complete" }, "stop")));
  assert.equal((resp.choices as { message: { content: string } }[])[0].message.content, "complete");
});
