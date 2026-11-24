import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { prepareBridgeInput } from "../src/lib/responses-input";
import { ResponsesError } from "../src/lib/responses-http";
import { responsesCodec } from "../src/lib/responses-state";
import { expandAttachments, pdfText } from "../src/lib/responses-attachments";

const codec = responsesCodec("recovery-fixture", "test-secret");
const prepare = async (input: unknown[]) => (await prepareBridgeInput({ model: "cn:kimi-k3.1-pro", input, store: false }, [], codec)).chat;
const call = (id: string) => ({ type: "function_call", call_id: id, name: "lookup", arguments: "{}" });
const image = (id: string) => ({ type: "input_image", image_url: `data:image/png;base64,${id}` });

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
      { type: "input_image", file_id: "client-image", file_data: "aW1hZ2U=", mime_type: "image/png" },
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
