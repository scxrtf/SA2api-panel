import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeRequestLogData } from "../src/lib/request-log-detail.ts";

test("RequestLog 写入清洗移除所有层级与字段名中的 NUL", () => {
  const input = {
    model: "gpt\u0000-test",
    errMsg: "upstream\u0000 failed",
    requestMessages: [{
      role: "user",
      content: "你好\u0000，世界 👋",
      tool_calls: [{ function: { arguments: "{\"path\":\"a\\u0000b\"}\u0000" } }],
    }],
    "bad\u0000key": "value\u0000",
  };
  const out = sanitizeRequestLogData(input);
  assert.equal(out.model, "gpt-test");
  assert.equal(out.errMsg, "upstream failed");
  assert.equal(out.requestMessages[0].content, "你好，世界 👋");
  assert.equal(out.requestMessages[0].tool_calls[0].function.arguments, "{\"path\":\"a\\u0000b\"}");
  assert.deepEqual(out.badkey, "value");
  assert.equal(JSON.stringify(out).includes("\u0000"), false);
});

test("RequestLog 清洗保留普通反斜杠、Unicode 转义文本与非字符串值", () => {
  const input = {
    content: "C:\\temp\\new \\\\ \\u0000 中文 😀",
    status: 200,
    stream: false,
    empty: null,
  };
  assert.deepEqual(sanitizeRequestLogData(input), input);
});
