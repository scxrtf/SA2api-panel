"use client";
// 运行日志视图（对齐 Go view-logs）：请求日志 / 运行日志双模式 + 过滤。
import React, { useCallback, useEffect, useState } from "react";
import { req } from "../lib";
import { Box, type Flash } from "../components/ui";

interface LogEntry { ts: string; channel: string; line: string }
interface ReqLog {
  id: string; at: string; uid: string; model: string; status: number;
  durationMs: number; errKind: string; clientIp: string; ua: string;
  realm: string; provider: string; stream: boolean;
}

export function LogsView({ flash }: { flash: Flash }) {
  const [mode, setMode] = useState<"runtime" | "requests">("requests");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [reqs, setReqs] = useState<ReqLog[]>([]);
  const [filter, setFilter] = useState({ account: "", model: "", outcome: "" });

  const load = useCallback(() => {
    if (mode === "runtime") {
      req<{ entries: LogEntry[] }>("logs").then((r) => setLogs(r.entries))
        .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
    } else {
      const q = new URLSearchParams();
      if (filter.account) q.set("account", filter.account);
      if (filter.model) q.set("model", filter.model);
      if (filter.outcome) q.set("outcome", filter.outcome);
      req<{ entries: ReqLog[] }>("request_logs?" + q.toString()).then((r) => setReqs(r.entries))
        .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
    }
  }, [mode, filter, flash]);
  useEffect(load, [load]);

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
      </>}
      <button className="btn xs" onClick={load}>刷新</button>
    </>}>
      {mode === "runtime" ? (
        <div className="pad">
          <div className="mono" style={{ maxHeight: 520, overflowY: "auto" }}>
            {logs.length === 0 && <div className="dim">暂无运行日志</div>}
            {logs.map((l, i) => (
              <div key={i}>{new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false })} {l.line}</div>
            ))}
          </div>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>时间</th><th>账号</th><th>模型</th><th>状态</th><th>耗时</th><th>流式</th><th>错误</th></tr></thead>
            <tbody>
              {reqs.length === 0 && <tr><td colSpan={7} className="dim" style={{ textAlign: "center", padding: 20 }}>暂无请求日志</td></tr>}
              {reqs.map((r) => (
                <tr key={r.id}>
                  <td className="dim">{new Date(r.at).toLocaleString("zh-CN", { hour12: false })}</td>
                  <td>{r.uid}</td><td className="mono">{r.model}</td>
                  <td><span className={"tag " + (r.status < 400 ? "ok" : "err")}>{r.status}</span></td>
                  <td>{r.durationMs}ms</td>
                  <td>{r.stream ? "是" : "否"}</td>
                  <td className="dim">{r.errKind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Box>
  );
}
