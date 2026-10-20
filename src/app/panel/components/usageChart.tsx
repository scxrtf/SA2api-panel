"use client";
// 用量时序堆叠柱状图（对齐 Go app.js renderUsageChart）：纯 SVG，真实时间轴，
// prompt/completion 双色堆叠，均值参考线 + 峰值标注。
import React from "react";

export interface SeriesPoint {
  t: number; // 毫秒时间戳
  label: string; // x 轴短标签
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
}

const fmtTok = (n: number) =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + "M"
  : n >= 1000 ? (n / 1000).toFixed(1) + "k"
  : String(Math.round(n));

export function UsageChart({ series }: { series: SeriesPoint[] }) {
  if (series.length === 0) {
    return <div className="us-empty">暂无用量数据。发起一次对话后再刷新。</div>;
  }
  const W = 1200, H = 200, PL = 58, PR = 14, PT = 18, PB = 30;
  const iw = W - PL - PR, ih = H - PT - PB;
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const max = Math.max(1, ...series.map((p) => p.total_tokens));
  const peak = series.reduce((a, b) => (b.total_tokens > a.total_tokens ? b : a), series[0]);
  const avg = series.reduce((s, p) => s + p.total_tokens, 0) / series.length;

  let minGap = Infinity;
  for (let i = 1; i < series.length; i++) minGap = Math.min(minGap, series[i].t - series[i - 1].t);
  if (!isFinite(minGap) || minGap <= 0) minGap = span;
  const slot = iw * (minGap / span);
  const bw = Math.max(2, Math.min(30, slot * 0.7));
  const xOf = (t: number) => PL + bw / 2 + ((t - t0) / span) * Math.max(1, iw - bw);
  const yOf = (v: number) => PT + ih - ih * (v / max);

  const ticks = Math.min(6, series.length);
  const tickIdx: number[] = [];
  const used = new Set<number>();
  for (let k = 0; k < ticks; k++) {
    const target = t0 + span * (ticks === 1 ? 0.5 : k / (ticks - 1));
    let bi = 0, best = Infinity;
    for (let i = 0; i < series.length; i++) {
      const d = Math.abs(series[i].t - target);
      if (d < best) { best = d; bi = i; }
    }
    if (!used.has(bi)) { used.add(bi); tickIdx.push(bi); }
  }

  return (
    <div className="uschart-body">
      <svg viewBox={"0 0 " + W + " " + H} role="img" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="usGradP" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--us-prompt)", stopOpacity: 1 }} />
            <stop offset="1" style={{ stopColor: "var(--us-prompt)", stopOpacity: 0.6 }} />
          </linearGradient>
          <linearGradient id="usGradC" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "var(--ok)", stopOpacity: 1 }} />
            <stop offset="1" style={{ stopColor: "var(--ok)", stopOpacity: 0.6 }} />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((i) => {
          const y = PT + ih - (ih * i) / 4;
          return (
            <g key={i}>
              <line className="gl" x1={PL} y1={y} x2={W - PR} y2={y} />
              <text className="tk" x={PL - 6} y={y + 3.5} textAnchor="end">{fmtTok((max * i) / 4)}</text>
            </g>
          );
        })}
        {avg > 0 && avg < max && (
          <g>
            <line className="avg" x1={PL} y1={yOf(avg)} x2={W - PR} y2={yOf(avg)} />
            <text className="tk-avg" x={PL + 5} y={yOf(avg) - 4} textAnchor="start">均值 {fmtTok(avg)}</text>
          </g>
        )}
        {series.map((p, i) => {
          const x = xOf(p.t) - bw / 2;
          const hTot = ih * (p.total_tokens / max);
          const hP = p.total_tokens ? hTot * (p.prompt_tokens / p.total_tokens) : 0;
          const hC = Math.max(p.total_tokens && p.completion_tokens ? 1 : 0, hTot - hP);
          const yBase = PT + ih;
          return (
            <g key={i}>
              <title>{p.label} · {fmtTok(p.prompt_tokens)} prompt / {fmtTok(p.completion_tokens)} completion / {p.requests} 次</title>
              {hP > 0 && <rect className="usbar" x={x} y={yBase - hP} width={bw} height={hP} fill="url(#usGradP)" rx={hC > 0 ? undefined : 1.5} />}
              {hC > 0 && <rect className="usbar" x={x} y={yBase - hP - hC} width={bw} height={hC} fill="url(#usGradC)" rx={1.5} />}
            </g>
          );
        })}
        <text className="tk-peak"
          x={Math.max(PL, Math.min(W - PR, xOf(peak.t)))}
          y={Math.max(10, yOf(peak.total_tokens) - 5)}
          textAnchor={xOf(peak.t) > W - PR - 90 ? "end" : "middle"}>
          峰值 {fmtTok(peak.total_tokens)}
        </text>
        <line className="ax" x1={PL} y1={PT + ih} x2={W - PR} y2={PT + ih} />
        {tickIdx.map((i) => {
          const p = series[i];
          const cx = xOf(p.t);
          const anchor = cx < PL + 14 ? "start" : cx > W - PR - 14 ? "end" : "middle";
          return (
            <text key={i} className="tk" x={Math.max(PL, Math.min(W - PR, cx))} y={PT + ih + 15} textAnchor={anchor}>
              {p.label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}
