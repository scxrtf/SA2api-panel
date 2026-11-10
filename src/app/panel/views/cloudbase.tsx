"use client";
import React, { useCallback, useEffect, useState } from "react";
import { fmtNum, req, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";

interface TableStat {
  name: string; rows: number; totalBytes: number; dataBytes: number; indexBytes: number;
  avgRowBytes?: number; added24h?: number | null;
}
interface Stats {
  measuredAt: string; cacheSeconds: number; mode?: "cloudbase" | "direct";
  database: {
    name: string; host: string; version: string;
    sizeGb: number; limitGb: number; percent: number;
    requestLogs: number; dialogRows: number;
    activeConnections: number; maxConnections: number;
  };
  tables: TableStat[];
  platform?: {
    configured: boolean; available: boolean; qps: number | null; qpsQuota: number | null;
    periodSeconds: number; sampledAt: string | null; statistics: string | null;
    packageName: string | null; postgresTenantType: string | null; error: string | null;
  } | null;
  retention: { days: number; detailHours: number };
}

function bytes(n: number): string {
  if (!n) return "—";
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(3) + " GB";
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return Math.round(n) + " B";
}

export function CloudbaseView({ flash }: { flash: Flash }) {
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
  const isCb = stats?.mode === "cloudbase";
  const totalRows = stats?.tables.reduce((s, t) => s + t.rows, 0) ?? 0;
  const growthRows = stats?.tables.reduce((s, t) => s + (t.added24h ?? 0), 0) ?? 0;
  const growthBytes = stats?.tables.reduce((s, t) => s + (t.added24h ?? 0) * (t.avgRowBytes || 1024) * 1.25, 0) ?? 0;
  const pct = db?.percent ?? 0;
  const barCls = pct >= 90 ? "crit" : pct >= 70 ? "warn" : "";
  const collectedAt = stats ? new Date(stats.measuredAt).toLocaleString("zh-CN", { hour12: false }) : "…";
  const platform = stats?.platform;
  const qpsAt = platform?.sampledAt ? new Date(platform.sampledAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—";
  return <div style={{ display: "grid", gap: 16 }}>
    <Box title="CloudBase 监控" hint={db ? `${db.host} · ${db.version}` : "读取中…"}
      extra={<button className="btn xs" disabled={loading} onClick={() => void load(true)}>{loading ? "读取中…" : "刷新"}</button>} pad>
      <div className="cb-kpi-grid">
        <div className="cb-kpi span2">
          <div className="cb-kpi-head"><span className="k">容量{isCb ? " · 采样估算" : ""}</span><span className="cb-chip">{pct.toFixed(1)}%</span></div>
          <span className="v">{db && db.sizeGb > 0 ? <>{db.sizeGb.toFixed(3)}<span className="cb-unit">GB</span></> : "—"}</span>
          <div className="cb-bar"><i className={barCls} style={{ width: Math.min(100, Math.max(pct, 0.5)) + "%" }} /></div>
          <span className="s">上限 {db?.limitGb ?? "…"} GB · {isCb ? "近 50 行均值 × 行数 × 1.25" : "pg_database_size 实测"}</span>
        </div>
        <div className="cb-kpi">
          <div className="cb-kpi-head"><span className="k">总行数</span><span className="cb-chip">{stats?.tables.length ?? "…"} 表</span></div>
          <span className="v">{stats ? fmtNum(totalRows) : "…"}</span>
          <span className="s">近 24h 新增 {fmtNum(growthRows)} 行 · 缓存 {stats?.cacheSeconds ?? 60}s</span>
        </div>
        <div className="cb-kpi">
          <div className="cb-kpi-head"><span className="k">请求日志</span><span className="cb-chip">{stats?.retention.days ?? 7} 天</span></div>
          <span className="v">{fmtNum(db?.requestLogs)}</span>
          <span className="s">近 24h 新增约 {bytes(growthBytes)}</span>
        </div>
        {!isCb && <div className="cb-kpi">
          <div className="cb-kpi-head"><span className="k">活动连接</span></div>
          <span className="v">{db?.activeConnections ?? "—"}<span className="cb-unit">/ {db?.maxConnections ?? "—"}</span></span>
          <span className="s">上限 {db?.maxConnections ?? "—"}</span>
        </div>}
        {isCb && <div className="cb-kpi">
          <div className="cb-kpi-head"><span className="k">环境 QPS</span><span className="cb-chip">{platform?.available ? "平台实测" : "待配置"}</span></div>
          <span className="v">{platform?.available && platform.qps !== null ? fmtNum(platform.qps) : "—"}<span className="cb-unit">/ {platform?.qpsQuota ?? "—"} 上限</span></span>
          <span className="s">{platform?.available ? `${platform.periodSeconds / 60} 分钟${platform.statistics === "max" ? "峰值" : "均值"} · ${qpsAt}` : "配置 CAM 密钥后采集 · 共享 PG 无连接数指标"}</span>
        </div>}
        <div className="cb-kpi">
          <div className="cb-kpi-head"><span className="k">{isCb ? "环境" : "数据库"}</span><span className={"cb-dot" + (stats ? " on" : "")} /></div>
          <span className="v small mono">{db?.name ?? "…"}</span>
          <span className="s">采集于 {collectedAt}</span>
        </div>
      </div>
    </Box>
    <Box title="请求日志存储" hint={`整行保留 ${stats?.retention.days ?? 7} 天 · 诊断详情 ${stats?.retention.detailHours ?? 24} 小时`}
      extra={<div style={{ display: "flex", gap: 8 }}>
        <button className="btn xs" disabled={!!busy} onClick={() => void action("clear_dialog")}>{busy === "clear_dialog" ? "清理中…" : "清理历史对话"}</button>
        <button className="btn xs primary" disabled={!!busy} onClick={() => void action("run_retention")}>{busy === "run_retention" ? "执行中…" : "立即执行保留策略"}</button>
      </div>} pad>
      <div className="cb-ret-grid">
        <div className="cb-ret"><span className="k">日志行数</span><span className="v">{fmtNum(db?.requestLogs)}</span></div>
        <div className="cb-ret"><span className="k">仍含历史对话</span><span className={"v" + ((db?.dialogRows ?? 0) > 0 ? " warn" : "")}>{fmtNum(db?.dialogRows)}</span></div>
        <div className="cb-ret wide"><span className="k">正文保存策略</span><span className="s">请求消息与助手回复到期剥离；保留用量、错误详情、参数覆盖与尝试明细</span></div>
      </div>
    </Box>
  </div>;
}
