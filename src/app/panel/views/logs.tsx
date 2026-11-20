"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { DatabaseIcon, FileTextIcon, RefreshCwIcon, TerminalIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CacheStatusSnapshot } from "@/lib/cache-status";
import { summarizeRequestPage } from "@/lib/request-log-metrics";
import { summarizeRequestSessions, type RequestLogSessionsPage } from "@/lib/request-log-sessions";
import { fmtClock, req, useAutoRefresh, usePanelRefresh } from "../lib";
import { ButtonLoadingContent, LoadingIndicator, type Flash } from "../components/ui";
import { SuperPasswordModal } from "../components/superPassword";
import { CacheStatusPanel } from "../components/cache-status-panel";
import { LogListLoading, LogPagination } from "../components/log-pagination";
import { RequestLogSessions } from "../components/request-log-sessions";
import {
  EMPTY_REQUEST_FILTER,
  fmtLogMs,
  requestFilterParams,
  RequestLogFilters,
  RequestLogSummary,
  RequestLogTable,
  type ReqLog,
} from "../components/request-log-table";
import "./logs.css";

interface LogEntry {
  id?: string;
  ts: number;
  ch: "task" | "chat" | "call" | "probe" | "sys";
  text: string;
}
interface ReqLogDetail extends ReqLog {
  errorDetail?: string;
  parameterOverrides?: unknown;
  attemptDetails?: unknown;
  requestMessages?: unknown;
  responseMessage?: unknown;
}
type LogMode = "requests" | "runtime" | "cache";
type RequestView = "request" | "session";
type ActiveLogMode = LogMode | "sessions";
type LoadReason = "scope" | "page" | "refresh" | "poll";
type LogScope = { mode: ActiveLogMode; scope: string };
type LogLoad = LogScope & { reason: LoadReason; page: number };

// ── 增量合并 ────────────────────────────────────────────────────────────────
// 运行日志保持升序（旧→新，底部跟随最新），请求日志保持降序（新→旧）。
// 服务端 since 模式返回的是新增行，这里按 id 去重后截到与全量页相同的条数。
const RUNTIME_PAGE = 200;
const REQUEST_PAGE = 50;

function mergeRuntime(prev: LogEntry[], next: LogEntry[]): LogEntry[] {
  const seen = new Set<string>();
  const out: LogEntry[] = [];
  for (const item of [...prev, ...next]) {
    const key = item.id ?? item.ts + ":" + item.text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  out.sort((a, b) => a.ts - b.ts || (a.id ?? "").localeCompare(b.id ?? ""));
  return out.slice(-RUNTIME_PAGE);
}

function mergeRequests(prev: ReqLog[], next: ReqLog[]): ReqLog[] {
  const seen = new Set<string>();
  const out: ReqLog[] = [];
  for (const item of [...next, ...prev]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
  return out.slice(0, REQUEST_PAGE);
}
interface LogPageResponse<T> {
  entries: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  mode?: string;
}

function recordList(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === "object" && !Array.isArray(item));
}

function valueText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function LogSection({ title, empty, emptyText, children }: {
  title: string;
  empty?: boolean;
  emptyText?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="log-detail-section">
      <h4 className="log-detail-title">{title}</h4>
      {empty ? <div className="log-detail-empty">{emptyText ?? "旧日志未记录此项"}</div> : children}
    </section>
  );
}

// 未知角色保留原名，日志占位与真实对话区分。
const ROLE_META: Record<string, { label: string; cls: string }> = {
  system: { label: "系统", cls: "role-system" },
  user: { label: "用户", cls: "role-user" },
  assistant: { label: "助手", cls: "role-assistant" },
  tool: { label: "工具", cls: "role-tool" },
  log: { label: "日志", cls: "role-log" }, // 日志占位行（截断说明），非真实对话
};

// 截断标记：正文以「\n…[已截断 N 字符]」结尾时拆出标记单独高亮，
// 避免长文阅读时看不到它其实被截断了。
const TRUNC_TAIL = /\n?(…\[已截断 \d+ 字符\])$/;

function splitTruncation(text: string): { body: string; marker: string | null } {
  const m = TRUNC_TAIL.exec(text);
  if (!m) return { body: text, marker: null };
  return { body: text.slice(0, m.index), marker: m[1] };
}

// 多模态 content（数组）折叠成可读行：text 段直接展开，image_url 等显示摘要。
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const lines: string[] = [];
    for (const part of content) {
      if (part && typeof part === "object" && !Array.isArray(part)) {
        const p = part as Record<string, unknown>;
        if (p["type"] === "text" && typeof p["text"] === "string") {
          lines.push(p["text"] as string);
        } else if (p["type"] === "image_url") {
          const url = (p["image_url"] as Record<string, unknown> | undefined)?.["url"];
          lines.push(`[图片] ${typeof url === "string" ? (url.length > 120 ? url.slice(0, 120) + "…" : url) : ""}`);
        } else {
          lines.push(`[${typeof p["type"] === "string" ? p["type"] as string : "part"}]`);
        }
      } else if (typeof part === "string") {
        lines.push(part);
      }
    }
    return lines.join("\n");
  }
  if (content === undefined || content === null) return "";
  return valueText(content);
}

function toolCallText(tc: Record<string, unknown>): string {
  const fn = tc["function"];
  if (fn && typeof fn === "object") {
    const f = fn as Record<string, unknown>;
    return `${typeof f["name"] === "string" ? f["name"] : "?"}(${typeof f["arguments"] === "string" ? f["arguments"] : valueText(f["arguments"])})`;
  }
  return valueText(tc);
}

// 把一条对话消息渲染成紧凑块：角色标签 + 正文 + 思维链 + 工具调用。
function DialogMessage({ msg }: { msg: Record<string, unknown> }) {
  const rawRole = typeof msg["role"] === "string" ? (msg["role"] as string) : "message";
  const meta = ROLE_META[rawRole];
  const label = meta?.label ?? rawRole;
  const cls = meta?.cls ?? "role-other";

  const reasoning = typeof msg["reasoning_content"] === "string" ? msg["reasoning_content"] as string : "";
  const toolCalls = recordList(msg["tool_calls"]);
  const { body, marker } = splitTruncation(contentToText(msg["content"]));

  return (
    <div className={"log-dialog-msg " + cls}>
      <span className="log-dialog-role">{label}</span>
      <div className="log-dialog-content">
        {reasoning && (
          <details className="log-dialog-reasoning">
            <summary>思维链（{reasoning.length} 字符）</summary>
            <pre className="log-dialog-body">{reasoning}</pre>
          </details>
        )}
        {body
          ? <pre className="log-dialog-body">{body}</pre>
          : !reasoning && toolCalls.length === 0 && !marker && <pre className="log-dialog-body empty">（空消息）</pre>}
        {marker && <div className="log-dialog-trunc">{marker}</div>}
        {toolCalls.length > 0 && (
          <div className="log-dialog-tools">
            {toolCalls.map((tc, i) => (
              <pre key={i} className="log-dialog-tool">{toolCallText(tc)}</pre>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RequestLogDetailView({ entry, loading, error, onRequestDialog }: {
  entry?: ReqLogDetail;
  loading: boolean;
  error?: string;
  onRequestDialog: () => void;
}) {
  const [roleFilter, setRoleFilter] = useState("all");
  if (loading) return <div className="log-detail-state"><LoadingIndicator inline label="正在加载详情…" /></div>;
  if (error) return <div className="log-detail-state err">{error}</div>;
  if (!entry) return <div className="log-detail-state">暂无详情</div>;

  const overrides = recordList(entry.parameterOverrides);
  const attempts = recordList(entry.attemptDetails);
  const messages = [
    ...recordList(entry.requestMessages),
    ...(entry.responseMessage && typeof entry.responseMessage === "object" && !Array.isArray(entry.responseMessage)
      ? [entry.responseMessage as Record<string, unknown>] : []),
  ];
  const roles = [...new Set(messages.map((m) => typeof m["role"] === "string" && m["role"] ? m["role"] as string : "message"))];
  const visibleMessages = roleFilter === "all"
    ? messages
    : messages.filter((m) => (typeof m["role"] === "string" && m["role"] ? m["role"] : "message") === roleFilter);
  const dialogLoaded = entry.requestMessages !== undefined || entry.responseMessage !== undefined;
  const hasDialog = Array.isArray(entry.requestMessages) || entry.responseMessage != null;

  return (
    <div className="log-detail">
      <LogSection title="对话记录"
        empty={dialogLoaded && !hasDialog}
        emptyText="未记录（旧日志或已按保留策略清理）">
        {!dialogLoaded ? (
          <div className="log-detail-state">
            <Button type="button" variant="outline" onClick={onRequestDialog}>验证后查看对话</Button>
          </div>
        ) : <>
          <div className="log-role-filter">
            <label className="log-subtle" htmlFor={`dialog-role-${entry.id}`}>角色筛选</label>
            <NativeSelect id={`dialog-role-${entry.id}`} value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}>
              <NativeSelectOption value="all">全部角色（{messages.length}）</NativeSelectOption>
              {roles.map((role) => <NativeSelectOption key={role} value={role}>
                {ROLE_META[role]?.label ?? role}（{messages.filter((m) => (m["role"] || "message") === role).length}）
              </NativeSelectOption>)}
            </NativeSelect>
          </div>
          {visibleMessages.length === 0
            ? <div className="log-detail-empty">当前角色暂无对话内容</div>
            : <div className="log-dialog">
              {visibleMessages.map((m, i) => <DialogMessage key={"m" + i} msg={m} />)}
            </div>}
        </>}
      </LogSection>

      <LogSection title="失败详情" empty={!entry.errorDetail}>
        {entry.errorDetail && <pre className="log-error-detail">{entry.errorDetail}</pre>}
      </LogSection>

      <LogSection title="参数覆盖" empty={!Array.isArray(entry.parameterOverrides)}>
        {overrides.length === 0 ? <div className="log-detail-empty">未发生参数改写</div> : (
          <div className="log-detail-scroll">
            <table className="log-detail-table">
              <thead><tr><th>路径</th><th>原值</th><th>实际值</th></tr></thead>
              <tbody>
                {overrides.map((item, index) => (
                  <tr key={index}>
                    <td className="mono">{valueText(item["path"])}</td>
                    <td><pre>{valueText(item["before"])}</pre></td>
                    <td><pre>{valueText(item["after"])}</pre></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </LogSection>

      <LogSection title={`尝试明细${attempts.length ? `（${attempts.length} 次）` : ""}`}
        empty={!Array.isArray(entry.attemptDetails)}>
        {attempts.length === 0 ? <div className="log-detail-empty">无尝试记录</div> : (
          <div className="log-detail-scroll">
            <table className="log-detail-table attempts">
              <thead><tr>
                <th>次数</th><th>供应商 / UID</th><th>结果</th><th>错误类型</th>
                <th>耗时</th><th>TTFB</th><th>错误详情</th>
              </tr></thead>
              <tbody>
                {attempts.map((item, index) => {
                  const status = Number(item["status"] ?? 0);
                  const errKind = typeof item["errKind"] === "string" ? item["errKind"] : "";
                  const ok = item["ok"] === true || (status < 400 && status > 0 && !errKind);
                  const source = [item["provider"], item["uid"]]
                    .filter((v): v is string => typeof v === "string" && v !== "").join(" / ");
                  return (
                    <tr key={index}>
                      <td className="mono">{String(item["attempt"] ?? index + 1)}</td>
                      <td className="mono wrap">{source || "—"}</td>
                      <td><Badge variant={ok ? "secondary" : "destructive"}>
                        {status > 0 ? status : "—"}{ok ? " 成功" : " 失败"}
                      </Badge></td>
                      <td className="mono wrap">{errKind || "—"}</td>
                      <td className="log-num">{fmtLogMs(Number(item["durationMs"] ?? 0))}</td>
                      <td className="log-num">{fmtLogMs(Number(item["ttfbMs"] ?? 0))}</td>
                      <td>
                        {typeof item["error"] === "string" && item["error"]
                          ? <pre className="log-attempt-error">{item["error"]}</pre>
                          : <span className="dim">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </LogSection>
    </div>
  );
}

export function LogsView({ flash }: { flash: Flash }) {
  const [tab, setTab] = useState<LogMode>("requests");
  const [requestView, setRequestView] = useState<RequestView>("request");
  const mode: ActiveLogMode = tab === "requests" && requestView === "session" ? "sessions" : tab;
  const [ch, setCh] = useState<"all" | "task" | "call" | "probe" | "sys">("all");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [reqs, setReqs] = useState<ReqLog[]>([]);
  const [sessions, setSessions] = useState<RequestLogSessionsPage | null>(null);
  const [filter, setFilter] = useState(EMPTY_REQUEST_FILTER);
  const filterQuery = requestFilterParams(filter);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ReqLogDetail>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [detailAuthId, setDetailAuthId] = useState<string | null>(null);
  const [detailAuthBusy, setDetailAuthBusy] = useState(false);
  const [detailAuthError, setDetailAuthError] = useState("");
  const [activity, setActivity] = useState<LogLoad | null>(null);
  const [loaded, setLoaded] = useState<Partial<Record<ActiveLogMode, { scope: string; at: number }>>>({});
  const [failure, setFailure] = useState<(LogLoad & { message: string }) | null>(null);
  const logViewRef = useRef<HTMLDivElement>(null);
  const [followLogs, setFollowLogs] = useState(true);
  // 增量只在第一页且无过滤时启用，全量读取会重新建立游标。
  const runtimeSinceRef = useRef(0);
  const requestCursorRef = useRef({ at: 0, ids: new Set<string>() });
  const inFlight = useRef<(LogLoad & { controller: AbortController }) | null>(null);
  const previousScope = useRef<LogScope | null>(null);
  const lastPages = useRef<Partial<Record<Exclude<ActiveLogMode, "cache">, { scope: string; page: number }>>>({});
  const [cacheStats, setCacheStats] = useState<CacheStatusSnapshot | null>(null);
  const [pagination, setPagination] = useState({
    runtime: { page: 1, total: 0, totalPages: 1 },
    requests: { page: 1, total: 0, totalPages: 1 },
    sessions: { page: 1, total: 0, totalPages: 1 },
  });
  const runtimePage = pagination.runtime.page;
  const scope = mode === "runtime" ? ch : mode === "cache" ? "" : filterQuery;
  const lastLoadedAt = loaded[mode]?.scope === scope ? loaded[mode]?.at : undefined;
  const currentPage = mode !== "cache" && lastLoadedAt ? pagination[mode].page : 1;
  const currentIssue = failure?.mode === mode && failure.scope === scope ? failure : null;
  const pageFailure = currentIssue?.reason === "page" ? currentIssue : undefined;
  const loadError = currentIssue && !pageFailure ? currentIssue.message : "";
  const foreground = activity?.mode === mode && activity.scope === scope && activity.reason !== "poll" ? activity : null;
  const pendingPage = foreground?.reason === "page" ? foreground.page : undefined;
  const refreshing = foreground?.reason === "refresh";
  const initial = !lastLoadedAt && !loadError;

  const load = useCallback(async (reason: LoadReason, page: number) => {
    const active = inFlight.current;
    if (active && (reason === "poll" || (active.mode === mode && active.scope === scope && active.reason !== "poll"))) return;
    const job = { mode, scope, reason, page, controller: new AbortController() };
    inFlight.current = job;
    active?.controller.abort();
    setActivity(job);
    if (reason !== "poll") setFailure(null);
    const current = () => inFlight.current === job;
    const options = { signal: job.controller.signal };
    try {
      let sampledAt: number | undefined;
      if (mode === "cache") {
        const r = await req<CacheStatusSnapshot>("cache_stats", options);
        if (!current()) return;
        sampledAt = r.at;
        setCacheStats(r);
      } else if (mode === "runtime") {
        const since = reason === "poll" && page === 1 && scope === "all" ? runtimeSinceRef.current : 0;
        const q = new URLSearchParams({ limit: String(RUNTIME_PAGE) });
        if (since) q.set("since", String(since));
        else {
          q.set("page", String(page));
          q.set("channel", scope);
        }
        const r = await req<LogPageResponse<LogEntry>>("logs?" + q.toString(), options);
        if (!current()) return;
        const isDelta = Boolean(since) && r.mode === "delta";
        if (isDelta) {
          setLogs((prev) => mergeRuntime(prev, r.entries));
          if (r.entries.length > 0) setPagination((prev) => {
            const total = prev.runtime.total + r.entries.length;
            return { ...prev, runtime: { ...prev.runtime, total, totalPages: Math.max(1, Math.ceil(total / RUNTIME_PAGE)) } };
          });
        } else {
          setLogs(r.entries);
          lastPages.current.runtime = { scope, page: r.page };
          setPagination((prev) => ({
            ...prev,
            runtime: { page: r.page, total: r.total, totalPages: r.totalPages },
          }));
        }
        const maxTs = r.entries.reduce((m, e) => (e.ts > m ? e.ts : m), 0);
        runtimeSinceRef.current = isDelta ? Math.max(since, maxTs) : maxTs;
      } else if (mode === "sessions") {
        const fetchPage = (target: number) => {
          const q = new URLSearchParams(scope);
          q.set("view", "sessions");
          q.set("page", String(target));
          q.set("limit", String(REQUEST_PAGE));
          return req<RequestLogSessionsPage>("request_logs?" + q.toString(), options);
        };
        let r = await fetchPage(page);
        if (!current()) return;
        if (r.page > r.totalPages) r = await fetchPage(r.totalPages);
        if (!current()) return;
        if (r.page > r.totalPages) throw new Error("日志范围已变化，请重试");
        if (reason === "page" || r.page !== page) setExpanded(null);
        setSessions(r);
        lastPages.current.sessions = { scope, page: r.page };
        setPagination((prev) => ({ ...prev, sessions: { page: r.page, total: r.total, totalPages: r.totalPages } }));
      } else {
        const cursor = requestCursorRef.current;
        const useDelta = reason === "poll" && !scope && page === 1 && cursor.at > 0;
        const fetchPage = (target = page) => {
          const q = new URLSearchParams(scope);
          q.set("page", String(target));
          q.set("limit", String(REQUEST_PAGE));
          return req<LogPageResponse<ReqLog>>("request_logs?" + q.toString(), options);
        };
        const deltaQuery = new URLSearchParams({ since: String(cursor.at), limit: String(REQUEST_PAGE) });
        let r = await (useDelta ? req<LogPageResponse<ReqLog>>("request_logs?" + deltaQuery.toString(), options) : fetchPage());
        if (!current()) return;
        // 增量按时间升序返回；达到上限时重取最新一页，避免在高峰期显示落后的日志。
        if (useDelta && r.mode === "delta" && r.entries.length >= REQUEST_PAGE) r = await fetchPage();
        if (!current()) return;
        // 保留策略可能让末页消失，改读现在存在的最后一页。
        if (r.mode === "page" && r.page > r.totalPages) r = await fetchPage(r.totalPages);
        if (!current()) return;
        if (r.mode === "page" && r.page > r.totalPages) throw new Error("日志范围已变化，请重试");
        const isDelta = useDelta && r.mode === "delta";
        if (isDelta) {
          const added = r.entries.filter((entry) => !cursor.ids.has(entry.id)).length;
          setReqs((prev) => mergeRequests(prev, r.entries));
          if (added > 0) setPagination((prev) => {
            const total = prev.requests.total + added;
            return { ...prev, requests: { ...prev.requests, total, totalPages: Math.max(1, Math.ceil(total / REQUEST_PAGE)) } };
          });
        } else {
          setReqs(r.entries);
          if (reason === "page" || r.page !== page) setExpanded(null);
          lastPages.current.requests = { scope, page: r.page };
          setPagination((prev) => ({
            ...prev,
            requests: { page: r.page, total: r.total, totalPages: r.totalPages },
          }));
        }
        const maxAt = r.entries.reduce((m, e) => {
          const t = Date.parse(e.at);
          return t > m ? t : m;
        }, 0);
        const at = isDelta ? Math.max(cursor.at, maxAt) : maxAt;
        const ids = new Set(isDelta && at === cursor.at ? cursor.ids : []);
        for (const entry of r.entries) if (Date.parse(entry.at) === at) ids.add(entry.id);
        requestCursorRef.current = { at, ids };
      }
      const finishedAt = sampledAt ?? Date.now();
      setLoaded((prev) => ({ ...prev, [mode]: { scope, at: finishedAt } }));
    } catch (e) {
      if (!current() || reason === "poll") return;
      const msg = e instanceof Error ? e.message : String(e);
      setFailure({ mode, scope, reason, page, message: msg });
      if (reason !== "page" && (mode !== "sessions" || reason === "refresh")) flash("err", msg);
    } finally {
      if (current()) {
        inFlight.current = null;
        setActivity(null);
      }
    }
  }, [mode, scope, flash]);
  useEffect(() => {
    const previous = previousScope.current;
    previousScope.current = { mode, scope };
    const remembered = mode === "cache" ? undefined : lastPages.current[mode];
    const page = remembered?.scope === scope ? remembered.page : 1;
    // 分页直接加载，仅输入筛选词时防抖。
    const debounce = (mode === "requests" || mode === "sessions") && previous?.mode === mode && previous.scope !== scope;
    const t = setTimeout(() => { void load("scope", page); }, debounce ? 220 : 0);
    return () => {
      clearTimeout(t);
      const active = inFlight.current;
      if (active?.mode === mode && active.scope === scope) {
        inFlight.current = null;
        active.controller.abort();
      }
    };
  }, [load, mode, scope]);
  const refresh = useCallback(() => { void load("refresh", currentPage); }, [load, currentPage]);
  const poll = useCallback(() => { void load("poll", currentPage); }, [load, currentPage]);
  useAutoRefresh(poll, 60_000, Boolean(lastLoadedAt && !currentIssue) && currentPage === 1);
  usePanelRefresh(refresh);

  const changePage = (page: number) => { void load("page", page); };

  useEffect(() => {
    const view = logViewRef.current;
    if (mode === "runtime" && followLogs && runtimePage === 1 && view) {
      view.scrollTop = view.scrollHeight;
    }
  }, [logs, mode, followLogs, runtimePage]);

  const loadDetail = useCallback(async (id: string): Promise<boolean> => {
    setDetailLoading((prev) => ({ ...prev, [id]: true }));
    setDetailErrors((prev) => ({ ...prev, [id]: "" }));
    try {
      const r = await req<{ entry: ReqLogDetail }>("request_logs/" + encodeURIComponent(id));
      setDetails((prev) => ({ ...prev, [id]: r.entry }));
      return true;
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      if (raw === "request_log_not_found") {
        setDetailErrors((prev) => ({ ...prev, [id]: "该日志已不存在，或已超过保留期。" }));
        return true;
      }
      setDetailErrors((prev) => ({ ...prev, [id]: raw }));
      return false;
    } finally {
      setDetailLoading((prev) => ({ ...prev, [id]: false }));
    }
  }, []);

  const toggleDetail = (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!details[id] && !detailLoading[id]) {
      void loadDetail(id);
    }
  };

  const requestDialog = (id: string) => {
    setDetailAuthError("");
    setDetailAuthId(id);
  };

  const confirmDetailAuth = async (password: string) => {
    if (!detailAuthId) return;
    setDetailAuthBusy(true);
    setDetailAuthError("");
    try {
      const q = new URLSearchParams({ dialog: "1", super_password: password });
      const r = await req<{ entry: ReqLogDetail }>(
        "request_logs/" + encodeURIComponent(detailAuthId) + "?" + q);
      // 只合并受保护的对话字段，保留已显示的普通诊断详情。
      setDetails((prev) => ({
        ...prev,
        [detailAuthId]: {
          ...prev[detailAuthId],
          ...r.entry,
          requestMessages: r.entry.requestMessages,
          responseMessage: r.entry.responseMessage,
        },
      }));
      setDetailAuthId(null);
    } catch {
      setDetailAuthError("验证失败，请检查超级密码后重试");
    } finally {
      setDetailAuthBusy(false);
    }
  };

  const closeRequest = () => setExpanded(null);
  const detail = {
    expanded,
    onToggle: toggleDetail,
    renderDetail: (id: string) => <RequestLogDetailView
      entry={details[id]}
      loading={!!detailLoading[id]}
      error={detailErrors[id] || undefined}
      onRequestDialog={() => requestDialog(id)}
    />,
  };
  const switchRequestView = (next: RequestView) => {
    if (next === requestView) return;
    closeRequest();
    setRequestView(next);
  };
  const requestListing = requestView === "request" ? pagination.requests : pagination.sessions;

  return (
    <>
      <Tabs className="logs-console" value={tab} onValueChange={(value) => {
        if (value === "requests" || value === "runtime" || value === "cache") {
          closeRequest();
          setTab(value);
        }
      }}>
        <header className="log-toolbar">
          <TabsList variant="line" aria-label="日志类别" className="log-mode-tabs">
            <TabsTrigger value="requests"><FileTextIcon />请求日志</TabsTrigger>
            <TabsTrigger value="runtime"><TerminalIcon />运行日志</TabsTrigger>
            <TabsTrigger value="cache"><DatabaseIcon />缓存状态</TabsTrigger>
          </TabsList>
          <div className="log-toolbar-actions">
            <span className="log-subtle log-num" role="status" title={loadError || undefined}>
              {loadError ? "刷新失败" : lastLoadedAt ? `${mode === "cache" ? "采集于" : "更新于"} ${fmtClock(lastLoadedAt)}` : ""}
            </span>
            <Button type="button" variant="outline" disabled={initial || Boolean(foreground)} aria-busy={refreshing} onClick={refresh}>
              {!refreshing && <RefreshCwIcon data-icon="inline-start" />}
              <ButtonLoadingContent loading={refreshing} loadingChildren="刷新中…">刷新</ButtonLoadingContent>
            </Button>
          </div>
        </header>

        <TabsContent value="requests">
          <RequestLogFilters filter={filter} onChange={(next) => {
            if (requestFilterParams(next) !== filterQuery) closeRequest();
            setFilter(next);
          }} />
          <div className="log-summary-bar">
            <RequestLogSummary summary={!lastLoadedAt ? null : requestView === "request"
              ? summarizeRequestPage(reqs) : summarizeRequestSessions(sessions?.entries ?? [])} />
            <div className="log-request-switch" role="group" aria-label="请求日志视图">
              <Button type="button" variant="ghost" size="sm" aria-pressed={requestView === "request"}
                onClick={() => switchRequestView("request")}>请求</Button>
              <Button type="button" variant="ghost" size="sm" aria-pressed={requestView === "session"}
                onClick={() => switchRequestView("session")}>会话</Button>
            </div>
          </div>
          <div aria-busy={Boolean(lastLoadedAt && foreground)}>
            {requestView === "request"
              ? <RequestLogTable {...detail} rows={lastLoadedAt ? reqs : []}
                filtered={Boolean(filterQuery)} initial={initial} error={loadError} />
              : <RequestLogSessions key={currentPage + ":" + filterQuery}
                entries={lastLoadedAt ? sessions?.entries ?? [] : []} scope={lastLoadedAt ? sessions?.scope : undefined}
                filterQuery={filterQuery} initial={initial} error={loadError}
                detail={detail} onCloseRequest={closeRequest} />}
          </div>
          {lastLoadedAt && requestListing.total > 0 && (
            <LogPagination {...requestListing} unit={requestView === "session" ? "组" : "条"} pageSize={REQUEST_PAGE} pendingPage={pendingPage}
              blocked={Boolean(foreground)} failure={pageFailure} onPageChange={changePage} />
          )}
        </TabsContent>

        <TabsContent value="runtime" className="log-runtime">
          <div className="log-runtime-controls">
            <NativeSelect aria-label="运行日志频道" value={ch} onChange={(e) => setCh(e.target.value as typeof ch)}>
              <NativeSelectOption value="all">全部频道</NativeSelectOption>
              <NativeSelectOption value="task">任务</NativeSelectOption>
              <NativeSelectOption value="call">调用</NativeSelectOption>
              <NativeSelectOption value="probe">探测</NativeSelectOption>
              <NativeSelectOption value="sys">系统</NativeSelectOption>
            </NativeSelect>
          </div>
          <div ref={logViewRef} className="logview" dir="ltr" aria-busy={Boolean(lastLoadedAt && foreground)} onScroll={(e) => {
            const view = e.currentTarget;
            setFollowLogs(view.scrollHeight - view.scrollTop - view.clientHeight < 36);
          }}>
            {initial ? <LogListLoading label="正在加载运行日志…" terminal /> : (!lastLoadedAt || logs.length === 0) && (
              <div className="log-runtime-empty" role={loadError ? "alert" : undefined}>{loadError || "暂无运行日志"}</div>
            )}
            {lastLoadedAt && logs.map((l, i) => (
              <div key={l.id ?? i} className={"ln" + (/error|失败|错误/.test(l.text) ? " e" : /warn|冷却|熔断/.test(l.text) ? " w" : "")}>{
                fmtClock(l.ts)
              } <span className={"lch c-" + l.ch}>{
                { task: "任务", chat: "对话", call: "调用", probe: "探测", sys: "系统" }[l.ch]
              }</span> {l.text}</div>
            ))}
          </div>
          {lastLoadedAt && pagination.runtime.total > 0 && (
            <LogPagination {...pagination.runtime} pageSize={RUNTIME_PAGE} pendingPage={pendingPage}
              blocked={Boolean(foreground)} failure={pageFailure} onPageChange={changePage} />
          )}
        </TabsContent>

        <TabsContent value="cache" aria-busy={Boolean(foreground)}>
          <CacheStatusPanel stats={cacheStats} initial={initial} error={loadError} />
        </TabsContent>
      </Tabs>

      {detailAuthId && <SuperPasswordModal
        title="查看对话记录"
        description="验证超级密码后查看本次请求与回复的对话内容。密码仅用于本次请求，不会保存。"
        confirmText="验证并查看"
        busy={detailAuthBusy}
        error={detailAuthError}
        onCancel={() => { if (!detailAuthBusy) { setDetailAuthId(null); setDetailAuthError(""); } }}
        onConfirm={confirmDetailAuth}
      />}
    </>
  );
}
