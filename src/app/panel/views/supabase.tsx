"use client";
import React, { useCallback, useEffect, useState } from "react";
import { fmtNum, req, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";

interface TableStat { name: string; rows: number; totalBytes: number; dataBytes: number; indexBytes: number }
interface Stats {
  measuredAt: string; cacheSeconds: number;
  database: { name: string; sizeGb: number; limitGb: number; percent: number; requestLogs: number; dialogRows: number };
  tables: TableStat[];
  retention: { days: number; detailHours: number };
}
type MetricKey = "egress" | "logIngestion" | "logQuery";
type Snapshots = Record<MetricKey, { value: number; at: string }>;
const STORAGE_KEY = "wb2a_supabase_usage_v1";
const defaults: Snapshots = {
  egress: { value: 13.431, at: "2026-11-05T00:00:00+08:00" },
  logIngestion: { value: 0.131, at: "2026-11-05T00:00:00+08:00" },
  logQuery: { value: 2.174, at: "2026-11-05T00:00:00+08:00" },
};
const labels: Record<MetricKey, string> = { egress: "Egress", logIngestion: "Log Ingestion", logQuery: "Log Query" };
const limits: Record<MetricKey, number> = { egress: 5, logIngestion: 1, logQuery: 100 };
const links: Record<MetricKey, string> = {
  egress: "https://supabase.com/dashboard/org/izerppequlizjaelvthx/usage#egress",
  logIngestion: "https://supabase.com/dashboard/org/izerppequlizjaelvthx/usage#logIngestion",
  logQuery: "https://supabase.com/dashboard/org/izerppequlizjaelvthx/usage#logQuery",
};
function bytes(n: number): string {
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(3) + " GB";
  return (n / 1024 ** 2).toFixed(2) + " MB";
}

function UsageCard({ title, value, limit, href, detail }: {
  title: string; value: number; limit: number; href: string; detail: React.ReactNode;
}) {
  const percent = value / limit * 100;
  const color = percent > 100 ? "var(--red, #dc2626)" : percent >= 80 ? "var(--amber, #d97706)" : "var(--green, #16a34a)";
  return <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 16, minWidth: 210, flex: 1 }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
      <strong>{title}</strong><a href={href} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>控制台 ↗</a>
    </div>
    <div className="mono" style={{ fontSize: 24, margin: "12px 0 4px", color }}>{value.toFixed(3)} / {limit} GB</div>
    <div style={{ fontSize: 12, color, marginBottom: 8 }}>{percent.toFixed(1)}%{percent > 100 ? " · 已超限" : ""}</div>
    <div style={{ height: 8, background: "var(--bg-soft)", borderRadius: 8, overflow: "hidden" }}>
      <div style={{ width: Math.min(100, Math.max(0, percent)) + "%", height: "100%", background: color }} />
    </div>
    <div className="dim" style={{ fontSize: 12, marginTop: 10 }}>{detail}</div>
  </div>;
}

export function SupabaseView({ flash }: { flash: Flash }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  const [snapshots, setSnapshots] = useState<Snapshots>(defaults);
  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<Snapshots> | null;
        if (saved) setSnapshots((prev) => ({
          egress: saved.egress ?? prev.egress,
          logIngestion: saved.logIngestion ?? prev.logIngestion,
          logQuery: saved.logQuery ?? prev.logQuery,
        }));
      } catch { /* 使用初始快照 */ }
    }, 0);
    return () => clearTimeout(timer);
  }, []);
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try { setStats(await req<Stats>("supabase" + (refresh ? "?refresh=1" : ""))); }
    catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [flash]);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  useAutoRefresh(() => void load(), 60_000);
  usePanelRefresh(() => void load(true));
  const updateSnapshot = (key: MetricKey, raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    setSnapshots((prev) => {
      const next = { ...prev, [key]: { value, at: new Date().toISOString() } };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch { /* 保留页面状态 */ }
      return next;
    });
  };
  const action = async (name: "clear_dialog" | "run_retention") => {
    if (name === "clear_dialog" && !window.confirm("清空全部历史请求对话与助手回复？统计和错误诊断会保留。")) return;
    if (name === "run_retention" && !window.confirm("立即执行保留策略？过期日志与健康检查将被删除。")) return;
    setBusy(name);
    try {
      const r = await req<{ stats: Stats; cleared?: number }>("supabase", { method: "POST", body: { action: name } });
      setStats(r.stats);
      flash("ok", name === "clear_dialog" ? `已清理 ${r.cleared ?? 0} 条历史对话` : "保留策略执行完成");
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  };
  return <div style={{ display: "grid", gap: 16 }}>
    <Box title="Supabase 服务额度" hint="流量与平台日志使用控制台快照；数据库为实时值"
      extra={<button className="btn xs" disabled={loading} onClick={() => void load(true)}>{loading ? "读取中…" : "刷新"}</button>} pad>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        {(Object.keys(labels) as MetricKey[]).map((key) => <UsageCard key={key} title={labels[key]}
          value={snapshots[key].value} limit={limits[key]} href={links[key]} detail={<>
            <label>控制台快照（GB） </label>
            <input className="input mono" type="number" min="0" step="0.001" style={{ width: 105 }}
              value={snapshots[key].value} onChange={(e) => updateSnapshot(key, e.target.value)} />
            <div style={{ marginTop: 5 }}>记录于 {new Date(snapshots[key].at).toLocaleString("zh-CN", { hour12: false })}</div>
          </>} />)}
        <UsageCard title="Database Size" value={stats?.database.sizeGb ?? 0} limit={0.5}
          href="https://supabase.com/dashboard/org/izerppequlizjaelvthx/usage#dbSize"
          detail={stats ? `实时 · ${stats.database.name} · ${new Date(stats.measuredAt).toLocaleString("zh-CN", { hour12: false })}` : "读取中…"} />
      </div>
      <p className="dim" style={{ fontSize: 12, marginBottom: 0 }}>数据库查询缓存 {stats?.cacheSeconds ?? 60} 秒；修改平台快照不会查询或写入 Supabase 控制台。</p>
    </Box>
    <Box title="请求日志存储" hint={`整行保留 ${stats?.retention.days ?? 7} 天 · 诊断详情 ${stats?.retention.detailHours ?? 24} 小时`} pad>
      <div className="kv-grid">
        <span className="dim">请求日志</span><span>{fmtNum(stats?.database.requestLogs)} 行</span>
        <span className="dim">仍含历史对话</span><span>{fmtNum(stats?.database.dialogRows)} 行</span>
        <span className="dim">正文保存策略</span><span>请求消息与助手回复永久剥离；保留用量、错误详情、参数覆盖和尝试明细</span>
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        <button className="btn xs" disabled={!!busy} onClick={() => void action("clear_dialog")}>{busy === "clear_dialog" ? "清理中…" : "清理历史对话"}</button>
        <button className="btn xs" disabled={!!busy} onClick={() => void action("run_retention")}>{busy === "run_retention" ? "执行中…" : "立即执行保留策略"}</button>
      </div>
    </Box>
    <Box title="数据库表占用" hint="含索引与 TOAST，按总占用降序">
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>表</th><th>估算行数</th><th>总占用</th><th>堆 / TOAST</th><th>索引</th></tr></thead>
        <tbody>{stats?.tables.map((t) => <tr key={t.name}><td className="mono">{t.name}</td><td className="mono">{fmtNum(t.rows)}</td>
          <td className="mono">{bytes(t.totalBytes)}</td><td className="mono">{bytes(t.dataBytes)}</td><td className="mono">{bytes(t.indexBytes)}</td></tr>)}
          {!stats && <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 20 }}>读取中…</td></tr>}
        </tbody></table></div>
    </Box>
  </div>;
}
