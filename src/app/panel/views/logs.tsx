"use client";
// 运行日志视图（对齐 Go view-logs）：请求日志 / 运行日志 / 缓存详细 三模式 + 过滤。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { req, fmtNum, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";
import { errKindLabel, knownText, uaDisplay } from "@/lib/logfmt";

interface LogEntry {
  id?: string;
  ts: number;
  ch: "task" | "chat" | "call" | "probe" | "sys";
  text: string;
}
interface ReqLog {
  id: string; at: string; uid: string; model: string; status: number;
  durationMs: number; errKind: string; clientIp: string; ua: string;
  realm: string; provider: string; stream: boolean;
  ttfbMs?: number; attempts?: number;
  promptTokens?: number; completionTok?: number; totalTokens?: number;
  credit?: number; hasCredit?: boolean;
  cacheHitTok?: number; cacheMissTok?: number;
  keyName?: string; slot?: string; machineId?: string; path?: string;
  // 报错内容：失败请求的上游响应正文摘要（成功请求为空）。
  errMsg?: string;
}
interface ReqLogDetail extends ReqLog {
  errorDetail?: string;
  parameterOverrides?: unknown;
  attemptDetails?: unknown;
  requestMessages?: unknown;
  responseMessage?: unknown;
}

interface CacheLayer {
  name: string;
  scope: string;
  ttlMs: number;
  maxEntries?: number;
  size: number | null;
  entries: { key: string; ttlMs: number }[];
  note?: string;
  visible: boolean;
  cached?: boolean;
  remainingMs?: number;
}
interface CacheStatsResp {
  at: number;
  layers: CacheLayer[];
}

// fmtTok token 缩写（Go app.js fmtTok 同口径）：1000+ 用 k 缩写避免表列撑宽。
function fmtTok(n: number): string {
  if (!n || n <= 0) return "—";
  return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(n);
}
function fmtMs(n: number | null | undefined): string {
  return n && n > 0 ? n + "ms" : "—";
}
function fmtCredit(v: number | null | undefined, known: boolean | undefined): string {
  if (!known) return "—";
  return Number.isFinite(v) ? String(Number((v ?? 0).toFixed(2))) : "—";
}

// uaSummary UA 指纹摘要（Go app.js:1130 同口径）：解析常见客户端族，
// 完整 UA 放 title / 展开区，表列只给一眼能扫的短标签。
function uaSummary(ua: string): string {
  const s = ua || "";
  if (!s) return "";
  const m: [RegExp, string | null][] = [
    [/Claude\/?(\d[\w.]*)/i, "Claude $1"], [/Claude-Code\/([\w.]+)/i, "Claude Code $1"],
    [/Codex(?:CLI)?[\/ ]([\w.]+)/i, "Codex $1"], [/CherryStudio\/([\w.]+)/i, "Cherry Studio $1"],
    [/Cline\/([\w.]+)/i, "Cline $1"], [/OpenAI\/(\w+[\w.]*)/i, "OpenAI $1"],
    [/python-requests\/([\w.]+)/i, "Python requests $1"], [/Python\/([\w.]+)/i, "Python $1"],
    [/node(?:-fetch)?\/([\w.]+)/i, "Node $1"], [/curl\/([\w.]+)/i, "curl $1"],
    [/PostmanRuntime\/([\w.]+)/i, "Postman $1"], [/Go-http-client\/([\w.]+)/i, "Go $1"],
    [/Mozilla\/[\d.]+\s*\(([^)]+)\)/, null],
  ];
  for (const [re, tpl] of m) {
    const x = s.match(re);
    if (x) return tpl === null ? x[1].split(/[;)]/)[0].trim() : tpl.replace("$1", x[1]);
  }
  return s.split(/[\s;,]/)[0].slice(0, 18);
}

// 机器码展示：36 位派生值只露前 8 位（面板可扫），完整值在展开区。
function machineShort(id: string | undefined): string {
  return id ? id.slice(0, 8) : "";
}

// ── 缓存详细面板 ────────────────────────────────────────────────────────────
// 展示进程内各层缓存的实时状态：条目数、剩余 TTL、命中情况。
// 数据来自 GET /api/panel/cache_stats，不经过 reqCached（这个页面本身就该看实时值）。
function fmtTtl(ms: number): string {
  if (ms <= 0) return "已过期";
  const s = Math.ceil(ms / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60 > 0 ? " " + (s % 60) + "s" : "");
  return Math.floor(s / 3600) + "h" + (Math.floor((s % 3600) / 60) > 0 ? Math.floor((s % 3600) / 60) + "m" : "");
}

function CachePanel({ stats, loading }: {
  stats: CacheStatsResp | null;
  loading: boolean;
}) {
  if (!stats && loading) return <div className="pad dim">读取缓存状态中…</div>;
  if (!stats) return <div className="pad dim">暂无数据</div>;
  const at = new Date(stats.at).toLocaleTimeString("zh-CN", { hour12: false });
  return (
    <div className="pad" style={{ display: "grid", gap: 16 }}>
      <div className="dim" style={{ fontSize: 12 }}>
        采集于 {at} · 服务端进程内缓存实时状态（前端 reqCached 为浏览器内存，服务端不可见条目）
      </div>
      {stats.layers.map((layer) => (
        <div key={layer.name} style={{
          border: "1px solid var(--border)", borderRadius: 10,
          padding: "14px 16px", background: "var(--bg-soft)",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{layer.name}</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="tag">{layer.scope}</span>
              {layer.cached !== undefined && (
                <span className={"tag " + (layer.cached ? "ok" : "err")}>
                  {layer.cached ? "已缓存" : "未缓存"}
                </span>
              )}
            </div>
          </div>
          <div className="kv-grid" style={{ marginBottom: layer.entries.length > 0 ? 10 : 0 }}>
            <span className="dim">TTL</span><span>{fmtTtl(layer.ttlMs)}</span>
            {layer.maxEntries !== undefined && <>
              <span className="dim">容量</span><span>{layer.size ?? 0} / {layer.maxEntries} 条</span>
            </>}
            {layer.remainingMs !== undefined && <>
              <span className="dim">剩余有效期</span><span>{fmtTtl(layer.remainingMs)}</span>
            </>}
            {layer.note && <>
              <span className="dim">说明</span><span style={{ fontSize: 12, lineHeight: 1.5 }}>{layer.note}</span>
            </>}
          </div>
          {layer.entries.length > 0 && (
            <table className="tbl" style={{ marginTop: 8 }}>
              <thead><tr><th>缓存键</th><th>剩余 TTL</th></tr></thead>
              <tbody>
                {layer.entries.map((e) => (
                  <tr key={e.key}>
                    <td className="mono" style={{ wordBreak: "break-all" }}>{e.key}</td>
                    <td className="mono">{fmtTtl(e.ttlMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {layer.visible && layer.entries.length === 0 && (
            <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>当前无活跃缓存条目</div>
          )}
        </div>
      ))}
    </div>
  );
}


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
      <div className="log-detail-title">{title}</div>
      {empty ? <div className="log-detail-empty">{emptyText ?? "旧日志未记录此项"}</div> : children}
    </section>
  );
}

// 把一条对话消息渲染成紧凑块：角色标签 + 正文（多模态/工具调用折叠为 JSON）。
function DialogMessage({ msg }: { msg: Record<string, unknown> }) {
  const role = typeof msg["role"] === "string" ? (msg["role"] as string) : "message";
  const content = msg["content"];
  return (
    <div className={"log-dialog-msg role-" + role}>
      <span className="log-dialog-role">{role}</span>
      <pre className="log-dialog-body">{valueText(content)}</pre>
    </div>
  );
}

function RequestLogDetailView({ entry, loading, error }: {
  entry?: ReqLogDetail;
  loading: boolean;
  error?: string;
}) {
  if (loading) return <div className="log-detail-state">正在加载详情…</div>;
  if (error) return <div className="log-detail-state err">{error}</div>;
  if (!entry) return <div className="log-detail-state">暂无详情</div>;

  const overrides = recordList(entry.parameterOverrides);
  const attempts = recordList(entry.attemptDetails);

  return (
    <div className="log-detail">
      <LogSection title="对话记录"
        empty={!Array.isArray(entry.requestMessages) && entry.responseMessage == null}
        emptyText="未记录（旧日志或已按保留策略清理）">
        <div className="log-dialog">
          {recordList(entry.requestMessages).map((m, i) => <DialogMessage key={"q" + i} msg={m} />)}
          {entry.responseMessage && typeof entry.responseMessage === "object" && !Array.isArray(entry.responseMessage)
            ? <DialogMessage msg={{ role: "assistant", content: (entry.responseMessage as Record<string, unknown>)["content"] ?? entry.responseMessage }} />
            : null}
        </div>
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
                    .filter((v): v is string => typeof v === "string" && v !== "").join(" · ");
                  return (
                    <tr key={index}>
                      <td className="mono">{String(item["attempt"] ?? index + 1)}</td>
                      <td className="mono wrap">{source || "—"}</td>
                      <td><span className={"tag " + (ok ? "ok" : "err")}>
                        {status > 0 ? status : "—"}{ok ? " 成功" : " 失败"}
                      </span></td>
                      <td className="mono wrap">{errKind || "—"}</td>
                      <td className="mono">{fmtMs(Number(item["durationMs"] ?? 0))}</td>
                      <td className="mono">{fmtMs(Number(item["ttfbMs"] ?? 0))}</td>
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
  const [mode, setMode] = useState<"runtime" | "requests" | "cache">("runtime");
  const [ch, setCh] = useState<"all" | "task" | "call" | "probe" | "sys">("all");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [reqs, setReqs] = useState<ReqLog[]>([]);
  const [filter, setFilter] = useState({ account: "", model: "", outcome: "", key: "", err: "" });
  const [ipFilter, setIpFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ReqLogDetail>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState("");
  const logViewRef = useRef<HTMLDivElement>(null);
  const [followLogs, setFollowLogs] = useState(true);
  // 增量游标（ms）：轮询只取游标之后的新行；手动刷新 / 改过滤 / 切模式时归零全量重拉。
  const runtimeSinceRef = useRef(0);
  const reqSinceRef = useRef(0);
  const requestSeqRef = useRef(0);
  const [cacheStats, setCacheStats] = useState<CacheStatsResp | null>(null);

  const load = useCallback(async (delta = false) => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setLoadError("");
    try {
      if (mode === "cache") {
        const r = await req<CacheStatsResp>("cache_stats");
        if (seq !== requestSeqRef.current) return;
        setCacheStats(r);
      } else if (mode === "runtime") {
        const since = delta ? runtimeSinceRef.current : 0;
        const r = await req<{ entries: LogEntry[]; mode?: string }>("logs" + (since ? "?since=" + since : ""));
        if (seq !== requestSeqRef.current) return;
        const incoming = r.entries.filter((e) => ch === "all" || e.ch === ch);
        if (since && r.mode === "delta") setLogs((prev) => mergeRuntime(prev, incoming));
        else setLogs(incoming);
        const maxTs = r.entries.reduce((m, e) => (e.ts > m ? e.ts : m), 0);
        if (maxTs > runtimeSinceRef.current) runtimeSinceRef.current = maxTs;
      } else {
        const q = new URLSearchParams();
        if (filter.account) q.set("account", filter.account);
        if (filter.model) q.set("model", filter.model);
        if (filter.outcome) q.set("outcome", filter.outcome);
        if (filter.key) q.set("key", filter.key);
        if (filter.err) q.set("err", filter.err);
        if (ipFilter) q.set("client_ip", ipFilter);
        // 只有无过滤且已有游标时才走增量：过滤条件变化必须全量重查，
        // 否则会把「旧页里不满足新条件下拉」的行继续留在表上。
        const filtered = !!(filter.account || filter.model || filter.outcome ||
          filter.key || filter.err || ipFilter);
        const useDelta = delta && !filtered && reqSinceRef.current > 0;
        if (useDelta) q.set("since", String(reqSinceRef.current));
        const r = await req<{ entries: ReqLog[]; mode?: string }>("request_logs?" + q.toString());
        if (seq !== requestSeqRef.current) return;
        if (useDelta && r.mode === "delta") setReqs((prev) => mergeRequests(prev, r.entries));
        else setReqs(r.entries);
        const maxAt = r.entries.reduce((m, e) => {
          const t = Date.parse(e.at);
          return t > m ? t : m;
        }, 0);
        if (maxAt > reqSinceRef.current) reqSinceRef.current = maxAt;
      }
      setLastLoadedAt(Date.now());
    } catch (e) {
      if (seq !== requestSeqRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setLoadError(msg);
      flash("err", msg);
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [mode, filter, ch, ipFilter, flash]);
  useEffect(() => {
    runtimeSinceRef.current = 0;
    reqSinceRef.current = 0;
    const t = setTimeout(() => { void load(false); }, 0);
    return () => clearTimeout(t);
  }, [load]);
  useAutoRefresh(() => { void load(true); }, 30_000);
  usePanelRefresh(() => { void load(false); });

  useEffect(() => {
    const view = logViewRef.current;
    if (mode === "runtime" && followLogs && view) {
      view.scrollTop = view.scrollHeight;
    }
  }, [logs, mode, followLogs]);

  const loadDetail = useCallback((id: string) => {
    setDetailLoading((prev) => ({ ...prev, [id]: true }));
    setDetailErrors((prev) => ({ ...prev, [id]: "" }));
    req<{ entry: ReqLogDetail }>("request_logs/" + encodeURIComponent(id))
      .then((r) => {
        setDetails((prev) => ({ ...prev, [id]: r.entry }));
      })
      .catch((e) => {
        const raw = e instanceof Error ? e.message : String(e);
        // 详情为空时保留当前日志行与展开状态，仅展示空状态文案。
        if (raw === "request_log_not_found") {
          setDetailErrors((prev) => ({ ...prev, [id]: "暂无相关" }));
        } else {
          setDetailErrors((prev) => ({ ...prev, [id]: raw }));
          flash("err", raw);
        }
      })
      .finally(() => {
        setDetailLoading((prev) => ({ ...prev, [id]: false }));
      });
  }, [flash]);

  const toggleDetail = (id: string) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!details[id] && !detailLoading[id]) loadDetail(id);
  };

  return (
    <Box title={mode === "requests" ? "请求日志" : mode === "cache" ? "缓存详细" : "运行日志"} extra={<>
      <button className={"btn xs" + (mode === "requests" ? " primary" : "")} onClick={() => setMode("requests")}>请求日志</button>
      <button className={"btn xs" + (mode === "runtime" ? " primary" : "")} onClick={() => setMode("runtime")}>运行日志</button>
      <button className={"btn xs" + (mode === "cache" ? " primary" : "")} onClick={() => setMode("cache")}>缓存详细</button>
      {mode === "requests" && <>
        <input className="input" style={{ width: 130 }} placeholder="账号过滤" value={filter.account}
          onChange={(e) => setFilter({ ...filter, account: e.target.value })} />
        <input className="input" style={{ width: 130 }} placeholder="模型过滤" value={filter.model}
          onChange={(e) => setFilter({ ...filter, model: e.target.value })} />
        <select className="select" style={{ width: 104 }} value={filter.outcome}
          onChange={(e) => setFilter({ ...filter, outcome: e.target.value })}>
          <option value="">全部结果</option><option value="ok">仅成功</option><option value="error">仅失败</option>
        </select>
        <input className="input" style={{ width: 110 }} placeholder="IP 过滤" value={ipFilter}
          onChange={(e) => setIpFilter(e.target.value)} />
        <input className="input" style={{ width: 110 }} placeholder="Key 过滤" value={filter.key}
          onChange={(e) => setFilter({ ...filter, key: e.target.value })} />
        <input className="input" style={{ width: 150 }} placeholder="报错内容过滤" value={filter.err}
          title="按上游报错正文检索，如 12153 / rate limit / WAF"
          onChange={(e) => setFilter({ ...filter, err: e.target.value })} />
      </>}
      <span className="dim" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
        {loading ? "正在刷新…" : loadError ? "刷新失败，请重试" : lastLoadedAt
          ? `更新于 ${new Date(lastLoadedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
          : "等待加载"}
      </span>
      <button className="btn xs" disabled={loading} onClick={() => { void load(false); }}>
        {loading ? "刷新中…" : "刷新"}
      </button>
      {mode === "runtime" && <>
        <select className="select" style={{ width: 104 }} value={ch}
          onChange={(e) => setCh(e.target.value as typeof ch)}>
          <option value="all">全部频道</option><option value="task">任务</option>
          <option value="call">调用</option><option value="probe">探测</option>
          <option value="sys">系统</option>
        </select>
      </>}
    </>}>
      {mode === "cache" ? (
        <CachePanel stats={cacheStats} loading={loading} />
      ) : mode === "runtime" ? (
        <div className="pad">
          <div
            ref={logViewRef}
            className="logview"
            onScroll={(e) => {
              const view = e.currentTarget;
              const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 36;
              setFollowLogs(atBottom);
            }}>
            {logs.length === 0 && <div style={{ color: "#64748b" }}>暂无运行日志</div>}
            {logs.map((l, i) => (
              <div key={l.id ?? i} className={"ln" + (/error|失败|错误/.test(l.text) ? " e" : /warn|冷却|熔断/.test(l.text) ? " w" : "")}>{
                new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false })
              } <span className={"lch c-" + l.ch}>{
                { task: "任务", chat: "对话", call: "调用", probe: "探测", sys: "系统" }[l.ch]
              }</span> {l.text}</div>
            ))}
          </div>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl tbl-logs">
            {/* 列结构对齐 Go index.html:1253 的请求日志 13 列，另加机器码列（本版采集维度）。 */}
            <thead><tr>
              <th>时间</th><th>结果</th><th>模型</th><th>账号</th><th>来源 IP</th><th>User-Agent</th>
              <th>机器码</th><th>Key 归属</th><th>供应商槽位</th><th>耗时</th><th>TTFB</th>
              <th>Token</th><th>积分</th><th>请求 ID</th><th style={{ width: 1 }}></th>
            </tr></thead>
            <tbody>
              {reqs.length === 0 && <tr><td colSpan={15} className="dim" style={{ textAlign: "center", padding: 20 }}>暂无请求日志</td></tr>}
              {reqs.map((r) => {
                const open = expanded === r.id;
                const total = r.totalTokens || ((r.promptTokens ?? 0) + (r.completionTok ?? 0));
                // 展示层先折叠上游/客户端发来的占位值（unknown/null/…），DB 原文不动。
                const uaText = uaDisplay(knownText(r.ua));
                const uaS = uaSummary(uaText);
                const mid = machineShort(knownText(r.machineId));
                const modelText = knownText(r.model);
                const uidText = knownText(r.uid);
                const ipText = knownText(r.clientIp);
                const keyText = knownText(r.keyName);
                const providerText = knownText(r.provider);
                const slotText = knownText(r.slot);
                const realmText = knownText(r.realm);
                const errText = knownText(r.errMsg);
                const kindLabel = errKindLabel(r.errKind);
                return (
                  <React.Fragment key={r.id}>
                    <tr onClick={() => toggleDetail(r.id)}
                      aria-expanded={open}
                      style={{ cursor: "pointer", ...(open ? { background: "var(--bg-soft)" } : {}) }}>
                      <td className="dim mono">{new Date(r.at).toLocaleTimeString("zh-CN", { hour12: false })}</td>
                      <td><span className={"tag " + (r.status < 400 && !kindLabel ? "ok" : "err")}
                        title={errText || undefined}>
                        {r.status}{kindLabel ? " " + kindLabel : r.status < 400 ? " 成功" : " 错误"}
                        {errText ? " · 报错" : ""}</span></td>
                      <td className="mono">{modelText || <span className="dim">—</span>}</td>
                      <td className="mono">{uidText || <span className="dim">—</span>}</td>
                      <td className="mono">{ipText || <span className="dim">—</span>}</td>
                      <td title={uaText || undefined} style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {uaS || <span className="dim">—</span>}
                      </td>
                      <td className="mono" title={knownText(r.machineId) || undefined}>{mid || <span className="dim">—</span>}</td>
                      <td>{keyText ? <span className="tag">{keyText}</span> : <span className="dim">—</span>}</td>
                      <td>{providerText
                        ? <span className="mono" title={providerText + (slotText ? " · " + slotText : "")}>
                          {providerText}{slotText ? " · " + slotText : ""}</span>
                        : (realmText ? <span className="tag">{realmText === "global" ? "国际版池" : "国内版池"}</span> : <span className="dim">—</span>)}</td>
                      <td className="mono">{fmtMs(r.durationMs)}</td>
                      <td className="mono">{r.stream ? fmtMs(r.ttfbMs) : <span className="dim">—</span>}</td>
                      <td className="mono" title={r.totalTokens
                        ? String(r.totalTokens)
                        : ((r.promptTokens ?? 0) > 0 || (r.completionTok ?? 0) > 0
                          ? `${r.promptTokens} + ${r.completionTok}` : undefined)}>
                        {total > 0 ? fmtTok(total) : <span className="dim">—</span>}</td>
                      <td className="mono">{fmtCredit(r.credit, r.hasCredit)}</td>
                      <td className="mono" title={r.id} style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.id.slice(0, 10) + "…"}
                      </td>
                      <td><span className="dim" style={{ fontSize: 12 }}>{open ? "▲" : "▼"}</span></td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={15} style={{ background: "var(--bg-soft)", padding: "10px 16px" }}>
                          <div className="kv-grid">
                            <span className="dim">请求 ID</span><span className="mono">{r.id}</span>
                            <span className="dim">时间</span><span>{new Date(r.at).toLocaleString("zh-CN", { hour12: false })}</span>
                            <span className="dim">状态 / 结果</span><span>{r.status}{kindLabel ? " · " + kindLabel : r.status < 400 ? " · 成功" : " · 错误"}</span>
                            <span className="dim">流式</span><span>{r.stream ? "SSE" : "一次性"}</span>
                            <span className="dim">账号 UID</span><span className="mono">{uidText || "—"}</span>
                            <span className="dim">机器码（完整）</span><span className="mono">{knownText(r.machineId) || "—"}</span>
                            <span className="dim">Key 归属</span><span>{keyText || "—"}</span>
                            <span className="dim">供应商槽位</span><span>{providerText ? providerText + (slotText ? " · " + slotText : "") : (realmText || "—")}</span>
                            <span className="dim">模型</span><span className="mono">{modelText || "—"}</span>
                            <span className="dim">路径</span><span className="mono">{knownText(r.path) || "—"}</span>
                            <span className="dim">轮转尝试</span><span>{r.attempts ? r.attempts + " 次" : "—"}</span>
                            <span className="dim">运行时长 / TTFB</span><span>{fmtMs(r.durationMs)}{r.stream ? " / " + fmtMs(r.ttfbMs) : ""}</span>
                            <span className="dim">Token</span><span>{total > 0
                              ? `${fmtNum(total)}（in ${fmtNum(r.promptTokens ?? 0)} · out ${fmtNum(r.completionTok ?? 0)}）` : "—"}</span>
                            <span className="dim">积分</span><span>{fmtCredit(r.credit, r.hasCredit)}{r.hasCredit ? " pts" : ""}</span>
                            <span className="dim">缓存命中</span><span>{(r.cacheHitTok ?? 0) > 0 || (r.cacheMissTok ?? 0) > 0
                              ? `hit ${fmtNum(r.cacheHitTok ?? 0)} · miss ${fmtNum(r.cacheMissTok ?? 0)}` : "—"}</span>
                            {errText && <>
                              <span className="dim">报错内容</span>
                              <span className="mono" style={{ wordBreak: "break-word", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{errText}</span>
                            </>}
                            <span className="dim">客户端 IP</span><span className="mono">{ipText || "—"}</span>
                            <span className="dim">User-Agent</span><span style={{ wordBreak: "break-all" }}>{uaText || "—"}</span>
                          </div>
                          <RequestLogDetailView
                            entry={details[r.id]}
                            loading={!!detailLoading[r.id]}
                            error={detailErrors[r.id] || undefined}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Box>
  );
}
