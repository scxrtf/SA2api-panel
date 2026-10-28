// queue-6020.test.mts — 6020 queue.waiting 分类回归（离线，无网络）。
// 实测上游返回 {"code":6020,"msg":"queue.waiting.title",...}，网关曾把它
// 当作 429 账号软限流（账号级冷却 + softStreak++ + 清模型冷却）。
import assert from "node:assert/strict";
import {
  classify,
  frameKind,
  gatewayHint,
  isQueueWait,
  parseQueuePosition,
  parseQueueRetryAfter,
} from "file:///C:/Users/16321/Downloads/workbuddy2api-panel-main/wb2api-next/src/lib/upstream/errors.ts";

// 用户现场 body（data 被截断也照判，分类只依赖正则）。
const liveBody =
  '{"code":6020,"msg":"queue.waiting.title","requestId":"78305b4a8a8c16de661fbc782d2a8829",' +
  '"data":{"queue_positio';
// 完整信封（用于解析队列位置）。
const fullBody =
  '{"code":6020,"msg":"queue.waiting.title","requestId":"78305b4a8a8c16de661fbc782d2a8829",' +
  '"data":{"queue_position":3,"queue_position_total":10}}';

// 1. 识别与分类：任何状态码下 6020 都应归到 soft_queue。
assert.equal(isQueueWait(liveBody), true, "live body detected");
assert.equal(classify(429, liveBody), "soft_queue", "429+6020 is queue, not soft_rate");
assert.equal(classify(400, liveBody), "soft_queue", "400+6020 is queue");
assert.equal(classify(200, liveBody), "soft_queue", "200 envelope + 6020 is queue");
assert.equal(classify(403, fullBody), "soft_queue", "403+6020 is queue");
assert.equal(classify(200, fullBody), "soft_queue", "full body classify");

// 2. 空格/引号容差 + 数字边界。
assert.equal(classify(429, '{"code" : 6020, "msg":"queue.waiting.title"}'), "soft_queue", "space tolerance");
assert.equal(classify(429, '{"code":"6020"}'), "soft_queue", "string code");
assert.equal(isQueueWait('{"code":60201}'), false, "60201 must not match");
assert.equal(isQueueWait('{"code":6004}'), false, "6004 is not queue");
assert.equal(isQueueWait('{"msg":"queue.waiting.title"}'), true, "message-only queue body");

// 3. 既有分类不被回归。
assert.equal(classify(429, '{"msg":"too many requests"}'), "soft_rate", "plain 429 stays soft_rate");
assert.equal(classify(429, '{"code":14018,"msg":"credit exhausted"}'), "hard_credit", "14018 stays hard_credit");
assert.equal(classify(429, '{"code":6004}'), "soft_rate", "6004 stays soft_rate");

// 4. 队列位置解析（只认精确键，不把 total 当 position）。
assert.equal(parseQueuePosition(fullBody), 3, "queue_position parsed");
assert.equal(parseQueuePosition('{"data":{"queuePosition":"7"}}'), 7, "camelCase string parsed");
assert.equal(parseQueuePosition('{"data":{"queue_position_total":10}}'), 0, "total ignored");
assert.equal(parseQueuePosition(liveBody), 0, "truncated JSON returns 0");
assert.equal(parseQueuePosition("not json"), 0, "non-JSON returns 0");
assert.equal(parseQueueRetryAfter('{"data":{"retry_after":1.25}}'), 1250, "nested seconds parsed");
assert.equal(parseQueueRetryAfter('{"data":{"retryAfter":"2"}}'), 2000, "camelCase seconds parsed");
assert.equal(parseQueueRetryAfter('{"data":{"retry_after_ms":"750"}}'), 750, "nested milliseconds parsed");
assert.equal(parseQueueRetryAfter('{"data":{"retryAfterMs":750.1}}'), 751, "milliseconds rounded up");
assert.equal(parseQueueRetryAfter('{"data":{"retry_after_seconds":3}}'), 3000, "explicit seconds parsed");
assert.equal(parseQueueRetryAfter('{"data":{"retry_after":-1}}'), 0, "negative retry ignored");
assert.equal(parseQueueRetryAfter('{"data":{"retry_after":"later"}}'), 0, "invalid retry ignored");
assert.equal(parseQueueRetryAfter(liveBody), 0, "truncated retry body returns 0");

// 5. gateway_hint 与 SSE error 帧。
assert.match(gatewayHint("soft_queue", fullBody, {}), /queue position 3/, "hint carries position");
assert.match(gatewayHint("soft_queue", '{"msg":"queue.waiting.title"}', {}), /retry shortly/, "hint without position");
assert.equal(
  frameKind(JSON.stringify({ error: { message: liveBody } })),
  "soft_queue",
  "SSE error frame classifies as queue",
);

console.log("queue-6020: all assertions passed");
