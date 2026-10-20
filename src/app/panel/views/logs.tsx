"use client";
// 运行日志视图（对齐 Go view-logs）：请求日志 / 运行日志双模式 + 过滤。
import React, { useCallback, useEffect, useState } from "react";
import { req, fmtNum, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";

interface LogEntry { ts: number; ch: "task" | "chat" | "sys"; text: string }
interface ReqLog {
  id: string; at: string; uid: string; model: string; status: number;
  durationMs: number; errKind: string; clientIp: string; ua: string;
  realm: string; provider: string; stream: boolean;
  ttfbMs?: number; attempts?: number;
  promptTokens?: number; completionTok?: number; totalTokens?: number;
  credit?: number; hasCredit?: boolean;
  cacheHitTok?: number; cacheMissTok?: number;
  keyName?: string; slot?: string; machineId?: string; path?: string;
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

export function LogsView({ flash }: { flash: Flash }) {
  const [mode, setMode] = useState<"runtime" | "requests">("runtime");
  const [ch, setCh] = useState<"all" | "task" | "chat" | "sys">("all");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [reqs, setReqs] = useState<ReqLog[]>([]);
  const [filter, setFilter] = useState({ account: "", model: "", outcome: "" });
  const [ipFilter, setIpFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    if (mode === "runtime") {
      req<{ entries: LogEntry[] }>("logs").then((r) => setLogs(r.entries.filter((e) => ch === "all" || e.ch === ch)))
        .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
    } else {
      const q = new URLSearchParams();
      if (filter.account) q.set("account", filter.account);
      if (filter.model) q.set("model", filter.model);
      if (filter.outcome) q.set("outcome", filter.outcome);
      if (ipFilter) q.set("client_ip", ipFilter);
      req<{ entries: ReqLog[] }>("request_logs?" + q.toString()).then((r) => setReqs(r.entries))
        .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
    }
  }, [mode, filter, ch, ipFilter, flash]);
  useEffect(load, [load]);
  useAutoRefresh(load, 10_000);
  usePanelRefresh(load);

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
      </>}
      <button className="btn xs" onClick={load}>刷新</button>
      {mode === "runtime" && <>
        <select className="select" style={{ width: 104 }} value={ch}
          onChange={(e) => setCh(e.target.value as typeof ch)}>
          <option value="all">全部频道</option><option value="task">任务</option>
          <option value="chat">对话</option><option value="sys">系统</option>
        </select>
      </>}
    </>}>
      {mode === "runtime" ? (
        <div className="pad">
          <div className="logview">
            {logs.length === 0 && <div style={{ color: "#64748b" }}>暂无运行日志</div>}
            {logs.map((l, i) => (
              <div key={i} className={"ln" + (/error|失败|错误/.test(l.text) ? " e" : /warn|冷却|熔断/.test(l.text) ? " w" : "")}>{
                new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false })
              } <span className={"lch c-" + l.ch}>{{ task: "任务", chat: "对话", sys: "系统" }[l.ch]}</span> {l.text}</div>
            ))}
          </div>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
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
                const uaS = uaSummary(r.ua);
                const mid = machineShort(r.machineId);
                return (
                  <React.Fragment key={r.id}>
                    <tr onClick={() => setExpanded(open ? null : r.id)}
                      style={{ cursor: "pointer", ...(open ? { background: "var(--bg-soft)" } : {}) }}>
                      <td className="dim mono">{new Date(r.at).toLocaleTimeString("zh-CN", { hour12: false })}</td>
                      <td><span className={"tag " + (r.status < 400 ? "ok" : "err")}>
                        {r.status}{r.errKind ? " " + r.errKind : r.status < 400 ? " 成功" : " 错误"}</span></td>
                      <td className="mono">{r.model || <span className="dim">—</span>}</td>
                      <td className="mono">{r.uid || <span className="dim">—</span>}</td>
                      <td className="mono">{r.clientIp || <span className="dim">—</span>}</td>
                      <td title={r.ua || undefined} style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {uaS || <span className="dim">—</span>}
                      </td>
                      <td className="mono" title={r.machineId || undefined}>{mid || <span className="dim">—</span>}</td>
                      <td>{r.keyName ? <span className="tag">{r.keyName}</span> : <span className="dim">—</span>}</td>
                      <td>{r.provider
                        ? <span className="mono" title={r.provider + (r.slot ? " · " + r.slot : "")}>
                          {r.provider}{r.slot ? " · " + r.slot : ""}</span>
                        : (r.realm ? <span className="tag">{r.realm === "global" ? "国际版池" : "国内版池"}</span> : <span className="dim">—</span>)}</td>
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
                            <span className="dim">状态 / 结果</span><span>{r.status}{r.errKind ? " · " + r.errKind : r.status < 400 ? " · 成功" : " · 错误"}</span>
                            <span className="dim">流式</span><span>{r.stream ? "SSE" : "一次性"}</span>
                            <span className="dim">账号 UID</span><span className="mono">{r.uid || "—"}</span>
                            <span className="dim">机器码（完整）</span><span className="mono">{r.machineId || "—"}</span>
                            <span className="dim">Key 归属</span><span>{r.keyName || "—"}</span>
                            <span className="dim">供应商槽位</span><span>{r.provider ? r.provider + (r.slot ? " · " + r.slot : "") : (r.realm || "—")}</span>
                            <span className="dim">模型</span><span className="mono">{r.model || "—"}</span>
                            <span className="dim">路径</span><span className="mono">{r.path || "—"}</span>
                            <span className="dim">轮转尝试</span><span>{r.attempts ? r.attempts + " 次" : "—"}</span>
                            <span className="dim">耗时 / TTFB</span><span>{fmtMs(r.durationMs)}{r.stream ? " / " + fmtMs(r.ttfbMs) : ""}</span>
                            <span className="dim">Token</span><span>{total > 0
                              ? `${fmtNum(total)}（in ${fmtNum(r.promptTokens ?? 0)} · out ${fmtNum(r.completionTok ?? 0)}）` : "—"}</span>
                            <span className="dim">积分</span><span>{fmtCredit(r.credit, r.hasCredit)}{r.hasCredit ? " pts" : ""}</span>
                            <span className="dim">缓存命中</span><span>{(r.cacheHitTok ?? 0) > 0 || (r.cacheMissTok ?? 0) > 0
                              ? `hit ${fmtNum(r.cacheHitTok ?? 0)} · miss ${fmtNum(r.cacheMissTok ?? 0)}` : "—"}</span>
                            <span className="dim">客户端 IP</span><span className="mono">{r.clientIp || "—"}</span>
                            <span className="dim">User-Agent</span><span style={{ wordBreak: "break-all" }}>{r.ua || "—"}</span>
                          </div>
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
