// 账号冷却原因展示回归：完整/截断的上游信封均离线验证。
import assert from "node:assert/strict";
import { accountReasonKind, accountReasonSummary } from "../src/lib/logfmt.ts";

const usageLimit = 'soft_rate: {"code":6000,"msg":"您的使用量已超出频率限制，将在 2026-10-26 13:08:55 UTC+8 重置，您也可以切换其他模型继续使用。","requestId":"01a17626c15eae7';
const tooMany = 'soft_rate: {"code":14003,"msg":"too many requests","requestId":"01a1764736dc16e3ffb0cacafc9703a5","retry_policy":{"retry"';

assert.equal(
  accountReasonSummary(usageLimit),
  "使用量已超出频率限制（6000） · 2026-10-26 13:08:55 UTC+8 重置",
);
assert.equal(accountReasonSummary(tooMany), "上游请求过于频繁（14003）");
assert.equal(accountReasonKind(usageLimit), "软限流");
assert.equal(accountReasonKind(tooMany), "软限流");

const truncated = 'soft_rate: {"code":6000,"msg":"您的使用量已超出频率限制，将在';
assert.equal(accountReasonSummary(truncated), "使用量已超出频率限制（6000）");
assert.equal(accountReasonSummary('6004 {"code":6004,"msg":"model rate limit"}'), "模型限流（6004）");
assert.equal(accountReasonSummary("consecutive failures"), "consecutive failures");
assert.equal(accountReasonSummary(""), "");

console.log("account-error-display: all assertions passed");
