"use client";
// 余额水位多账号折线图（对齐 Go app.js 余额趋势折线）：纯 SVG，真实时间轴。
// 每账号一条线，颜色按 uid 稳定分配；hover 显示最近点详情。
import React, { useMemo, useState } from "react";

export interface BalancePoint {
  t: number; // unix 秒
  u: string;
  c: number;
  d?: string;
  f?: number;
  cons?: number;
  gain?: number;
}

const COLORS = [
  "#f0e070", "#a7fa70", "#70fa93", "#70e1fa",
  "#9a8cf5", "#ee70fa", "#fa7097", "#5b7cfa",
  "#3ddc97", "#f5b544",
];

const fmtCredits = (n: number) =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + "M"
  : n >= 10_000 ? (n / 1_000).toFixed(1) + "k"
  : String(Math.round(n));

export interface LineSeries {
  uid: string;
  label: string;
  points: BalancePoint[];
}

export function BalanceLineChart({ series }: { series: LineSeries[] }) {
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const W = 760, H = 240, PL = 52, PR = 12, PT = 12, PB = 26;

  const { minT, maxT, minV, maxV } = useMemo(() => {
    let minT = Infinity, maxT = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const s of series) {
      for (const p of s.points) {
        if (p.t < minT) minT = p.t;
        if (p.t > maxT) maxT = p.t;
        if (p.c < minV) minV = p.c;
        if (p.c > maxV) maxV = p.c;
        if (p.f && p.f < minV) minV = p.f;
        if (p.f && p.f > maxV) maxV = p.f;
      }
    }
    if (!Number.isFinite(minT)) { minT = 0; maxT = 1; minV = 0; maxV = 1; }
    if (minV === maxV) { minV = Math.max(0, minV - 1); maxV = maxV + 1; }
    const pad = (maxV - minV) * 0.06;
    minV = Math.max(0, minV - pad);
    maxV = maxV + pad;
    return { minT, maxT, minV, maxV };
  }, [series]);

  if (series.length === 0) {
    return <div style={{ color: "var(--fg-dim)", fontSize: 12, padding: "28px 0", textAlign: "center" }}>暂无采样数据（余额刷新后每 30 分钟落一个点）</div>;
  }

  const sx = (t: number) => PL + ((t - minT) / Math.max(1, maxT - minT)) * (W - PL - PR);
  const sy = (v: number) => PT + (1 - (v - minV) / Math.max(1e-9, maxV - minV)) * (H - PT - PB);

  // y 轴 4 条刻度
  const yTicks = Array.from({ length: 5 }, (_, i) => minV + ((maxV - minV) * i) / 4);
  // x 轴 6 个时间刻度
  const xTicks = Array.from({ length: 6 }, (_, i) => minT + ((maxT - minT) * i) / 5);

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}
        onMouseLeave={() => setHover(null)}>
        {yTicks.map((v, i) => (
          <g key={i}>
            <line x1={PL} x2={W - PR} y1={sy(v)} y2={sy(v)} stroke="var(--bg-soft)" strokeWidth={1} />
            <text x={PL - 6} y={sy(v) + 4} textAnchor="end" fontSize={10} fill="var(--fg-dim)">{fmtCredits(v)}</text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={sx(t)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--fg-dim)">
            {new Date(t * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })}
          </text>
        ))}
        {series.map((s, si) => {
          const color = COLORS[si % COLORS.length];
          const dAttr = s.points.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.t).toFixed(1)},${sy(p.c).toFixed(1)}`).join("");
          return (
            <g key={s.uid}>
              <path d={dAttr} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
              {s.points.map((p, i) => (
                <circle key={i} cx={sx(p.t)} cy={sy(p.c)} r={5} fill="transparent"
                  onMouseEnter={() => setHover({
                    x: sx(p.t), y: sy(p.c),
                    text: `${s.label} · ${p.c.toLocaleString()} · ${new Date(p.t * 1000).toLocaleString("zh-CN", { hour12: false })}${p.d ? "（日折叠点）" : ""}`,
                  })} />
              ))}
            </g>
          );
        })}
        {hover && (
          <circle cx={hover.x} cy={hover.y} r={3.4} fill="var(--ink)" stroke="var(--bg)" strokeWidth={1.4} />
        )}
      </svg>
      {hover && (
        <div style={{
          position: "absolute", left: 0, top: 0, transform: `translate(${Math.min(hover.x / W * 100, 55)}%, 0)`,
          pointerEvents: "none", background: "var(--bg-card)", border: "1px solid var(--border)",
          borderRadius: 6, padding: "5px 9px", fontSize: 11.5, color: "var(--fg)", whiteSpace: "nowrap",
          marginTop: -30,
        }}>{hover.text}</div>
      )}
    </div>
  );
}

// 每日变化分组柱状图：按日分组，每账号一根柱（净变化，正绿负红）。
export function BalanceDailyBars({ series, days }: {
  series: { uid: string; label: string; daily: { day: string; change: number; full: boolean }[] }[];
  days: number;
}) {
  const allDays = useMemo(() => {
    const set = new Set<string>();
    for (const s of series) for (const d of s.daily) set.add(d.day);
    return [...set].sort().slice(-Math.min(days, 30));
  }, [series, days]);
  const maxAbs = useMemo(() => {
    let m = 1;
    for (const s of series) for (const d of s.daily) {
      if (allDays.includes(d.day) && Math.abs(d.change) > m) m = Math.abs(d.change);
    }
    return m;
  }, [series, allDays]);

  if (allDays.length === 0) return null;
  const H = 160, PL = 52, PR = 12, PT = 8, PB = 34;
  const W = Math.max(560, allDays.length * (series.length * 9 + 26) + PL + PR);
  const zeroY = PT + (H - PT - PB) / 2;
  const scale = (H - PT - PB) / 2 / maxAbs;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }}>
      <line x1={PL} x2={W - PR} y1={zeroY} y2={zeroY} stroke="var(--border)" strokeWidth={1} />
      <text x={PL - 6} y={zeroY + 3.5} textAnchor="end" fontSize={10} fill="var(--fg-dim)">0</text>
      <text x={PL - 6} y={PT + 8} textAnchor="end" fontSize={10} fill="var(--fg-dim)">+{fmtCredits(maxAbs)}</text>
      <text x={PL - 6} y={H - PB} textAnchor="end" fontSize={10} fill="var(--fg-dim)">-{fmtCredits(maxAbs)}</text>
      {allDays.map((day, di) => {
        const groupW = series.length * 9 + 16;
        const gx = PL + di * groupW + 8;
        return (
          <g key={day}>
            {series.map((s, si) => {
              const d = s.daily.find((x) => x.day === day);
              if (!d || d.change === 0) return null;
              const h = Math.max(1.5, Math.abs(d.change) * scale);
              const y = d.change > 0 ? zeroY - h : zeroY;
              return (
                <rect key={s.uid} x={gx + si * 9} y={y} width={7} height={h}
                  fill={d.change > 0 ? "var(--ok)" : "var(--err)"}
                  opacity={d.full ? 1 : 0.45} rx={1}>
                  <title>{`${day} ${s.label}: ${d.change > 0 ? "+" : ""}${d.change.toLocaleString()}${d.full ? "" : "（采样不完整）"}`}</title>
                </rect>
              );
            })}
            <text x={gx + (series.length * 9) / 2 - 4} y={H - 20} textAnchor="middle" fontSize={9.5}
              fill="var(--fg-dim)" transform={`rotate(-35 ${gx + (series.length * 9) / 2 - 4} ${H - 20})`}>
              {day.slice(5)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
