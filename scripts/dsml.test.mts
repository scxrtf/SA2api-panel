// dsml.test.mts — 对齐 Go dsml_test.go 场景的 TS 等价测试。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MarkupRepair,
  toolNameAllowlist,
  repairAggregatedResponse,
  markupToolCalls,
} from "file:///C:/Users/16321/Downloads/workbuddy2api-panel-main/wb2api-next/src/lib/upstream/dsml.ts";

type Obj = Record<string, unknown>;
const PIPE = "｜｜"; // U+FF5C ×2
const markupOpen = "<" + PIPE + "DSML" + PIPE + " calls>";
const markupClose = "</" + PIPE + "DSML" + PIPE + " calls>";
const markupInvokeClose = "</" + PIPE + "DSML" + PIPE + " invoke>";
const markupParamClose = "</" + PIPE + "DSML" + PIPE + " parameter>";

function mkParam(name: string, value: string): string {
  return "<" + PIPE + "DSML" + PIPE + ' parameter name="' + name + '" string="true">' + value + markupParamClose;
}
function mkJSONParam(name: string, raw: string): string {
  return "<" + PIPE + "DSML" + PIPE + ' parameter name="' + name + '">' + raw + markupParamClose;
}
function mkInvoke(name: string, ...params: string[]): string {
  const body = params.length > 0 ? "\n" + params.join("\n") + "\n" : "";
  return "<" + PIPE + "DSML" + PIPE + ' invoke name="' + name + '">' + body + markupInvokeClose;
}
function mkBlock(...invokes: string[]): string {
  return markupOpen + "\n" + invokes.join("\n") + "\n" + markupClose;
}
function repairAll(allowed: Set<string> | null, chunks: string[]) {
  const r = new MarkupRepair(allowed, false);
  let out = "";
  const calls: { name: string; arguments: string }[] = [];
  for (const c of chunks) {
    const res = r.feed(c);
    out += res.emit;
    calls.push(...res.calls);
  }
  out += r.flush();
  return { out, calls };
}
function argsOf(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}
const testTools = new Set(["exec_command", "write_stdin"]);
let n = 0;
function t(name: string, fn: () => void) {
  fn();
  n++;
  console.log("PASS " + name);
}

// --- 基本解析 ---
t("SingleCall", () => {
  const input = mkBlock(mkInvoke("exec_command", mkParam("cmd", "ls -la /tmp")));
  const { out, calls } = repairAll(testTools, [input]);
  assert.equal(out, "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "exec_command");
  assert.equal(argsOf(calls[0].arguments)["cmd"], "ls -la /tmp");
});

t("MultipleCallsAndOrder", () => {
  const input = mkBlock(
    mkInvoke("exec_command", mkParam("cmd", "pwd")),
    mkInvoke("write_stdin", mkParam("session_id", "s1"), mkParam("chars", "y\n")),
  );
  const { out, calls } = repairAll(testTools, [input]);
  assert.equal(out, "");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "exec_command");
  assert.equal(calls[1].name, "write_stdin");
  assert.equal(argsOf(calls[1].arguments)["chars"], "y\n");
});

t("KeepsSurroundingProse", () => {
  const head = "先摸清接口清单，再落文档。\n\n";
  const tail = "\n\n以上是第一批调用。";
  const input = head + mkBlock(mkInvoke("exec_command", mkParam("cmd", "pwd"))) + tail;
  const { out, calls } = repairAll(testTools, [input]);
  assert.equal(calls.length, 1);
  assert.equal(out, head + tail);
});

t("NoParameters", () => {
  const { calls } = repairAll(testTools, [mkBlock(mkInvoke("exec_command"))]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments, "{}");
});

t("StringParamEscaping", () => {
  const value = "cd /tmp && apply_patch <<'PATCH'\n*** Begin Patch\n+  const s = \"a\\\\b\";\n+  // 中文注释\n*** End Patch\nPATCH";
  const input = mkBlock(mkInvoke("exec_command", mkParam("cmd", value)));
  const { calls } = repairAll(testTools, [input]);
  assert.equal(calls.length, 1);
  assert.equal(argsOf(calls[0].arguments)["cmd"], value);
});

t("JSONParam", () => {
  const input = mkBlock(mkInvoke("exec_command", mkJSONParam("opts", '{"timeout":30,"force":true}')));
  const { calls } = repairAll(testTools, [input]);
  assert.equal(calls.length, 1);
  const opts = argsOf(calls[0].arguments)["opts"] as Record<string, unknown>;
  assert.equal(opts["timeout"], 30);
  assert.equal(opts["force"], true);
});

t("JSONParamFallbackToString", () => {
  const input = mkBlock(mkInvoke("exec_command", mkJSONParam("cmd", "ls -la")));
  const { calls } = repairAll(testTools, [input]);
  assert.equal(calls.length, 1);
  assert.equal(argsOf(calls[0].arguments)["cmd"], "ls -la");
});

// --- 不转换边界 ---
t("DisabledWithoutTools", () => {
  const input = mkBlock(mkInvoke("exec_command", mkParam("cmd", "pwd")));
  const { out, calls } = repairAll(null, [input]);
  assert.equal(out, input);
  assert.equal(calls.length, 0);
});

t("UnknownToolNameStaysText", () => {
  const input = mkBlock(mkInvoke("rm_rf_everything", mkParam("cmd", "pwd")));
  const { out, calls } = repairAll(testTools, [input]);
  assert.equal(calls.length, 0);
  assert.equal(out, input);
});

t("ProseInsideBlockStaysText", () => {
  const input = markupOpen + "\n我先说明一下：\n" + mkInvoke("exec_command", mkParam("cmd", "pwd")) + "\n" + markupClose;
  const { out, calls } = repairAll(testTools, [input]);
  assert.equal(calls.length, 0);
  assert.equal(out, input);
});

t("IncompleteBlockFlushesVerbatim", () => {
  const input = "前置说明\n" + markupOpen + "\n" + mkInvoke("exec_command", mkParam("cmd", "pwd"));
  const { out, calls } = repairAll(testTools, [input]);
  assert.equal(calls.length, 0);
  assert.equal(out, input);
});

t("PartialStartTokenHeldThenFlushed", () => {
  const partial = markupOpen.slice(0, markupOpen.length - 3);
  const { out, calls } = repairAll(testTools, ["说明" + partial]);
  assert.equal(calls.length, 0);
  assert.equal(out, "说明" + partial);
});

t("PlainAngleBracketsUnaffected", () => {
  const singlePipe = String.fromCodePoint(0xff5c);
  const input = '普通 HTML：<div class="x">a < b</div>，还有 3 < 5 与 <' + singlePipe + " 这种半角全角混排。";
  const { out, calls } = repairAll(testTools, [input]);
  assert.equal(calls.length, 0);
  assert.equal(out, input);
});

// --- 增量边界 ---
t("AnyChunkBoundary", () => {
  const input = "先读一遍控制器。\n\n" +
    mkBlock(
      mkInvoke("exec_command", mkParam("cmd", "cd /tmp && ls -la")),
      mkInvoke("exec_command", mkParam("cmd", "pwd")),
    ) + "\n收尾说明。";
  const want = "先读一遍控制器。\n\n\n收尾说明。";
  const chunkings: Record<string, string[]> = { whole: [input] };
  // 逐码点切分（按 UTF-16 code unit 切会切断全角竖线的代理对——U+FF5C 在 BMP 内
  // 单码元，但正文中文也全在 BMP，逐 code unit 切分与 Go 的逐 byte 切分对应的是
  // 解码后文本层；这里用 Array.from 逐码点，额外加一个粗暴的每 7 code unit 步长）。
  chunkings["byChar"] = Array.from(input);
  const step: string[] = [];
  for (let i = 0; i < input.length; i += 7) step.push(input.slice(i, i + 7));
  chunkings["step7"] = step;
  for (const [name, chunks] of Object.entries(chunkings)) {
    const { out, calls } = repairAll(testTools, chunks);
    assert.equal(out, want, name);
    assert.equal(calls.length, 2, name);
    assert.equal(argsOf(calls[0].arguments)["cmd"], "cd /tmp && ls -la", name);
  }
});

t("RealLeakedSample", () => {
  const raw = readFileSync(
    "C:/Users/16321/Downloads/workbuddy2api-panel-main/workbuddy2api-panel-main/internal/upstream/testdata/leaked_markup.txt",
    "utf8",
  );
  const { out, calls } = repairAll(new Set(["exec_command"]), [raw]);
  assert.equal(calls.length, 2);
  assert.ok(!out.includes(PIPE), "透出正文里仍残留标记: " + JSON.stringify(out));
  assert.ok(out.startsWith("我先看一下仓库结构和图片内容，再定位价格同步逻辑。"), "标记前的正文丢了: " + JSON.stringify(out));
  for (const c of calls) {
    assert.equal(c.name, "exec_command");
    assert.ok("cmd" in argsOf(c.arguments));
  }
});

t("ByteEquivalence", () => {
  const cases: [string, Set<string> | null, string, string, number][] = [
    ["空正文", testTools, "", "", 0],
    ["纯正文", testTools, "hello 世界", "hello 世界", 0],
    ["未声明工具", null, mkBlock(mkInvoke("exec_command", mkParam("cmd", "pwd"))), mkBlock(mkInvoke("exec_command", mkParam("cmd", "pwd"))), 0],
    ["畸形参数", testTools, markupOpen + mkInvoke("exec_command", "垃圾参数") + markupClose, markupOpen + mkInvoke("exec_command", "垃圾参数") + markupClose, 0],
    ["单块", testTools, "a" + mkBlock(mkInvoke("exec_command", mkParam("cmd", "pwd"))) + "b", "ab", 1],
    ["双块", testTools, mkBlock(mkInvoke("exec_command", mkParam("cmd", "a"))) + "中间" + mkBlock(mkInvoke("exec_command", mkParam("cmd", "b"))), "中间", 2],
  ];
  for (const [name, allowed, input, want, wantCalls] of cases) {
    const { out, calls } = repairAll(allowed, [input]);
    assert.equal(out, want, name);
    assert.equal(calls.length, wantCalls, name);
  }
});

t("ConvertedCounter", () => {
  const r = new MarkupRepair(testTools, false);
  const input = mkBlock(
    mkInvoke("exec_command", mkParam("cmd", "a")),
    mkInvoke("exec_command", mkParam("cmd", "b")),
  );
  const { calls } = r.feed(input);
  assert.equal(calls.length, 2);
  assert.equal(r.convertedCount(), 2);
  assert.equal(new MarkupRepair(null, false).convertedCount(), 0);
});

// --- 工具名单提取 ---
t("ToolNameAllowlist", () => {
  const cases: [string, string, string[]][] = [
    ["openai 形态", '{"tools":[{"type":"function","function":{"name":"exec_command"}},{"type":"function","function":{"name":"write_stdin"}}]}', ["exec_command", "write_stdin"]],
    ["responses 裸 name", '{"tools":[{"type":"function","name":"exec_command"}]}', ["exec_command"]],
    ["旧版 functions", '{"functions":[{"name":"exec_command"}]}', ["exec_command"]],
    ["历史 tool_calls", '{"messages":[{"role":"assistant","tool_calls":[{"function":{"name":"exec_command"}}]}]}', ["exec_command"]],
    ["历史 function_call", '{"messages":[{"role":"assistant","function_call":{"name":"exec_command"}}]}', ["exec_command"]],
    ["无工具", '{"model":"x","messages":[]}', []],
    ["空 tools", '{"tools":[]}', []],
    ["非法 JSON", "{", []],
    ["名字为空", '{"tools":[{"type":"function","function":{"name":""}}]}', []],
  ];
  for (const [name, body, want] of cases) {
    const got = toolNameAllowlist(body);
    assert.equal(got ? got.size : 0, want.length, name);
    for (const w of want) assert.ok(got!.has(w), name + ": 缺少 " + w);
  }
});

// --- 非流式聚合响应修复 ---
function aggregatedResponse(content: string, finish: string): Obj {
  return {
    id: "chatcmpl-test", object: "chat.completion", model: "global:deepseek-v4.1-flash",
    choices: [{
      index: 0,
      message: { role: "assistant", content },
      finish_reason: finish,
    }],
  };
}

t("RepairAggregatedResponse", () => {
  const content = "先读一遍控制器。\n\n" + mkBlock(mkInvoke("exec_command", mkParam("cmd", "ls -la")));
  const resp = aggregatedResponse(content, "stop");
  assert.ok(repairAggregatedResponse(resp, testTools, false).convertedCount() > 0);
  const choice = (resp["choices"] as Obj[])[0];
  const msg = choice["message"] as Obj;
  assert.equal(msg["content"], "先读一遍控制器。\n\n");
  const tcs = msg["tool_calls"] as Obj[];
  assert.equal(tcs.length, 1);
  assert.equal(tcs[0]["type"], "function");
  assert.ok(tcs[0]["id"]);
  const fn = tcs[0]["function"] as Obj;
  assert.equal(fn["name"], "exec_command");
  assert.equal(argsOf(fn["arguments"] as string)["cmd"], "ls -la");
  assert.equal(choice["finish_reason"], "tool_calls");
});

t("RepairAggregatedResponseSkips", () => {
  const markup = mkBlock(mkInvoke("exec_command", mkParam("cmd", "ls -la")));
  const withCalls = aggregatedResponse(markup, "stop");
  ((withCalls["choices"] as Obj[])[0]["message"] as Obj)["tool_calls"] = [{ id: "real", type: "function" }];
  assert.equal(repairAggregatedResponse(withCalls, testTools, false).convertedCount(), 0);
  assert.equal(repairAggregatedResponse(aggregatedResponse(markup, "length"), testTools, false).convertedCount(), 0);
  assert.equal(repairAggregatedResponse(aggregatedResponse(markup, "stop"), null, false).convertedCount(), 0);
  const plain = aggregatedResponse("普通回答，没有任何标记。", "stop");
  assert.equal(repairAggregatedResponse(plain, testTools, false).convertedCount(), 0);
  assert.equal(((plain["choices"] as Obj[])[0]["message"] as Obj)["content"], "普通回答，没有任何标记。");
});

// --- 弱判定 ---
t("WeakModeRealSample", () => {
  const raw = readFileSync(
    "C:/Users/16321/Downloads/workbuddy2api-panel-main/workbuddy2api-panel-main/internal/upstream/testdata/leaked_markup.txt",
    "utf8",
  );
  const r = new MarkupRepair(null, true);
  const res = r.feed(raw);
  const out = res.emit + r.flush();
  assert.equal(res.calls.length, 2);
  assert.ok(!out.includes(PIPE));
  assert.equal(r.convertedCount(), 2);
  assert.equal(r.seenCount(), 1);
  assert.equal(r.rejectedCount(), 0);
});

t("WeakModeNameShape", () => {
  const cases: [string, string, boolean][] = [
    ["下划线", "exec_command", true],
    ["点号冒号", "mcp.server:tool", true],
    ["短横线", "write-stdin", true],
    ["大写占位符", "NAME", true],
    ["尖括号占位符", "<tool_name>", false],
    ["空名", "", false],
    ["带空格", "exec command", false],
    ["超长", "a".repeat(65), false],
  ];
  for (const [name, tool, wantOK] of cases) {
    const input = mkBlock(mkInvoke(tool, mkParam("cmd", "ls")));
    const r = new MarkupRepair(null, true);
    const res = r.feed(input);
    r.flush();
    assert.equal(res.calls.length === 1, wantOK, name);
  }
});

t("WeakModeStillRejectsMalformed", () => {
  const cases = [
    markupOpen + "\n说明文字\n" + mkInvoke("exec_command", mkParam("cmd", "ls")) + "\n" + markupClose,
    markupOpen + mkInvoke("exec_command", "垃圾参数") + markupClose,
    markupOpen + mkInvoke("exec_command", mkParam("cmd", "ls")),
  ];
  for (const [i, input] of cases.entries()) {
    const r = new MarkupRepair(null, true);
    const res = r.feed(input);
    const out = res.emit + r.flush();
    assert.equal(res.calls.length, 0, "case " + i);
    assert.equal(out, input, "case " + i);
  }
});

// --- markupToolCalls 流式帧形态 ---
t("MarkupToolCallsFrame", () => {
  const tcs = markupToolCalls([{ name: "exec_command", arguments: '{"cmd":"ls"}' }], 3);
  assert.equal(tcs.length, 1);
  assert.equal(tcs[0]["index"], 3);
  assert.equal(tcs[0]["type"], "function");
  assert.ok(typeof tcs[0]["id"] === "string" && (tcs[0]["id"] as string).startsWith("call_"));
  const fn = tcs[0]["function"] as Obj;
  assert.equal(fn["name"], "exec_command");
  assert.equal(fn["arguments"], '{"cmd":"ls"}');
});

console.log("\n" + n + " 项 dsml 等价测试全部 PASS");