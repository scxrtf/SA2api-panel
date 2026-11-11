"use client";
// 余额趋势视图（移植 Go「余额趋势」）：多账号水位折线（cn/global 分域，两域积分不同源
// 不可相加）+ 每日变化分组柱状图 + 按账号明细表（当前/最低/最高/净变化/今日/昨日/
// 今日消耗/到账/本月消耗/到账/采样点数）。
// 消耗与到账为**下界估计**：采样间隔 30 分钟远粗于真实事件密度，同一窗口内的消耗与
// 到账会被合并成净差（不完整日淡化显示）。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { reqCached, fmtNum, fmtClock, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, ButtonLoadingContent, LoadingIndicator, type Flash } from "../components/ui";
import { BalanceLineChart, BalanceDailyBars, type BalancePoint } from "../components/balanceChart";
import { BALANCE_HISTORY_CACHE_MS } from "@/lib/balance-history-cache";

interface DailyRow {
  day: string; first: number; last: number; change: number;
  min: number; max: number; n: number; full: boolean;
  consumed: number; gained: number;
}
interface Series {
  uid: string; name: string; realm: string;
  points: BalancePoint[];
  current: number; min: number; max: number; change: number;
  daily: DailyRow[];
}
interface HistResp { now: string; days: number; series: Series[] }

const REALM_LABEL: Record<string, string> = { cn: "国内", global: "国际" };

function signed(n: number): string {
  return (n > 0 ? "+" : "") + fmtNum(n);
}
function numColor(n: number): string | undefined {
  return n > 0 ? "var(--ok)" : n < 0 ? "var(--err)" : undefined;
}

export function BalHistView({ flash }: { flash: Flash }) {
  const [data, setData] = useState<HistResp | null>(null);
  const [days, setDays] = useState(30);
  const [realm, setRealm] = useState<"cn" | "global">("cn");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (force = false) => {
    setLoading(true);
    try { setData(await reqCached<HistResp>(`balance_history?days=${days}`, { force, ttlMs: BALANCE_HISTORY_CACHE_MS })); }
    catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  }, [days, flash]);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  // 只刷新当前可见标签页；前后端各缓存 60 秒，最新采样至多约 1 分钟上图。
  // 轮询只读已落库的采样点，不会额外请求上游余额接口。
  useAutoRefresh(() => load(), BALANCE_HISTORY_CACHE_MS);
  // 手动刷新按钮 / 顶栏刷新走 force 立即绕过前后端缓存。
  usePanelRefresh(() => load(true));

  const realms = useMemo(() => {
    const set = new Set<string>();
    for (const s of data?.series ?? []) set.add(s.realm === "global" ? "global" : "cn");
    return set;
  }, [data]);
  // 数据回来后发现当前选中的域不存在时，派生一个有效域（避免在 effect 里同步 setState）
  const activeRealm = useMemo<"cn" | "global">(() => {
    if (realms.size === 0 || realms.has(realm)) return realm;
    return realms.has("cn") ? "cn" : "global";
  }, [realms, realm]);

  const shown = useMemo(
    () => (data?.series ?? []).filter((s) => (s.realm === "global" ? "global" : "cn") === activeRealm),
    [data, activeRealm],
  );

  // 汇总卡：账号数 / 当前合计 / 窗口净变化 / 今日到账-消耗
  const summary = useMemo(() => {
    const today = new Date().toLocaleDateString("en-CA");
    let total = 0, change = 0, todayGain = 0, todayCons = 0;
    for (const s of shown) {
      total += s.current;
      change += s.change;
      const t = s.daily.find((d) => d.day === today);
      if (t) { todayGain += t.gained; todayCons += t.consumed; }
    }
    return { count: shown.length, total, change, todayGain, todayCons };
  }, [shown]);

  const lineSeries = shown.map((s) => ({
    uid: s.uid,
    label: s.name || s.uid.slice(0, 8),
    points: s.points,
  }));
  const barSeries = shown.map((s) => ({
    uid: s.uid,
    label: s.name || s.uid.slice(0, 8),
    daily: s.daily,
  }));

  return (
    <Box title="余额趋势" busy={loading} hint={`采样间隔 30 分钟 · 每分钟自动刷新 · 消耗/到账为下界估计${data ? " · 数据时间 " + fmtClock(data.now) : ""}`}
      extra={<>
        <select className="select" style={{ width: 120 }} value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={1}>近 24 小时</option>
          <option value={7}>近 7 天</option>
          <option value={30}>近 30 天</option>
        </select>
        <button className="btn xs" disabled={loading} aria-busy={loading} onClick={() => void load(true)}>
          <ButtonLoadingContent loading={loading} loadingChildren="刷新中…">刷新</ButtonLoadingContent>
        </button>
      </>}>
      {!data ? <LoadingIndicator label="正在加载余额趋势…" /> : <>
      <div className="pad">
        <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
          {(["cn", "global"] as const).filter((r) => realms.has(r)).map((r) => (
            <button key={r} className={"btn xs" + (activeRealm === r ? " primary" : "")} onClick={() => setRealm(r)}>
              {REALM_LABEL[r]}
            </button>
          ))}
          <span style={{ color: "var(--fg-dim)", fontSize: 12 }}>
            两域积分不同源、不可相加，分域展示
          </span>
        </div>
        <div className="kpi-grid" style={{ marginBottom: 14 }}>
          <div className="kpi"><div className="k">账号</div><div className="v">{summary.count}</div></div>
          <div className="kpi"><div className="k">当前合计</div><div className="v">{fmtNum(summary.total)}</div></div>
          <div className="kpi"><div className="k">窗口净变化</div><div className="v" style={numColor(summary.change) ? { color: numColor(summary.change) } : undefined}>{signed(summary.change)}</div></div>
          <div className="kpi"><div className="k">今日到账 / 消耗</div><div className="v"><span style={{ color: "var(--ok)" }}>+{fmtNum(summary.todayGain)}</span> / <span style={{ color: "var(--err)" }}>-{fmtNum(summary.todayCons)}</span></div></div>
        </div>
        <BalanceLineChart series={lineSeries} />
      </div>
      <div className="pad">
        <Box title="每日变化" hint="柱高 = 当日末值 − 首值 · 半透明 = 采样不完整（下界估计）" pad>
          <BalanceDailyBars series={barSeries} days={days} />
        </Box>
      </div>
      </>}
      <div className="pad">
        <Box title="账号明细" hint="本月消耗/到账按自然月累计 · 下界估计" pad>
          <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>账号</th><th>当前</th><th>最低</th><th>最高</th><th>净变化</th>
                <th>今日</th><th>昨日</th><th>今日消耗</th><th>今日到账</th>
                <th>本月消耗</th><th>本月到账</th><th>采样点</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((s) => {
                const today = new Date().toLocaleDateString("en-CA");
                const month = today.slice(0, 7);
                const t0 = s.daily.find((d) => d.day === today);
                const y0 = s.daily.length >= 2 && s.daily[s.daily.length - 1].day === today
                  ? s.daily[s.daily.length - 2] : s.daily[s.daily.length - 1];
                let mCons = 0, mGain = 0;
                for (const d of s.daily) {
                  if (d.day.startsWith(month)) { mCons += d.consumed; mGain += d.gained; }
                }
                return (
                  <tr key={s.uid}>
                    <td>{s.name || s.uid.slice(0, 8)}</td>
                    <td className="mono">{fmtNum(s.current)}</td>
                    <td className="mono">{fmtNum(s.min)}</td>
                    <td className="mono">{fmtNum(s.max)}</td>
                    <td className="mono" style={numColor(s.change) ? { color: numColor(s.change) } : undefined}>{signed(s.change)}</td>
                    <td className="mono" style={numColor(t0?.change ?? 0) ? { color: numColor(t0?.change ?? 0) } : undefined}>{t0 ? signed(t0.change) : "-"}</td>
                    <td className="mono" style={numColor(y0?.change ?? 0) ? { color: numColor(y0?.change ?? 0) } : undefined}>{y0 && y0.day !== today ? signed(y0.change) : "-"}</td>
                    <td className="mono">{t0 ? fmtNum(t0.consumed) : "-"}</td>
                    <td className="mono">{t0 ? fmtNum(t0.gained) : "-"}</td>
                    <td className="mono">{fmtNum(mCons)}</td>
                    <td className="mono">{fmtNum(mGain)}</td>
                    <td className="mono">{fmtNum(s.points.length)}</td>
                  </tr>
                );
              })}
              {shown.length === 0 && (
                <tr><td colSpan={12} style={{ color: "var(--fg-dim)", textAlign: "center", padding: 20 }}>
                  暂无数据
                </td></tr>
              )}
            </tbody>
          </table>
          </div>
        </Box>
      </div>
    </Box>
  );
}
