"use client";
// 运行日志视图（对齐 Go view-logs）：请求日志 / 运行日志双模式 + 过滤。
import React, { useCallback, useEffect, useState } from "react";
import { req, useAutoRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";

interface LogEntry { ts: number; ch: "task" | "chat" | "sys"; text: string }
interface ReqLog {
  id: string; at: string; uid: string; model: string; status: number;
  durationMs: number; errKind: string; clientIp: string; ua: string;
  realm: string; provider: string; stream: boolean;
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
            <thead><tr><th>时间</th><th>账号</th><th>来源</th><th>模型</th><th>状态</th><th>耗时</th><th>流式</th><th>IP</th><th>错误</th><th style={{ width: 1 }}></th></tr></thead>
            <tbody>
              {reqs.length === 0 && <tr><td colSpan={10} className="dim" style={{ textAlign: "center", padding: 20 }}>暂无请求日志</td></tr>}
              {reqs.map((r) => {
                const open = expanded === r.id;
                return (
                  <React.Fragment key={r.id}>
                    <tr onClick={() => setExpanded(open ? null : r.id)} style={{ cursor: "pointer", ...(open ? { background: "var(--bg-soft)" } : {}) }}>
                      <td className="dim">{new Date(r.at).toLocaleString("zh-CN", { hour12: false })}</td>
                      <td>{r.uid || <span className="dim">-</span>}</td>
                      <td>{r.provider
                        ? <span className="tag info">{r.provider}</span>
                        : <span className="tag">{r.realm || "池"}</span>}</td>
                      <td className="mono">{r.model}</td>
                      <td><span className={"tag " + (r.status < 400 ? "ok" : "err")}>{r.status}</span></td>
                      <td>{r.durationMs}ms</td>
                      <td>{r.stream ? "是" : "否"}</td>
                      <td className="mono">{r.clientIp || <span className="dim">-</span>}</td>
                      <td className="dim">{r.errKind}</td>
                      <td><span className="dim" style={{ fontSize: 12 }}>{open ? "▲" : "▼"}</span></td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={10} style={{ background: "var(--bg-soft)", padding: "10px 16px" }}>
                          <div className="kv-grid">
                            <span className="dim">请求 ID</span><span className="mono">{r.id}</span>
                            <span className="dim">时间</span><span>{new Date(r.at).toLocaleString("zh-CN", { hour12: false })}</span>
                            <span className="dim">账号 UID</span><span className="mono">{r.uid || "-"}</span>
                            <span className="dim">通道</span><span>{r.provider ? "供应商 " + r.provider : "池 " + (r.realm || "-")}</span>
                            <span className="dim">模型</span><span className="mono">{r.model}</span>
                            <span className="dim">状态码</span><span>{r.status}</span>
                            <span className="dim">耗时</span><span>{r.durationMs} ms</span>
                            <span className="dim">流式</span><span>{r.stream ? "SSE" : "一次性"}</span>
                            <span className="dim">客户端 IP</span><span className="mono">{r.clientIp || "-"}</span>
                            <span className="dim">错误类型</span><span>{r.errKind || "-"}</span>
                            <span className="dim">User-Agent</span><span style={{ wordBreak: "break-all" }}>{r.ua || "-"}</span>
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
