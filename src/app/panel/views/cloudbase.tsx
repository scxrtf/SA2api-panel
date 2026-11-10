"use client";
import React, { useCallback, useEffect, useState } from "react";
import { fmtNum, req, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";
import { SuperPasswordModal } from "../components/superPassword";

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
    qpsSeries?: { at: string; value: number }[];
  } | null;
  retention: { days: number; detailHours: number };
}

type CleanupAction = "clear_dialog" | "clear_details" | "clear_expired_logs" | "run_retention";
const CLEANUP_TEXT: Record<CleanupAction, { title: string; button: string }> = {
  clear_dialog: { title: "清理历史对话", button: "验证并清理" },
  clear_details: { title: "清理诊断详情", button: "验证并清理" },
  clear_expired_logs: { title: "删除过期数据", button: "验证并删除" },
  run_retention: { title: "执行完整保留策略", button: "验证并执行" },
};

// Catmull-Rom 转三次贝塞尔，生成平滑曲线路径。
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length < 2) return pts.length ? `M ${pts[0].x} ${pts[0].y}` : "";
  let d = `M ${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6, c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6, c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

// 轻量 SVG 平滑折线图：数据来自 CloudBase 平台采样，无额外图表依赖。
function QpsLineChart({ points, quota }: { points: { at: string; value: number }[]; quota: number | null }) {
  const W = 920, H = 260, left = 48, right = 20, top = 24, bottom = 38;
  const cw = W - left - right, ch = H - top - bottom;
  const maxValue = Math.max(10, ...points.map((p) => p.value), quota ?? 0);
  const yMax = Math.ceil(maxValue / 10) * 10;
  const xy = points.map((p, i) => ({
    ...p,
    x: left + (points.length === 1 ? cw / 2 : i * cw / (points.length - 1)),
    y: top + ch - p.value / yMax * ch,
  }));
  const line = smoothPath(xy);
  const area = xy.length ? `${line} L ${xy[xy.length - 1].x} ${top + ch} L ${xy[0].x} ${top + ch} Z` : "";
  const quotaY = quota ? top + ch - Math.min(quota, yMax) / yMax * ch : null;
  const tickIndexes = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter((i) => i >= 0);
  return <div className="cb-line-wrap">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`CloudBase 最近一小时环境 QPS 折线图，共 ${points.length} 个采样点`}>
      <defs><linearGradient id="cb-qps-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".22" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
      {[0, .25, .5, .75, 1].map((f) => <g key={f}><line className="grid" x1={left} x2={W - right} y1={top + ch * f} y2={top + ch * f} /><text className="tick" x={left - 10} y={top + ch * f + 4} textAnchor="end">{Math.round(yMax * (1 - f))}</text></g>)}
      {area && <path d={area} fill="url(#cb-qps-area)" />}
      {line && <path className="line" d={line} fill="none" />}
      {quotaY != null && <g className="quota"><line x1={left} x2={W - right} y1={quotaY} y2={quotaY} /><text x={W - right} y={quotaY - 6} textAnchor="end">配额 {fmtNum(quota!)}</text></g>}
      {xy.map((p, i) => <g key={p.at} className="point"><circle cx={p.x} cy={p.y} r={9} className="hit"><title>{new Date(p.at).toLocaleTimeString("zh-CN", { hour12: false })} · {p.value} QPS</title></circle><circle cx={p.x} cy={p.y} r={i === xy.length - 1 ? 4 : 2.5} className="dot" /></g>)}
      {tickIndexes.map((i) => xy[i] && <text key={i} className="tick" x={xy[i].x} y={H - 12} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>{new Date(xy[i].at).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })}</text>)}
    </svg>
    {!points.length && <div className="cb-line-empty">最近一小时暂无平台采样数据</div>}
    <div className="cb-line-foot"><span><i />环境全部请求 · 每 5 分钟峰值</span><span>{points.length} 个采样点{quota ? ` · 配额 ${fmtNum(quota)} QPS` : ""}</span></div>
  </div>;
}

// 环形仪表盘：容量等单值占比指标。
function DonutGauge({ pct, tone }: { pct: number; tone: string }) {
  const R = 34, C = 2 * Math.PI * R;
  const filled = Math.min(100, Math.max(0, pct)) / 100 * C;
  return <svg viewBox="0 0 84 84" className="cb-donut" role="img" aria-label={`占比 ${pct.toFixed(1)}%`}>
    <circle className="track" cx="42" cy="42" r={R} />
    <circle className={"fill " + tone} cx="42" cy="42" r={R} strokeDasharray={`${filled} ${C}`} transform="rotate(-90 42 42)" />
    <text x="42" y="40" textAnchor="middle" className="pct">{pct.toFixed(1)}<tspan className="u">%</tspan></text>
    <text x="42" y="56" textAnchor="middle" className="lbl">已用</text>
  </svg>;
}

// 迷你柱状分布图：表行数 Top N 分布。
function MiniBars({ items }: { items: { label: string; value: number }[] }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  const W = 200, H = 64, gap = 6;
  const bw = items.length ? (W - gap * (items.length - 1)) / items.length : W;
  return <svg viewBox={`0 0 ${W} ${H}`} className="cb-minibars" role="img" aria-label="表行数分布柱状图" preserveAspectRatio="none">
    {items.map((it, i) => {
      const h = Math.max(3, it.value / max * (H - 14));
      return <g key={it.label}><rect x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={2.5} className={i === 0 ? "bar first" : "bar"}><title>{it.label} · {fmtNum(it.value)} 行</title></rect></g>;
    })}
    {!items.length && <text x={W / 2} y={H / 2} textAnchor="middle" className="tick">暂无数据</text>}
  </svg>;
}

// 占比环形图：请求日志中仍含历史对话的比例。
function ShareDonut({ part, total }: { part: number; total: number }) {
  const pct = total > 0 ? part / total * 100 : 0;
  const R = 34, C = 2 * Math.PI * R;
  const filled = Math.min(100, Math.max(0, pct)) / 100 * C;
  return <svg viewBox="0 0 84 84" className="cb-donut" role="img" aria-label={`历史对话占比 ${pct.toFixed(1)}%`}>
    <circle className="track" cx="42" cy="42" r={R} />
    <circle className={"fill" + (pct > 0 ? " warn" : "")} cx="42" cy="42" r={R} strokeDasharray={`${filled} ${C}`} transform="rotate(-90 42 42)" />
    <text x="42" y="40" textAnchor="middle" className="pct">{pct.toFixed(1)}<tspan className="u">%</tspan></text>
    <text x="42" y="56" textAnchor="middle" className="lbl">含对话</text>
  </svg>;
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
  const [cleanup, setCleanup] = useState<CleanupAction | null>(null);
  const [cleanupError, setCleanupError] = useState("");
  const [detailHours, setDetailHours] = useState(24);
  const [logDays, setLogDays] = useState(7);
  const [healthDays, setHealthDays] = useState(3);
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try { setStats(await req<Stats>("database" + (refresh ? "?refresh=1" : ""))); }
    catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [flash]);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  useAutoRefresh(() => void load(), 60_000);
  usePanelRefresh(() => void load(true));
  const openCleanup = (name: CleanupAction) => { setCleanupError(""); setDetailHours(stats?.retention.detailHours ?? 24); setLogDays(stats?.retention.days ?? 7); setCleanup(name); };
  const action = async (password: string) => {
    if (!cleanup) return;
    const name = cleanup;
    if (name === "clear_details" && (!Number.isInteger(detailHours) || detailHours < 0 || detailHours > 8760)) {
      setCleanupError("详情时间范围须为 0～8760 之间的整数小时"); return;
    }
    if (name === "clear_expired_logs" && (!Number.isInteger(logDays) || logDays < 1 || logDays > 365
      || !Number.isInteger(healthDays) || healthDays < 1 || healthDays > 365)) {
      setCleanupError("日志和健康检查保留天数须为 1～365 之间的整数"); return;
    }
    setBusy(name); setCleanupError("");
    try {
      const r = await req<{ stats: Stats; cleared?: number; result?: { rowsDeleted?: number; healthDeleted?: number; detailCleared?: number } }>("database", {
        method: "POST",
        body: { action: name, super_password: password, olderThanHours: detailHours, days: logDays, healthDays },
      });
      setStats(r.stats);
      const message = name === "clear_dialog" ? `已清理 ${r.cleared ?? 0} 条历史对话`
        : name === "clear_details" ? `已清理 ${r.cleared ?? 0} 条日志的诊断详情`
        : name === "clear_expired_logs" ? `已删除 ${r.result?.rowsDeleted ?? 0} 条过期日志、${r.result?.healthDeleted ?? 0} 条健康检查`
        : `保留策略执行完成：清详情 ${r.result?.detailCleared ?? 0} · 删日志 ${r.result?.rowsDeleted ?? 0}`;
      flash("ok", message); setCleanup(null);
    } catch (e) { setCleanupError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  };
  const db = stats?.database;
  const isCb = stats?.mode === "cloudbase";
  const totalRows = stats?.tables.reduce((s, t) => s + t.rows, 0) ?? 0;
  const growthRows = stats?.tables.reduce((s, t) => s + (t.added24h ?? 0), 0) ?? 0;
  const growthBytes = stats?.tables.reduce((s, t) => s + (t.added24h ?? 0) * (t.avgRowBytes || 1024) * 1.25, 0) ?? 0;
  const pct = db?.percent ?? 0;
  const barCls = pct >= 90 ? "crit" : pct >= 70 ? "warn" : "";
  const topTables = (stats?.tables ?? []).slice().sort((a, b) => b.rows - a.rows).slice(0, 8).map((t) => ({ label: t.name, value: t.rows }));
  const collectedAt = stats ? new Date(stats.measuredAt).toLocaleString("zh-CN", { hour12: false }) : "…";
  const platform = stats?.platform;
  const qpsAt = platform?.sampledAt ? new Date(platform.sampledAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—";
  const qpsPoints = platform?.qpsSeries ?? [];
  const qpsPeak = qpsPoints.length ? Math.max(...qpsPoints.map((p) => p.value)) : null;
  const qpsAverage = qpsPoints.length ? Math.round(qpsPoints.reduce((s, p) => s + p.value, 0) / qpsPoints.length * 10) / 10 : null;
  return <div style={{ display: "grid", gap: 16 }}>
    <Box title="CloudBase 监控" hint={db ? `${db.host} · ${db.version}` : "读取中…"}
      extra={<button className="btn xs" disabled={loading} onClick={() => void load(true)}>{loading ? "读取中…" : "刷新"}</button>} pad>
      <div className="cb-kpi-grid">
        <div className="cb-kpi span2">
          <div className="cb-kpi-head"><span className="k">容量{isCb ? " · 采样估算" : ""}</span><span className={"cb-chip" + (barCls ? " " + barCls : "")}>{barCls === "crit" ? "告急" : barCls === "warn" ? "偏高" : "健康"}</span></div>
          <div className="cb-kpi-chart">
            <DonutGauge pct={pct} tone={barCls} />
            <div className="cb-kpi-side">
              <span className="v">{db && db.sizeGb > 0 ? <>{db.sizeGb.toFixed(3)}<span className="cb-unit">GB</span></> : "—"}</span>
              <span className="s">上限 {db?.limitGb ?? "…"} GB · {isCb ? "近 50 行均值 × 行数 × 1.25" : "pg_database_size 实测"}</span>
            </div>
          </div>
        </div>
        <div className="cb-kpi">
          <div className="cb-kpi-head"><span className="k">总行数</span><span className="cb-chip">{stats?.tables.length ?? "…"} 表</span></div>
          <span className="v">{stats ? fmtNum(totalRows) : "…"}</span>
          <MiniBars items={topTables} />
          <span className="s">近 24h 新增 {fmtNum(growthRows)} 行 · 缓存 {stats?.cacheSeconds ?? 60}s</span>
        </div>
        <div className="cb-kpi">
          <div className="cb-kpi-head"><span className="k">请求日志</span><span className="cb-chip">{stats?.retention.days ?? 7} 天</span></div>
          <div className="cb-kpi-chart">
            <ShareDonut part={db?.dialogRows ?? 0} total={db?.requestLogs ?? 0} />
            <div className="cb-kpi-side">
              <span className="v">{fmtNum(db?.requestLogs)}</span>
              <span className="s">近 24h 新增约 {bytes(growthBytes)} · 含对话 {fmtNum(db?.dialogRows)}</span>
            </div>
          </div>
        </div>
        {!isCb && <div className="cb-kpi">
          <div className="cb-kpi-head"><span className="k">活动连接</span></div>
          <span className="v">{db?.activeConnections ?? "—"}<span className="cb-unit">/ {db?.maxConnections ?? "—"}</span></span>
          <span className="s">上限 {db?.maxConnections ?? "—"}</span>
        </div>}
        <div className="cb-kpi">
          <div className="cb-kpi-head"><span className="k">{isCb ? "环境" : "数据库"}</span><span className={"cb-dot" + (stats ? " on" : "")} /></div>
          <span className="v small mono">{db?.name ?? "…"}</span>
          <span className="s">采集于 {collectedAt}</span>
        </div>
      </div>
    </Box>
    {isCb && <Box title="环境 QPS 趋势" hint="CloudBase 平台 · 最近一小时" extra={<span className={"cb-chip" + (platform?.available ? "" : " muted")}>{platform?.available ? "平台实测" : "待配置"}</span>} pad>
      <div className="cb-qps-summary"><div><span>最新</span><b>{platform?.qps == null ? "—" : fmtNum(platform.qps)}<em> QPS</em></b></div><div><span>小时峰值</span><b>{qpsPeak == null ? "—" : fmtNum(qpsPeak)}<em> QPS</em></b></div><div><span>采样均值</span><b>{qpsAverage == null ? "—" : fmtNum(qpsAverage)}<em> QPS</em></b></div><div><span>配额</span><b>{platform?.qpsQuota == null ? "—" : fmtNum(platform.qpsQuota)}<em> QPS</em></b></div></div>
      <QpsLineChart points={qpsPoints} quota={platform?.qpsQuota ?? null} />
      <div className="dim cb-qps-note">{platform?.available ? `最新采样 ${qpsAt} · 指标为每个 5 分钟窗口内的峰值` : platform?.error || "配置 CAM 密钥后采集"}</div>
    </Box>}
    <Box title="请求日志存储" hint={`整行保留 ${stats?.retention.days ?? 7} 天 · 诊断详情 ${stats?.retention.detailHours ?? 24} 小时`}
      extra={<div style={{ display: "flex", gap: 8 }}>
        <button className="btn xs" disabled={!!busy} onClick={() => openCleanup("clear_dialog")}>清理历史对话</button>
        <button className="btn xs primary" disabled={!!busy} onClick={() => openCleanup("run_retention")}>立即执行保留策略</button>
      </div>} pad>
      <div className="cb-ret-grid">
        <div className="cb-ret">
          <span className="k">日志行数</span>
          <span className="v">{fmtNum(db?.requestLogs)}</span>
          <span className="s">整行保留 {stats?.retention.days ?? 7} 天</span>
        </div>
        <div className="cb-ret">
          <span className="k">仍含历史对话</span>
          <span className={"v" + ((db?.dialogRows ?? 0) > 0 ? " warn" : "")}>{fmtNum(db?.dialogRows)}</span>
          <span className="s">{((db?.dialogRows ?? 0) > 0) ? "可执行「清理历史对话」剥离正文" : "正文已全部剥离"}</span>
        </div>
        <div className="cb-ret wide policy">
          <span className="k">正文保存策略</span>
          <span className="s">请求消息与助手回复到期剥离；保留用量、错误详情、参数覆盖与尝试明细。诊断详情保留 {stats?.retention.detailHours ?? 24} 小时。</span>
          <div className="cb-ret-legend">
            <span><i className="sw a" />日志行数 {fmtNum(db?.requestLogs)}</span>
            <span><i className="sw b" />含对话 {fmtNum(db?.dialogRows)}</span>
          </div>
        </div>
      </div>
      <div className="cb-cleanup-tools"><span>自定义清理</span><button className="btn xs" disabled={!!busy} onClick={() => openCleanup("clear_details")}>按时间清诊断详情</button><button className="btn xs danger" disabled={!!busy} onClick={() => openCleanup("clear_expired_logs")}>按时间删过期数据</button><small>所有清理均需超级密码；密码错误会保留弹窗供重试。</small></div>
    </Box>
    {cleanup && <SuperPasswordModal title={CLEANUP_TEXT[cleanup].title} confirmText={CLEANUP_TEXT[cleanup].button} busy={!!busy} error={cleanupError}
      description={<div className="cb-cleanup-dialog">
        {cleanup === "clear_dialog" && <p>剥离全部日志中的请求消息与助手回复，用量、错误详情和参数记录继续保留。</p>}
        {cleanup === "clear_details" && <><p>只清理指定时间之前的对话、失败详情、参数覆盖和尝试明细，保留整行统计。</p><label className="form-label">清理早于（小时），0 表示全部</label><input className="input" type="number" min="0" max="8760" step="1" required disabled={!!busy} value={detailHours} onChange={(e) => setDetailHours(Number(e.target.value))} /></>}
        {cleanup === "clear_expired_logs" && <><p>删除指定时间之前的整行请求日志，同时清理过期模型健康检查。</p><div className="cb-cleanup-fields"><label>日志早于（天）<input className="input" type="number" min="1" max="365" step="1" required disabled={!!busy} value={logDays} onChange={(e) => setLogDays(Number(e.target.value))} /></label><label>健康检查早于（天）<input className="input" type="number" min="1" max="365" step="1" required disabled={!!busy} value={healthDays} onChange={(e) => setHealthDays(Number(e.target.value))} /></label></div></>}
        {cleanup === "run_retention" && <p>依次清理历史对话、超过 {stats?.retention.detailHours ?? 24} 小时的诊断详情、超过 {stats?.retention.days ?? 7} 天的日志和过期健康检查。</p>}
      </div>}
      onCancel={() => { if (!busy) setCleanup(null); }} onConfirm={action} />}
  </div>;
}
