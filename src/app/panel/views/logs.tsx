"use client";
// 运行日志视图（对齐 Go view-logs）：请求日志 / 运行日志双模式 + 过滤。
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
  requestMessages?: unknown;
  responseMessage?: unknown;
  errorDetail?: string;
  parameterOverrides?: unknown;
  attemptDetails?: unknown;
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
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

function roleOf(value: unknown): string {
  const role = recordValue(value)?.role;
  return typeof role === "string" && role ? role : "unknown";
}

function roleLabel(role: string): string {
  const labels: Record<string, string> = {
    system: "系统", developer: "开发者", user: "用户", assistant: "助手", tool: "工具",
  };
  return labels[role] ?? role;
}

function roleClass(role: string): string {
  return ["system", "developer", "user", "assistant", "tool"].includes(role)
    ? role : "other";
}

function messageExtras(message: Record<string, unknown>): Record<string, unknown> {
  const out = { ...message };
  delete out.role;
  delete out.content;
  return out;
}

function responseExtras(message: Record<string, unknown>): Record<string, unknown> {
  const out = messageExtras(message);
  delete out.reasoning_content;
  delete out.tool_calls;
  return out;
}

function LogSection({ title, empty, children }: {
  title: string;
  empty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="log-detail-section">
      <div className="log-detail-title">{title}</div>
      {empty ? <div className="log-detail-empty">旧日志未记录此项</div> : children}
    </section>
  );
}

function MessageBody({ message }: { message: Record<string, unknown> }) {
  const content = message["content"];
  const extras = messageExtras(message);
  const hasExtras = Object.keys(extras).length > 0;
  return (
    <>
      <pre className="log-message-body">{valueText(content)}</pre>
      {hasExtras && (
        <details className="log-message-extra">
          <summary>附加字段</summary>
          <pre>{valueText(extras)}</pre>
        </details>
      )}
    </>
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

  const messages = recordList(entry.requestMessages);
  const response = recordValue(entry.responseMessage);
  const overrides = recordList(entry.parameterOverrides);
  const attempts = recordList(entry.attemptDetails);
  const responseTools = response && Array.isArray(response["tool_calls"])
    ? response["tool_calls"] : [];
  const responseExtra = response ? responseExtras(response) : {};

  return (
    <div className="log-detail">
      <LogSection title={`请求对话${messages.length ? `（${messages.length} 条）` : ""}`}
        empty={!Array.isArray(entry.requestMessages)}>
        {messages.length === 0 ? <div className="log-detail-empty">无对话消息</div> : (
          <div className="log-message-list">
            {messages.map((message, index) => {
              const role = roleOf(message);
              return (
                <div className="log-message" key={index}>
                  <div className="log-message-head">
                    <span className={"tag log-role " + roleClass(role)}>{roleLabel(role)}</span>
                    <span className="dim mono">#{index + 1}</span>
                  </div>
                  <MessageBody message={message} />
                </div>
              );
            })}
          </div>
        )}
      </LogSection>

      <LogSection title="助手回复" empty={!response}>
        {response && (
          <div className="log-message response">
            <div className="log-message-head">
              <span className={"tag log-role " + roleClass(roleOf(response))}>
                {roleLabel(roleOf(response))}
              </span>
            </div>
            <pre className="log-message-body">{valueText(response["content"])}</pre>
            {typeof response["reasoning_content"] === "string"
              && response["reasoning_content"] !== "" && (
                <div className="log-subsection">
                  <div className="log-subtitle">推理内容</div>
                  <pre className="log-message-body">{response["reasoning_content"]}</pre>
                </div>
              )}
            {responseTools.length > 0 && (
              <div className="log-subsection">
                <div className="log-subtitle">工具调用</div>
                <pre className="log-message-body">{valueText(responseTools)}</pre>
              </div>
            )}
            {Object.keys(responseExtra).length > 0 && (
              <details className="log-message-extra">
                <summary>附加字段</summary>
                <pre>{valueText(responseExtra)}</pre>
              </details>
            )}
          </div>
        )}
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
  const [mode, setMode] = useState<"runtime" | "requests">("runtime");
  const [ch, setCh] = useState<"all" | "task" | "call" | "probe" | "sys">("all");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [reqs, setReqs] = useState<ReqLog[]>([]);
  const [filter, setFilter] = useState({ account: "", model: "", outcome: "", key: "", err: "" });
  const [ipFilter, setIpFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, ReqLogDetail>>({});
  const [detailLoading, setDetailLoading] = useState<Record<string, boolean>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const logViewRef = useRef<HTMLDivElement>(null);
  const [followLogs, setFollowLogs] = useState(true);

  const load = useCallback(() => {
    if (mode === "runtime") {
      req<{ entries: LogEntry[] }>("logs").then((r) => setLogs(r.entries.filter((e) => ch === "all" || e.ch === ch)))
        .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
    } else {
      const q = new URLSearchParams();
      if (filter.account) q.set("account", filter.account);
      if (filter.model) q.set("model", filter.model);
      if (filter.outcome) q.set("outcome", filter.outcome);
      if (filter.key) q.set("key", filter.key);
      if (filter.err) q.set("err", filter.err);
      if (ipFilter) q.set("client_ip", ipFilter);
      req<{ entries: ReqLog[] }>("request_logs?" + q.toString()).then((r) => setReqs(r.entries))
        .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
    }
  }, [mode, filter, ch, ipFilter, flash]);
  useEffect(load, [load]);
  useAutoRefresh(load, 10_000);
  usePanelRefresh(load);

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
        const msg = e instanceof Error ? e.message : String(e);
        setDetailErrors((prev) => ({ ...prev, [id]: msg }));
        flash("err", msg);
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
    <Box title={mode === "requests" ? "请求日志" : "运行日志"} extra={<>
      <button className={"btn xs" + (mode === "requests" ? " primary" : "")} onClick={() => setMode("requests")}>请求日志</button>
      <button className={"btn xs" + (mode === "runtime" ? " primary" : "")} onClick={() => setMode("runtime")}>运行日志</button>
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
      <button className="btn xs" onClick={load}>刷新</button>
      {mode === "runtime" && <>
        <select className="select" style={{ width: 104 }} value={ch}
          onChange={(e) => setCh(e.target.value as typeof ch)}>
          <option value="all">全部频道</option><option value="task">任务</option>
          <option value="call">调用</option><option value="probe">探测</option>
          <option value="sys">系统</option>
        </select>
      </>}
    </>}>
      {mode === "runtime" ? (
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
