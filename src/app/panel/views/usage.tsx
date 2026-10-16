"use client";
// 用量视图（对齐 Go view-usage）：时间窗统计 + 按模型/账号分布。
import React, { useCallback, useEffect, useState } from "react";
import { req, fmtNum } from "../lib";
import { Box, type Flash } from "../components/ui";
import { UsageChart, type SeriesPoint } from "../components/usageChart";

interface UsageResp {
  count: number; ok_count: number;
  prompt_tokens: number; completion_tokens: number; total_tokens: number; credit: number;
  by_model: { model: string; n: number; tokens: number; credit: number }[];
  by_account: { uid: string; nickname: string; n: number; tokens: number; credit: number }[];
  series: SeriesPoint[];
}

export function UsageView({ flash }: { flash: Flash }) {
  const [hours, setHours] = useState(72);
  const [u, setU] = useState<UsageResp | null>(null);

  const load = useCallback(() => {
    req<UsageResp>("usage?hours=" + hours).then(setU)
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [hours, flash]);
  useEffect(load, [load]);

  if (!u) return <Box title="用量统计" pad><div className="dim">加载用量…</div></Box>;

  return (
    <>
      <Box title="用量统计" extra={<>
        <select className="select" style={{ width: 140 }} value={hours}
          onChange={(e) => setHours(Number(e.target.value))}>
          <option value={24}>近 24 小时</option><option value={72}>近 3 天</option>
          <option value={168}>近 7 天</option><option value={720}>近 30 天</option>
        </select>
        <button className="btn xs" onClick={load}>刷新</button>
      </>}>
        <div className="pad">
          <div className="stat-grid">
            <div className="stat"><div className="stat-num">{fmtNum(u.count)}</div><div className="stat-label">请求数</div></div>
            <div className="stat"><div className="stat-num">{fmtNum(u.ok_count)}</div><div className="stat-label">成功数</div></div>
            <div className="stat"><div className="stat-num">{fmtNum(u.prompt_tokens)}</div><div className="stat-label">输入 tokens</div></div>
            <div className="stat"><div className="stat-num">{fmtNum(u.completion_tokens)}</div><div className="stat-label">输出 tokens</div></div>
            <div className="stat"><div className="stat-num">{fmtNum(u.total_tokens)}</div><div className="stat-label">总 tokens</div></div>
            <div className="stat"><div className="stat-num">{u.credit.toFixed(2)}</div><div className="stat-label">积分消耗</div></div>
          </div>
        </div>
      </Box>
      <Box title="用量时序" hint="蓝=prompt · 绿=completion；横轴为真实时间"
        extra={<span className="note">峰值 {u.series.length > 0 ? fmtNum(Math.max(...u.series.map((p) => p.total_tokens))) : "—"}</span>}>
        <div className="uschart-body">
          <UsageChart series={u.series} />
        </div>
      </Box>
      <Box title="按模型">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>模型</th><th>请求</th><th>tokens</th><th>积分</th></tr></thead>
            <tbody>
              {u.by_model.length === 0 && <tr><td colSpan={4} className="dim" style={{ textAlign: "center", padding: 20 }}>暂无数据</td></tr>}
              {u.by_model.map((m) => {
                const max = Math.max(1, ...u.by_model.map((x) => x.tokens));
                return (
                <tr key={m.model}><td className="mono">{m.model}</td><td>{fmtNum(m.n)}</td>
                  <td>
                    {fmtNum(m.tokens)}
                    <div className="us-mix"><i style={{ width: (m.tokens / max * 100) + "%", background: "var(--accent)" }}></i></div>
                  </td>
                  <td>{m.credit.toFixed(2)}</td></tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Box>
      <Box title="按账号">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>账号</th><th>请求</th><th>tokens</th><th>积分</th></tr></thead>
            <tbody>
              {u.by_account.length === 0 && <tr><td colSpan={4} className="dim" style={{ textAlign: "center", padding: 20 }}>暂无数据</td></tr>}
              {u.by_account.map((a) => {
                const max = Math.max(1, ...u.by_account.map((x) => x.tokens));
                return (
                <tr key={a.uid}><td>{a.nickname || a.uid}<div className="dim mono">{a.uid}</div></td>
                  <td>{fmtNum(a.n)}</td>
                  <td>
                    {fmtNum(a.tokens)}
                    <div className="us-mix"><i style={{ width: (a.tokens / max * 100) + "%", background: "var(--ok)" }}></i></div>
                  </td>
                  <td>{a.credit.toFixed(2)}</td></tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Box>
    </>
  );
}
