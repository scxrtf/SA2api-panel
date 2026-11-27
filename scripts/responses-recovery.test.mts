import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { prepareBridgeInput } from "../src/lib/responses-input";
import { ResponsesError } from "../src/lib/responses-http";
import { responsesCodec } from "../src/lib/responses-state";
import { expandAttachments, pdfText } from "../src/lib/responses-attachments";

const codec = responsesCodec("recovery-fixture");
const prepare = async (input: unknown[]) => (await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input, store: false }, [], codec)).chat;
const call = (id: string) => ({ type: "function_call", call_id: id, name: "lookup", arguments: "{}" });
const image = (id: string) => ({ type: "input_image", image_url: `data:image/png;base64,${id}` });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("truncated and orphaned tool history is repaired without empty content arrays", async () => {
  const chat = await prepare([
    { type: "function_call_output", call_id: "orphan", output: "stale" },
    call("call_a"), call("call_b"),
    { type: "function_call_output", call_id: "call_a", output: [image("YQ==")] },
    { type: "function_call_output", call_id: "call_b", output: [image("Yg==")] },
    { role: "user", content: "continue" },
  ]);
  assert.deepEqual(chat.messages.map((message: { role: string }) => message.role), ["assistant", "tool", "tool", "user", "user"]);
  assert.equal(chat.messages[1].content, "[Image-only tool result. See the following message.]");
  assert.equal(chat.messages[2].content, "[Image-only tool result. See the following message.]");
  assert.match(chat.messages[3].content[0].text, /call_a/);
  assert.match(chat.messages[3].content[2].text, /call_b/);
});

test("missing tool outputs receive explicit interruption results before a new turn", async () => {
  const chat = await prepare([call("unfinished"), { role: "user", content: "continue" }]);
  assert.deepEqual(chat.messages.slice(1).map((message: { role: string }) => message.role), ["tool", "user"]);
  assert.equal(chat.messages[1].tool_call_id, "unfinished");
  assert.match(chat.messages[1].content, /interrupted/);
});

test("inline text, text URLs and image file data are expanded into Chat content", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("downloaded attachment", {
    headers: { "Content-Type": "text/plain" },
  }));
  const chat = await prepare([
    { role: "user", content: [
      { type: "input_file", filename: "note.txt", file_data: Buffer.from("inline attachment").toString("base64") },
      { type: "input_file", filename: "remote.txt", file_url: "https://example.test/remote.txt" },
      { type: "input_image", file_id: "client-image", file_data: png, mime_type: "image/png" },
    ] },
  ]);
  assert.match(chat.messages[0].content[0].text, /inline attachment/);
  assert.match(chat.messages[0].content[1].text, /downloaded attachment/);
  assert.equal(chat.messages[0].content[2].type, "image_url");
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("uncompressed and Flate PDF text streams are extracted", async () => {
  const content = "BT /F1 12 Tf 72 720 Td (PDF fixture text) Tj ET";
  const plain = Buffer.from(`%PDF-1.4\n1 0 obj << /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n%%EOF`);
  assert.equal(pdfText(plain), "PDF fixture text");
  const compressed = deflateSync(Buffer.from(content));
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n1 0 obj << /Filter /FlateDecode >>\nstream\n"), compressed, Buffer.from("\nendstream\nendobj\n%%EOF")]);
  assert.equal(pdfText(pdf), "PDF fixture text");
  const input = [{ type: "message", role: "user", content: [{ type: "input_file", filename: "fixture.pdf", file_data: plain.toString("base64") }] }];
  await expandAttachments(input);
  assert.match(String(input[0].content[0].text), /PDF fixture text/);
});

test("invalid standalone file IDs and malformed base64 fail before upstream calls", async () => {
  await assert.rejects(() => prepare([{ role: "user", content: [{ type: "input_file", file_id: "upstream-only" }] }]), (error) => {
    assert.ok(error instanceof ResponsesError);
    assert.match(error.message, /file_data|file_url/);
    return true;
  });
  await assert.rejects(() => prepare([{ role: "user", content: [{ type: "input_file", filename: "bad.txt", file_data: "not base64!" }] }]), /base64/);
});

test("allowed_tools maps ordinary and hosted choices without a native error", async () => {
  const { chat } = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "lookup" }] },
  }, [], codec);
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "lookup" } });
});

test("tool discovery, hosted tool choices and histories remain usable on Chat", async () => {
  for (const type of ["file_search", "computer_use_preview", "code_interpreter", "image_generation", "local_shell", "mcp"]) {
    const { chat, effectiveBody, omittedTools } = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
      tools: [{ type }, { type: "function", name: "lookup", parameters: { type: "object" } }], tool_choice: { type },
    }, [], codec);
    assert.deepEqual(effectiveBody.tools, [{ type: "function", name: "lookup", parameters: { type: "object" } }]);
    assert.equal(chat.tool_choice, "auto");
    assert.equal(omittedTools.includes(type), true);
  }
  for (const type of ["tool_search_call", "file_search_call", "mcp_call", "tool_search_output"]) {
    const chat = await prepare([{ type, tools: [{ type: "function", name: "lookup" }], result: "fixture" }]);
    assert.match(String(chat.messages[0].content), /fixture/);
  }
  const { chat } = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: [{ role: "assistant", content: [image("YQ==")] }], store: false }, [], codec);
  assert.equal(chat.messages[0].content, "[Image attached in the following user message.]");
  assert.equal(chat.messages.at(-1).role, "user");
  assert.equal(chat.messages.at(-1).content[1].type, "image_url");
});

test("tool filtering is non-mutating and none/hosted choices never invent tool calls", async () => {
  const original = { type: "namespace", name: "catalog", tools: [
    { type: "tool_search" }, { type: "function", name: "lookup", parameters: { type: "object" } },
  ] };
  const { effectiveBody } = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", tools: [original], store: false }, [], codec);
  assert.deepEqual(original.tools.map((tool) => tool.type), ["tool_search", "function"]);
  assert.deepEqual(effectiveBody.tools[0].tools, [{ type: "function", name: "lookup", parameters: { type: "object" } }]);
  const none = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [{ type: "tool_search" }], tool_choice: "none" }, [], codec);
  assert.equal(none.chat.tool_choice, "none");
  const hostedNone = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [{ type: "tool_search" }, { type: "function", name: "lookup", parameters: { type: "object" } }],
    tool_choice: { type: "allowed_tools", mode: "none", tools: [{ type: "tool_search" }] } }, [], codec);
  assert.equal(hostedNone.chat.tool_choice, "none");
  await assert.rejects(() => prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [], tool_choice: { type: "function", name: "undeclared" } }, [], codec), /not declared/);
  await assert.rejects(() => prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tool_choice: { type: "allowed_tools", mode: "invalid", tools: [] } }, [], codec), /tool_choice.mode/);
});

test("attachment expansion does not mutate replayed history objects", async () => {
  const original = { type: "function_call_output", call_id: "call_file", output: [
    { type: "input_file", filename: "history.txt", file_data: Buffer.from("history").toString("base64") },
  ] };
  const history = [call("call_file"), original];
  await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: [], store: false }, history, codec);
  assert.equal(original.output[0].type, "input_file");
  assert.equal(history[0], history[0]);
});

test("namespace and multiple allowed tools preserve valid mode semantics", async () => {
  const namespace = { type: "namespace", name: "catalog", tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }] };
  const allowed = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false, tools: [namespace],
    tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "namespace", name: "catalog" }] } }, [], codec);
  assert.equal(allowed.chat.tool_choice, "required");
  const hosted = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [], tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "future_hosted" }] } }, [], codec);
  assert.equal(hosted.chat.tool_choice, undefined);
  await assert.rejects(() => prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [], tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "" }] } }, [], codec), /Invalid tool type/);
});

test("tool discovery variants and attachments retain text without native-model errors", async () => {
  for (const type of ["tool_search_tool_call", "tool_search_tool_output", "tool_search_tool_result", "tool_search_result", "shell_call", "apply_patch_call"]) {
    const chat = await prepare([{ type, result: "retained result" }]);
    assert.match(String(chat.messages[0].content), /retained result/);
  }
  const chat = await prepare([{ role: "user", content: [
    { type: "input_file", filename: "note.txt", file_data: Buffer.from('escaped "text"').toString("base64") },
  ] }]);
  assert.match(String(chat.messages[0].content), /escaped/);
});

test("unknown content and custom output history remain explicit rather than disappearing", async () => {
  const chat = await prepare([
    { role: "user", content: [{ type: "future_content", text: "retain this text" }] },
    { type: "custom_tool_call_output_item", result: "custom output retained" },
  ]);
  assert.match(String(chat.messages[0].content), /retain this text/);
  assert.match(String(chat.messages[1].content), /custom output retained/);
});

test("allowed_tools filters callable declarations and rejects an empty required choice", async () => {
  const lookup = { type: "function", name: "lookup", parameters: { type: "object" } };
  const extra = { type: "function", name: "extra", parameters: { type: "object" } };
  const filtered = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [lookup, extra], tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "lookup" }] },
  }, [], codec);
  assert.deepEqual(filtered.chat.tools?.map((tool: { function: { name: string } }) => tool.function.name), ["lookup"]);
  assert.deepEqual(filtered.chat.tool_choice, { type: "function", function: { name: "lookup" } });
  const nested = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [{ type: "namespace", name: "catalog", tools: [lookup, extra] }],
    tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "lookup", namespace: "catalog" }] },
  }, [], codec);
  assert.equal(nested.chat.tools?.length, 1);
  assert.match(nested.chat.tools?.[0].function.name, /^lookup_/);
  assert.equal(nested.chat.tool_choice?.function?.name, nested.chat.tools?.[0].function.name);
  const none = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [lookup], tool_choice: { type: "allowed_tools", mode: "none", tools: [{ type: "function", name: "lookup" }] },
  }, [], codec);
  assert.equal(none.chat.tool_choice, "none");
  await assert.rejects(() => prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [lookup], tool_choice: { type: "allowed_tools", mode: "required", tools: [{ type: "namespace", name: "missing" }] },
  }, [], codec), /namespace was not declared/);
  await assert.rejects(() => prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [lookup], tool_choice: { type: "allowed_tools", mode: "required", tools: [] },
  }, [], codec), /must not be empty/);
});

test("unknown hosted tools and history items degrade to text instead of native-model errors", async () => {
  const lookup = { type: "function", name: "lookup", parameters: { type: "object" } };
  const { chat, effectiveBody, omittedTools } = await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input: "hello", store: false,
    tools: [{ type: "future_hosted_tool", config: { fixture: true } }, lookup], tool_choice: { type: "future_hosted_tool" },
  }, [], codec);
  assert.deepEqual(effectiveBody.tools, [lookup]);
  assert.deepEqual(omittedTools, ["future_hosted_tool"]);
  assert.equal(chat.tool_choice, "auto");
  const history = await prepare([{ type: "future_hosted_history", result: "future payload" }]);
  assert.match(String(history.messages[0].content), /future payload/);
});

test("invalid PNG bytes are rejected while valid image data is forwarded", async () => {
  await assert.rejects(() => expandAttachments([{ type: "message", role: "user", content: [
    { type: "input_image", file_data: Buffer.from("not a png").toString("base64"), mime_type: "image/png" },
  ] }]), /PNG attachment has invalid content/);
});
