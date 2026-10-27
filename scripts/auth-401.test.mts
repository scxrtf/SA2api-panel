// auth-401.test.mts — 上游 401（APISIX HTML，无业务信封）分类回归（离线，无网络）。
// 现场：24/28 个 cn 账号的 access token 已被上游吊销，/v2/chat/completions 返回
// openresty 401 HTML。旧口径落到 "client"（请求级），既不强刷也不冷却/禁用，
// 坏号长期滞留池中；每次请求在 8 个死号间轮转 + 指数退避 ≈ 40s，末端误报
// 503 no_healthy_account。
import assert from "node:assert/strict";
import {
  classify,
  gatewayHint,
} from "file:///C:/Users/16321/Downloads/workbuddy2api-panel-main/wb2api-next/src/lib/upstream/errors.ts";

// 上游实际返回的 401 原文（截取关键结构）。
const apisix401 =
  "<html>\r\n<head><title>401 Authorization Required</title></head>\r\n<body>\r\n" +
  "<center><h1>401 Authorization Required</h1></center>\r\n<hr><center>openresty</center>\r\n" +
  '<p><em>Powered by <a href="https://apisix.apache.org/">APISIX</a>.</em></p>\r\n</body>\r\n</html>';

// 1. 网关层 401 → auth_expired（不是 client）。
assert.equal(classify(401, apisix401), "auth_expired", "APISIX 401 HTML is auth_expired");

// 2. refresh 端点的 12153 仍走 session_dead（有业务信封，语义是「需重新登录」）。
const refreshDead = '{"code":12153,"msg":"12153:refresh token is invalid","requestId":"x"}';
assert.equal(classify(401, refreshDead), "session_dead", "12153 stays session_dead");

// 3. 403 无信封仍是 WAF（不能被 401 规则吞掉）。
assert.equal(classify(403, apisix401), "waf_block", "403 without envelope stays waf_block");

// 4. 请求级 400 仍是 client（由 chat 层 fail-fast 透传 400，不再轮转）。
assert.equal(classify(400, '{"code":11133,"msg":"model_param_invalid"}'), "client", "11133 stays client");
assert.equal(classify(413, "payload too large"), "client", "413 stays client");

// 5. 其他既有分类不被回归。
assert.equal(classify(402, '{"msg":"quota exceeded"}'), "hard_credit", "402 stays hard_credit");
assert.equal(classify(429, '{"msg":"too many requests"}'), "soft_rate", "429 stays soft_rate");
assert.equal(classify(500, "boom"), "server", "500 stays server");

// 6. hint 可读（运营商需要知道该重新登录，而不是「池不可用」）。
assert.match(gatewayHint("auth_expired", apisix401, {}), /401/, "hint mentions 401");
assert.match(gatewayHint("auth_expired", apisix401, {}), /re-login/, "hint mentions re-login");

console.log("auth-401: all assertions passed");
