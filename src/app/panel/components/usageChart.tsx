"use client";
// 用量时序堆叠柱状图（对齐 Go app.js renderUsageChart）：纯 SVG，真实时间轴。
// 未指定分组时保持 prompt/completion 双色堆叠；指定分组时按 Key / 模型等维度
// 堆叠彩色分段，图例可逐项隐藏/恢复。
import React, { useMemo, useState } from "react";

export interface SeriesPoint {
  t: number; // 毫秒时间戳
  label: string; // x 轴短标签
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
}

export interface ChartGroup {
  key: string;
  label: string;
  realm?: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  requests: number;
  points: SeriesPoint[];
}

const fmtTok = (n: number) =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(1) + "M"
  : n >= 1000 ? (n / 1000).toFixed(1) + "k"
  : String(Math.round(n));

const GROUP_COLORS = [
  "#e8741c", "#2f9e6e", "#3b82f6", "#a855f7",
  "#ef4444", "#14b8a6", "#eab308", "#64748b",
];
const MAX_GROUPS = 8;
const OTHER_KEY = "__other__";

// Top N 直接展示，其余按时间桶合并成「其它」，避免图例和分段无限膨胀。
function mergeGroups(groups: ChartGroup[]): ChartGroup[] {
  const sorted = [...groups].sort((a, b) =>
    b.total_tokens - a.total_tokens ||
    b.requests - a.requests ||
    a.label.localeCompare(b.label),
  );
  if (sorted.length <= MAX_GROUPS) return sorted;

  const head = sorted.slice(0, MAX_GROUPS - 1);
  const tail = sorted.slice(MAX_GROUPS - 1);
  const byT = new Map<number, SeriesPoint>();
  let prompt = 0, completion = 0, total = 0, requests = 0;
  for (const g of tail) {
    prompt += g.prompt_tokens;
    completion += g.completion_tokens;
    total += g.total_tokens;
    requests += g.requests;
    for (const p of g.points) {
      const cur = byT.get(p.t);
      if (cur) {
        cur.prompt_tokens += p.prompt_tokens;
        cur.completion_tokens += p.completion_tokens;
        cur.total_tokens += p.total_tokens;
        cur.requests += p.requests;
      } else {
        byT.set(p.t, { ...p });
      }
    }
  }
  return [
    ...head,
    {
      key: OTHER_KEY,
      label: "其它 (" + tail.length + ")",
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: total,
      requests,
      points: [...byT.values()].sort((a, b) => a.t - b.t),
    },
  ];
}

export function UsageChart({ series, groups, dimLabel }: {
  series: SeriesPoint[];
  groups?: ChartGroup[];
  dimLabel?: string;
}) {
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const displayGroups = useMemo(
    () => (groups && groups.length > 0 ? mergeGroups(groups) : []),
    [groups],
  );
  const grouped = displayGroups.length > 0;

  if (series.length === 0) {
    return <div className="us-empty">暂无用量数据。发起一次对话后再刷新。</div>;
  }

  const W = 1200, H = 200, PL = 58, PR = 14, PT = 18, PB = 30;
  const iw = W - PL - PR, ih = H - PT - PB;
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const span = Math.max(1, t1 - t0);

  let minGap = Infinity;
  for (let i = 1; i < series.length; i++) minGap = Math.min(minGap, series[i].t - series[i - 1].t);
  if (!isFinite(minGap) || minGap <= 0) minGap = span;
  const slot = iw * (minGap / span);
  const bw = Math.max(2, Math.min(30, slot * 0.7));
  const xOf = (t: number) => PL + bw / 2 + ((t - t0) / span) * Math.max(1, iw - bw);

  const colorOf = new Map<string, string>();
  displayGroups.forEach((g, i) => colorOf.set(g.key, GROUP_COLORS[i % GROUP_COLORS.length]));

  const visibleGroups = grouped ? displayGroups.filter((g) => !hidden.has(g.key)) : [];
  const drawGroups = visibleGroups.length > 0 ? visibleGroups : displayGroups;
  const groupMaps = drawGroups.map((g) => ({
    g,
    color: colorOf.get(g.key) ?? GROUP_COLORS[0],
    byT: new Map(g.points.map((p) => [p.t, p])),
  }));

  const stackTotals = grouped
    ? series.map((p) => groupMaps.reduce((s, gm) => s + (gm.byT.get(p.t)?.total_tokens ?? 0), 0))
    : series.map((p) => p.total_tokens);
  const max = Math.max(1, ...stackTotals);
  const peakIdx = stackTotals.reduce((best, v, i) => (v > stackTotals[best] ? i : best), 0);
  const peak = series[peakIdx];
  const peakVal = stackTotals[peakIdx] ?? 0;
  const avg = stackTotals.reduce((s, v) => s + v, 0) / series.length;
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

  const toggleGroup = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        const left = displayGroups.filter((g) => !next.has(g.key)).length;
        if (left <= 1) return prev; // 至少保留一项可见
        next.add(key);
      }
      return next;
    });
  };

  const visibleTotal = drawGroups.reduce((s, g) => s + g.total_tokens, 0);
  const merged = groups && groups.length > MAX_GROUPS ? groups.length - (MAX_GROUPS - 1) : 0;

  return (
    <>
      {grouped && (
        <div className="uschart-legend">
          <span className="note">{dimLabel || "分组"}：</span>
          {displayGroups.map((g) => {
            const off = hidden.has(g.key);
            return (
              <button key={g.key} type="button" className={off ? "off" : ""}
                title="点击隐藏/恢复" onClick={() => toggleGroup(g.key)}>
                <i style={{ background: colorOf.get(g.key) }} />
                <span>{g.label}</span>
                <span className="sum">{fmtTok(g.total_tokens)}</span>
              </button>
            );
          })}
          <span className="note">可见合计 {fmtTok(visibleTotal)}</span>
          {merged > 0 && <span className="note">其余 {merged} 项已合并</span>}
        </div>
      )}
      <div className="uschart-body">
        <svg viewBox={"0 0 " + W + " " + H} role="img" preserveAspectRatio="xMidYMid meet">
          {!grouped && (
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
          )}
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
            const yBase = PT + ih;
            if (!grouped) {
              const hTot = ih * (p.total_tokens / max);
              const hP = p.total_tokens ? hTot * (p.prompt_tokens / p.total_tokens) : 0;
              const hC = Math.max(p.total_tokens && p.completion_tokens ? 1 : 0, hTot - hP);
              return (
                <g key={i}>
                  <title>{p.label} · {fmtTok(p.prompt_tokens)} prompt / {fmtTok(p.completion_tokens)} completion / {p.requests} 次</title>
                  {hP > 0 && <rect className="usbar" x={x} y={yBase - hP} width={bw} height={hP} fill="url(#usGradP)" rx={hC > 0 ? undefined : 1.5} />}
                  {hC > 0 && <rect className="usbar" x={x} y={yBase - hP - hC} width={bw} height={hC} fill="url(#usGradC)" rx={1.5} />}
                </g>
              );
            }

            const segs = groupMaps.map((gm) => {
              const gp = gm.byT.get(p.t);
              return {
                key: gm.g.key,
                label: gm.g.label,
                color: gm.color,
                value: gp?.total_tokens ?? 0,
                prompt: gp?.prompt_tokens ?? 0,
                completion: gp?.completion_tokens ?? 0,
              };
            }).filter((s) => s.value > 0);
            let acc = 0;
            return (
              <g key={i}>
                <title>
                  {p.label} · {fmtTok(stackTotals[i])} tokens / {p.requests} 次{"\n"}
                  {segs.map((s) => s.label + " " + fmtTok(s.value) + "（p " + fmtTok(s.prompt) + " / c " + fmtTok(s.completion) + "）").join("\n")}
                </title>
                {segs.map((s) => {
                  const h = ih * (s.value / max);
                  const y = yBase - acc - h;
                  acc += h;
                  return <rect key={s.key} className="usbar" x={x} y={y} width={bw} height={Math.max(1, h)} fill={s.color} rx={1} />;
                })}
              </g>
            );
          })}
          {peakVal > 0 && (
            <text className="tk-peak"
              x={Math.max(PL, Math.min(W - PR, xOf(peak.t)))}
              y={Math.max(10, yOf(peakVal) - 5)}
              textAnchor={xOf(peak.t) > W - PR - 90 ? "end" : "middle"}>
              峰值 {fmtTok(peakVal)}
            </text>
          )}
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
    </>
  );
}
