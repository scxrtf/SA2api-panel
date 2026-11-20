import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RequestLogTable, type ReqLog } from "../src/app/panel/components/request-log-table.tsx";

function renderLog(keyName?: string) {
  const row: ReqLog = {
    id: "req-1", at: "2026-11-20T00:00:00Z", uid: "account-1", model: "test-model",
    status: 200, durationMs: 200, errKind: "", clientIp: "", ua: "", realm: "cn",
    provider: "", stream: false, keyName,
  };
  return renderToStaticMarkup(createElement(RequestLogTable, {
    rows: [row], expanded: row.id, onToggle() {}, renderDetail: () => null,
    filtered: false, initial: false, error: "",
  }));
}

test("request log shows the recorded key alias in the column, compact row and details", () => {
  // `unknown` is a valid user-chosen key name, not a placeholder from an upstream field.
  const html = renderLog("unknown");
  const header = html.match(/<thead[^>]*>(.*?)<\/thead>/)?.[1] ?? "";
  assert.match(header, /<th\b[^>]*\bscope="col"[^>]*>Key 归属<\/th>/);
  assert.match(html, /<td\b[^>]*\blog-col-key\b[^>]*><span[^>]*title="unknown">unknown<\/span><\/td>/);
  assert.match(html, /class="log-compact-key"><span[^>]*>Key 归属<\/span><span[^>]*>unknown<\/span>/);
  assert.match(html, /<dt>Key 归属<\/dt><dd>unknown<\/dd>/);
  const columns = [...header.matchAll(/<th\b/g)].length;
  assert.equal(Number(html.match(/\bcolSpan="(\d+)"/i)?.[1]), columns);
});

test("request log does not guess the owner when the stored key name is empty", () => {
  for (const html of [renderLog(), renderLog("   ")]) {
    assert.match(html, /<td\b[^>]*\blog-col-key\b[^>]*><span[^>]*>未记录<\/span><\/td>/);
    assert.match(html, /<dt>Key 归属<\/dt><dd>未记录<\/dd>/);
  }
});
