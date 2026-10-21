// provider-endpoint.test.mts — Base URL 带/不带版本段时的端点拼接回归。
import assert from "node:assert/strict";
import { providerEndpoint } from "../src/lib/provider-endpoint.ts";

let n = 0;
function t(name: string, fn: () => void) {
  fn(); n++; console.log("PASS " + name);
}

// 只填主机：补 /v1
t("host only → /v1/models", () => {
  assert.equal(providerEndpoint("https://api.example.com", "/models"), "https://api.example.com/v1/models");
});
t("host + trailing slash → /v1/models", () => {
  assert.equal(providerEndpoint("https://api.example.com/", "/models"), "https://api.example.com/v1/models");
});
t("host only → /v1/chat/completions", () => {
  assert.equal(
    providerEndpoint("https://api.example.com", "/chat/completions"),
    "https://api.example.com/v1/chat/completions",
  );
});

// 已带版本段：不再补 /v1（此前的 /v1/v1/models 404 根因）
t("base ends with /v1 → /v1/models", () => {
  assert.equal(providerEndpoint("https://api.example.com/v1", "/models"), "https://api.example.com/v1/models");
});
t("base ends with /v1/ → /v1/models", () => {
  assert.equal(providerEndpoint("https://api.example.com/v1/", "/models"), "https://api.example.com/v1/models");
});
t("base ends with /v1 → /v1/chat/completions", () => {
  assert.equal(
    providerEndpoint("https://api.example.com/v1", "/chat/completions"),
    "https://api.example.com/v1/chat/completions",
  );
});
t("base ends with /v1beta → /v1beta/models", () => {
  assert.equal(providerEndpoint("https://api.example.com/v1beta", "/models"), "https://api.example.com/v1beta/models");
});
t("base with path prefix + /v1 → /v1/models", () => {
  assert.equal(providerEndpoint("https://api.example.com/openai/v1", "/models"), "https://api.example.com/openai/v1/models");
});
t("uppercase V1 is detected", () => {
  assert.equal(providerEndpoint("https://api.example.com/V1", "/models"), "https://api.example.com/V1/models");
});
t("path without leading slash is normalized", () => {
  assert.equal(providerEndpoint("https://api.example.com", "models"), "https://api.example.com/v1/models");
});
t("whitespace is trimmed", () => {
  assert.equal(providerEndpoint("  https://api.example.com/v1  ", "/models"), "https://api.example.com/v1/models");
});

console.log(`\n${n} passed`);
