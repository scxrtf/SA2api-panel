"use client";
import React, { useCallback, useEffect, useState } from "react";
import { fmtNum, req, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";

interface TableStat { name: string; rows: number; totalBytes: number; dataBytes: number; indexBytes: number }
interface Stats {
  measuredAt: string; cacheSeconds: number;
  database: {
    name: string; host: string; version: string;
    sizeGb: number; limitGb: number; percent: number;
    requestLogs: number; dialogRows: number;
    activeConnections: number; maxConnections: number;
  };
  tables: TableStat[];
  retention: { days: number; detailHours: number };
}

function bytes(n: number): string {
  if (!n) return "—";
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(3) + " GB";
  return (n / 1024 ** 2).toFixed(2) + " MB";
}

export function SupabaseView({ flash }: { flash: Flash }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try { setStats(await req<Stats>("database" + (refresh ? "?refresh=1" : ""))); }
    catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [flash]);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  useAutoRefresh(() => void load(), 60_000);
  usePanelRefresh(() => void load(true));
  const action = async (name: "clear_dialog" | "run_retention") => {
    if (name === "clear_dialog" && !window.confirm("清空全部历史请求对话与助手回复？统计和错误诊断会保留。")) return;
    if (name === "run_retention" && !window.confirm("立即执行保留策略？过期日志与健康检查将被删除。")) return;
    setBusy(name);
    try {
      const r = await req<{ stats: Stats; cleared?: number }>("database", { method: "POST", body: { action: name } });
      setStats(r.stats);
      flash("ok", name === "clear_dialog" ? `已清理 ${r.cleared ?? 0} 条历史对话` : "保留策略执行完成");
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  };
  const db = stats?.database;
  return <div style={{ display: "grid", gap: 16 }}>
    <Box title="数据库概览" hint={db ? `${db.host} · ${db.version}` : "读取中…"}
      extra={<button className="btn xs" disabled={loading} onClick={() => void load(true)}>{loading ? "读取中…" : "刷新"}</button>} pad>
      <div className="kv-grid">
        <span className="dim">数据库</span><span className="mono">{db?.name ?? "…"}</span>
        <span className="dim">容量</span>
        <span className="mono">{db ? (db.sizeGb > 0 ? `${db.sizeGb.toFixed(3)} / ${db.limitGb} GB (${db.percent.toFixed(1)}%)` : "CloudBase 通道不提供容量指标") : "…"}</span>
        <span className="dim">活动连接</span><span className="mono">{db?.activeConnections ?? "—"} / {db?.maxConnections ?? "—"}</span>
        <span className="dim">采集时间</span><span>{stats ? new Date(stats.measuredAt).toLocaleString("zh-CN", { hour12: false }) : "…"}</span>
      </div>
      <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>数据库查询缓存 {stats?.cacheSeconds ?? 60} 秒。</p>
    </Box>
    <Box title="请求日志存储" hint={`整行保留 ${stats?.retention.days ?? 7} 天 · 诊断详情 ${stats?.retention.detailHours ?? 24} 小时`} pad>
      <div className="kv-grid">
        <span className="dim">请求日志</span><span>{fmtNum(db?.requestLogs)} 行</span>
        <span className="dim">仍含历史对话</span><span>{fmtNum(db?.dialogRows)} 行</span>
        <span className="dim">正文保存策略</span><span>请求消息与助手回复永久剥离；保留用量、错误详情、参数覆盖和尝试明细</span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button className="btn xs" disabled={!!busy} onClick={() => void action("clear_dialog")}>{busy === "clear_dialog" ? "清理中…" : "清理历史对话"}</button>
        <button className="btn xs" disabled={!!busy} onClick={() => void action("run_retention")}>{busy === "run_retention" ? "执行中…" : "立即执行保留策略"}</button>
      </div>
    </Box>
    <Box title="数据库表行数" hint="按行数降序">
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>表</th><th>行数</th><th>总占用</th><th>堆 / TOAST</th><th>索引</th></tr></thead>
        <tbody>{stats?.tables.map((t) => <tr key={t.name}><td className="mono">{t.name}</td><td className="mono">{fmtNum(t.rows)}</td>
          <td className="mono">{bytes(t.totalBytes)}</td><td className="mono">{bytes(t.dataBytes)}</td><td className="mono">{bytes(t.indexBytes)}</td></tr>)}
          {!stats && <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 20 }}>读取中…</td></tr>}
        </tbody></table></div>
    </Box>
  </div>;
}
