// errKind 展示回归：机器码必须转成中文标签，未知/历史脏值不得原样透出。
import assert from "node:assert/strict";
import { errKindLabel, knownText, uaDisplay } from "../src/lib/logfmt.ts";

assert.equal(errKindLabel(""), "");
assert.equal(errKindLabel("   "), "");
assert.equal(errKindLabel("none"), "");
// 历史脏数据 / 未知 kind 一律折叠为中文兜底，绝不显示 "unknown"。
assert.equal(errKindLabel("unknown"), "未分类错误");
assert.equal(errKindLabel("legacy_kind"), "未分类错误");
assert.equal(errKindLabel("soft_rate"), "上游限流");
assert.equal(errKindLabel("hard_credit"), "额度耗尽");
assert.equal(errKindLabel("provider_stream_timeout"), "供应商流超时");
assert.equal(errKindLabel("provider_expected_sse"), "供应商未返回 SSE");
assert.equal(errKindLabel("transport"), "网络传输失败");
assert.equal(errKindLabel("upstream_timeout"), "上游超时");
assert.equal(errKindLabel("provider_header_timeout"), "供应商响应超时");

// 请求日志展示层：占位值折叠为空串，UA 里的 unknown 换成中文。
assert.equal(knownText("unknown"), "");
assert.equal(knownText(" UNKNOWN "), "");
assert.equal(knownText("null"), "");
assert.equal(knownText("n/a"), "");
assert.equal(knownText("gpt-5"), "gpt-5");
assert.equal(
  uaDisplay("Codex Desktop/0.162.0-alpha.2 (Windows 10.0.26100; x86_64) unknown (Codex Desktop; 26.1002.52244)"),
  "Codex Desktop/0.162.0-alpha.2 (Windows 10.0.26100; x86_64) 未知 (Codex Desktop; 26.1002.52244)",
);
assert.equal(uaDisplay(""), "");

console.log("errkind-label: all assertions passed");
