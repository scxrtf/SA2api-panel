import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LogPagination, LogListLoading } from "../src/app/panel/components/log-pagination.tsx";
import { RequestLogTable, type ReqLog } from "../src/app/panel/components/request-log-table.tsx";
import { formatLogTokens } from "../src/lib/request-log-metrics.ts";

test("log Token counts use millions with the correct scale and preserve small integers", () => {
  const values = [[0, "0"], [9999, "9,999"], [10_000, "0.01M"], [62_500, "0.063M"], [1_000_000, "1M"], [1_234_567, "1.235M"]] as const;
  for (const [count, expected] of values) assert.equal(formatLogTokens(count), expected);

  const row: ReqLog = {
    id: "page-1", at: "2026-11-20T00:00:00Z", uid: "test", model: "test-model",
    status: 200, durationMs: 250, errKind: "", clientIp: "", ua: "", realm: "cn",
    provider: "", stream: false, totalTokens: 1_200_000,
  };
  const html = renderToStaticMarkup(createElement(RequestLogTable, {
    rows: [row], expanded: row.id, onToggle() {}, renderDetail: () => null, filtered: false, initial: false, error: "",
  }));
  assert.equal([...html.matchAll(/title="1,200,000 Token">1\.2M Token/g)].length, 2);
  assert.match(html, /<dt>总 Token<\/dt><dd>1,200,000 Token<\/dd>/);
});

const pager = { page: 2, total: 112, totalPages: 3, pageSize: 50, onPageChange() {} };

test("pager labels the loaded page separately from the in-flight page", () => {
  const html = renderToStaticMarkup(createElement(LogPagination, { ...pager, pendingPage: 3, blocked: true }));
  assert.match(html, /aria-current="page" aria-label="第 2 页"/);
  assert.match(html, /aria-label="第 3 页" data-pending="true"/);
  assert.match(html, /role="status"[^>]*>正在加载第 3 页…/);
  assert.match(html, /class="log-pager-rail" aria-hidden="true"/);
  assert.doesNotMatch(html, /aria-current="page" aria-label="第 3 页"/);
});

test("pager has a retry for a failed target and reports the last partial page range", () => {
  const failed = renderToStaticMarkup(createElement(LogPagination, { ...pager, blocked: false, failure: { page: 3, message: "timeout" } }));
  assert.match(failed, /第 3 页加载失败/);
  assert.match(failed, /<button[^>]*>重试<\/button>/);
  assert.doesNotMatch(failed, /log-pager-rail/);
  const ready = renderToStaticMarkup(createElement(LogPagination, { ...pager, page: 3, blocked: false }));
  assert.match(ready, /显示第 101–112 条/);
});

test("first load has a named live status and hides decorative skeleton rows", () => {
  const loading = renderToStaticMarkup(createElement(LogListLoading, { label: "正在加载请求日志…" }));
  assert.match(loading, /role="status" aria-label="正在加载请求日志…"/);
  assert.match(loading, /class="log-list-skeleton" aria-hidden="true"/);
});
