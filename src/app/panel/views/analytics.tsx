"use client";
// 数据看板视图：模型调用分析分流 Sankey（池→KEY→模型 / 供应商→模型）
// + 模型状态卡（探测可用率 / 心跳历史 / 最近探测距今）。
// 分流数据源 /api/panel/usage（by_pool_key / by_pool_key_model / by_provider /
// by_provider_model），状态数据源 /api/panel/models 目录 + /api/panel/model_probes 落库记录。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { req, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";

/* ── usage 响应里本视图用到的最小形状（与 route.ts 输出对齐） ────── */
interface Agg {
  requests: number; errors: number;
  prompt_tokens: number; completion_tokens: number; total_tokens: number;
  credits: number; credit_samples: number; credit_tokens: number;
}
interface KeyedRow { key: string; realm?: string; extra?: string; agg: Agg }
interface CreditRow { key: string; rate?: string; credits: number; credit_tokens: number }
interface UsageResp {
  totals: Agg;
  by_key: KeyedRow[];
  by_model: KeyedRow[];
  by_pool_key?: KeyedRow[];
  by_pool_model?: KeyedRow[];
  by_pool_key_model?: KeyedRow[];
  by_provider: KeyedRow[];
  by_provider_model: KeyedRow[]; // realm=供应商名, extra=裸模型
  by_key_model: KeyedRow[];      // realm=key 名, extra=裸模型（池口径）
  credit_by_model: CreditRow[];  // key="model\x00rate"
}

interface ModelRow {
  id: string; name: string; vendor?: string; provider?: boolean;
  credits?: number | string; promo_label?: string;
}
interface ProbeRec {
  measured: number | null; verdict: string; note: string;
  tested_at: string; source: string;
}
interface HealthRec {
  ok: boolean; status: number; latency_ms: number;
  completion_tokens: number; tokens_per_second: number;
  error_kind: string; detail: string; checked_at: string;
}

/* ── 展示工具 ──────────────────────────────────────────────────── */
function fmtTok(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}
function realmOfId(id: string): string {
  const i = id.indexOf(":");
  return i > 0 ? id.slice(0, i) : "cn";
}
function bareOfId(id: string): string {
  const i = id.indexOf(":");
  return i > 0 ? id.slice(i + 1) : id;
}
function relTime(ts: string): string {
  const d = Date.now() - new Date(ts).getTime();
  if (!isFinite(d) || d < 0) return "现在";
  if (d < 60_000) return "现在";
  if (d < 3600_000) return Math.floor(d / 60_000) + "m 之前";
  if (d < 86400_000) return Math.floor(d / 3600_000) + "h 之前";
  return Math.floor(d / 86400_000) + "d 之前";
}
function trimFixed(n: number, digits = 1): string {
  return n.toFixed(digits).replace(/\.0+$/, "");
}
function fmtElapsed(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1_000) return Math.max(1, Math.round(ms)) + "ms";
  if (ms < 10_000) return trimFixed(ms / 1_000) + "s";
  if (ms < 60_000) return Math.round(ms / 1_000) + "s";
  if (ms < 3_600_000) return Math.round(ms / 60_000) + "m";
  if (ms < 86_400_000) return trimFixed(ms / 3_600_000) + "h";
  return trimFixed(ms / 86_400_000) + "d";
}
function fmtThroughput(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return "—";
  return (tps >= 100 ? String(Math.round(tps)) : trimFixed(tps)) + " tok/s";
}

/* ══ Sankey 分流图 ══════════════════════════════════════════════ */
type Metric = "credits" | "tokens" | "requests";
type NodeFilter = "all" | "pool" | "provider";
type FlowLane = "pool" | "provider";

interface FlowNode {
  id: string; lane: FlowLane; col: 0 | 1 | 2;
  label: string; sub?: string; value: number;
}
interface FlowLink { src: string; dst: string; value: number }

const NODE_GAP = 14;         // 同列节点间距
const NODE_W = 10;           // 节点条宽
const NODE_MIN_H = 8;

function metricValue(a: Agg, metric: Metric): number {
  if (metric === "requests") return a.requests;
  if (metric === "tokens") return a.total_tokens;
  return a.credits;
}

function fmtFlowValue(n: number, metric: Metric): string {
  if (metric !== "credits") return fmtTok(n);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

// 池与供应商使用独立 ID 和独立泳道；供应商模型按裸模型名跨供应商合并。
function buildFlow(
  u: UsageResp, metric: Metric, nf: NodeFilter,
): { nodes: FlowNode[]; links: FlowLink[] } {
  const poolKeyRows = u.by_pool_key ?? u.by_key ?? [];
  const poolPairRows = u.by_pool_key_model ?? u.by_key_model ?? [];
  const providerRows = u.by_provider ?? [];
  const providerPairRows = u.by_provider_model ?? [];
  // 供应商流量没有稳定的积分明细；额度视图下用 Token 量级维持可比的分流形态。
  const providerMetric: Metric = metric === "credits" ? "tokens" : metric;

  const nodes: FlowNode[] = [];
  const links: FlowLink[] = [];
  const seen = new Set<string>();
  const addNode = (n: FlowNode) => {
    if (n.value <= 0 || seen.has(n.id)) return;
    seen.add(n.id);
    nodes.push(n);
  };
  const addLink = (src: string, dst: string, v: number) => {
    if (v > 0) links.push({ src, dst, value: v });
  };

  const showPool = nf !== "provider";
  const showProvider = nf !== "pool";

  if (showPool) {
    const keyValues = new Map<string, number>();
    for (const row of poolKeyRows) {
      const v = metricValue(row.agg, metric);
      if (v > 0) keyValues.set(row.key, (keyValues.get(row.key) ?? 0) + v);
    }
    const poolTotal = [...keyValues.values()].reduce((sum, v) => sum + v, 0);
    if (poolTotal > 0) {
      addNode({ id: "pool", lane: "pool", col: 0, label: "内置池", value: poolTotal });
      for (const [key, value] of keyValues) {
        const id = "pool:key:" + key;
        addNode({ id, lane: "pool", col: 1, label: key, sub: "KEY", value });
        addLink("pool", id, value);
      }

      const pairTokensByKey = new Map<string, number>();
      const pairCreditsByKey = new Map<string, number>();
      for (const row of poolPairRows) {
        const key = row.realm ?? "";
        if (!key || !keyValues.has(key)) continue;
        pairTokensByKey.set(key, (pairTokensByKey.get(key) ?? 0) + row.agg.total_tokens);
        pairCreditsByKey.set(key, (pairCreditsByKey.get(key) ?? 0) + row.agg.credits);
      }

      const modelValues = new Map<string, number>();
      const pairLinks: { src: string; dst: string; value: number }[] = [];
      for (const row of poolPairRows) {
        const key = row.realm ?? "";
        const model = row.extra ?? "";
        if (!key || !model || !keyValues.has(key)) continue;
        let value = metricValue(row.agg, metric);
        // 兼容旧响应：缺少逐对积分时，用 KEY 的积分总量按 Token 占比摊分。
        if (metric === "credits" && (pairCreditsByKey.get(key) ?? 0) <= 0) {
          const tokens = pairTokensByKey.get(key) ?? 0;
          if (tokens > 0) value = (keyValues.get(key) ?? 0) * (row.agg.total_tokens / tokens);
        }
        if (value <= 0) continue;
        const src = "pool:key:" + key;
        const dst = "pool:model:" + model;
        pairLinks.push({ src, dst, value });
        modelValues.set(model, (modelValues.get(model) ?? 0) + value);
      }
      for (const [model, value] of modelValues) {
        addNode({ id: "pool:model:" + model, lane: "pool", col: 2, label: model, sub: "模型", value });
      }
      for (const link of pairLinks) addLink(link.src, link.dst, link.value);
    }
  }

  if (showProvider) {
    const providerValues = new Map<string, number>();
    for (const row of providerRows) {
      const v = metricValue(row.agg, providerMetric);
      if (v > 0) providerValues.set(row.key, (providerValues.get(row.key) ?? 0) + v);
    }
    const pairProviderValues = new Map<string, number>();
    for (const row of providerPairRows) {
      const provider = row.realm ?? "";
      if (!provider) continue;
      const v = metricValue(row.agg, providerMetric);
      if (v > 0) pairProviderValues.set(provider, (pairProviderValues.get(provider) ?? 0) + v);
    }
    for (const [provider, value] of pairProviderValues) {
      providerValues.set(provider, Math.max(providerValues.get(provider) ?? 0, value));
    }

    const modelValues = new Map<string, number>();
    const pairLinks: { src: string; dst: string; value: number }[] = [];
    for (const row of providerPairRows) {
      const provider = row.realm ?? "";
      const model = row.extra ?? "";
      if (!provider || !model) continue;
      const value = metricValue(row.agg, providerMetric);
      if (value <= 0) continue;
      const src = "provider:name:" + provider;
      const dst = "provider:model:" + model;
      pairLinks.push({ src, dst, value });
      modelValues.set(model, (modelValues.get(model) ?? 0) + value);
    }
    for (const [provider, value] of providerValues) {
      if (value > 0) {
        addNode({ id: "provider:name:" + provider, lane: "provider", col: 0, label: provider, sub: "供应商", value });
      }
    }
    for (const [model, value] of modelValues) {
      addNode({ id: "provider:model:" + model, lane: "provider", col: 2, label: model, sub: "模型", value });
    }
    for (const link of pairLinks) addLink(link.src, link.dst, link.value);
  }

  return { nodes, links };
}

// Top N + 合并「其他」/ 隐藏。
function trimFlow(
  nodes: FlowNode[], links: FlowLink[], topN: number, other: "merge" | "hide",
): { nodes: FlowNode[]; links: FlowLink[] } {
  const keep = new Set<string>(nodes.filter((n) => n.col === 0).map((n) => n.id));
  const groups = new Map<string, FlowNode[]>();
  for (const node of nodes) {
    if (node.col === 0) continue;
    const key = node.lane + ":" + node.col;
    const group = groups.get(key);
    if (group) group.push(node);
    else groups.set(key, [node]);
  }
  // Top N 按泳道和列分别计算，避免供应商模型挤掉池模型。
  for (const group of groups.values()) {
    group.sort((a, b) => b.value - a.value).slice(0, topN).forEach((n) => keep.add(n.id));
  }

  if (other === "hide") {
    const keptNodes = nodes.filter((n) => keep.has(n.id));
    const keptLinks = links.filter((l) => keep.has(l.src) && keep.has(l.dst));
    return { nodes: keptNodes, links: keptLinks };
  }

  // merge：未保留节点按泳道和列合并成「其他」，边重定向后再次合并。
  const otherId = new Map<string, string>();
  const out: FlowNode[] = nodes.filter((n) => keep.has(n.id));
  const otherNodes = new Map<string, FlowNode>();
  for (const n of nodes) {
    if (keep.has(n.id)) continue;
    const key = n.lane + ":" + n.col;
    const current = otherNodes.get(key);
    if (current) current.value += n.value;
    else otherNodes.set(key, {
      id: "other:" + n.lane + ":" + n.col,
      lane: n.lane, col: n.col, label: "其他", sub: "汇总", value: n.value,
    });
  }
  for (const [key, node] of otherNodes) {
    otherId.set(key, node.id);
    out.push(node);
  }
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const remap = (id: string): string => {
    if (keep.has(id)) return id;
    const n = nodeById.get(id);
    return n ? (otherId.get(n.lane + ":" + n.col) ?? id) : id;
  };
  const merged = new Map<string, FlowLink>();
  for (const l of links) {
    const src = remap(l.src), dst = remap(l.dst);
    if (src === dst) continue;
    const k = src + "→" + dst;
    const cur = merged.get(k);
    if (cur) cur.value += l.value;
    else merged.set(k, { src, dst, value: l.value });
  }
  return { nodes: out, links: [...merged.values()] };
}

const POOL_KEY_COLORS = ["#2563eb", "#0891b2", "#7c3aed", "#0284c7", "#4f46e5", "#0d9488"];
const POOL_MODEL_COLORS = ["#16a34a", "#65a30d", "#059669", "#0f766e", "#ca8a04"];
const PROVIDER_COLORS = ["#e8741c", "#dc2626", "#d97706", "#ea580c", "#b45309"];
const PROVIDER_MODEL_COLORS = ["#9333ea", "#c026d3", "#7e22ce", "#db2777", "#6d28d9"];

function colorHash(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function nodeColor(n: FlowNode): string {
  if (n.id.startsWith("other:")) return "#9ca3af";
  if (n.lane === "provider") {
    const palette = n.col === 0 ? PROVIDER_COLORS : PROVIDER_MODEL_COLORS;
    return palette[colorHash(n.label) % palette.length];
  }
  if (n.id === "pool") return "#2563eb";
  const palette = n.col === 1 ? POOL_KEY_COLORS : POOL_MODEL_COLORS;
  return palette[colorHash(n.label) % palette.length];
}

function truncatedLabel(label: string, max = 28): string {
  return label.length > max ? label.slice(0, max - 1) + "…" : label;
}

function Sankey({ nodes, links, metric }: { nodes: FlowNode[]; links: FlowLink[]; metric: Metric }) {
  const W = 1040;
  const colX: [number, number, number] = [180, 510, 850];
  const LANE_HEADER = 30;
  const LANE_GAP = 18;
  const laneOrder: FlowLane[] = ["pool", "provider"];
  const activeLanes = laneOrder.filter((lane) => nodes.some((n) => n.lane === lane));
  const laneHeight = new Map<FlowLane, number>();
  for (const lane of activeLanes) {
    const maxColumnCount = Math.max(
      ...[0, 1, 2].map((col) => nodes.filter((n) => n.lane === lane && n.col === col).length),
    );
    laneHeight.set(lane, Math.max(120, maxColumnCount * 28) + LANE_HEADER);
  }
  const laneTop = new Map<FlowLane, number>();
  let nextLaneTop = 0;
  for (const lane of activeLanes) {
    laneTop.set(lane, nextLaneTop);
    nextLaneTop += (laneHeight.get(lane) ?? 120) + LANE_GAP;
  }
  const H = Math.max(180, nextLaneTop - LANE_GAP + 4);

  const pos = new Map<string, { x: number; y: number; h: number }>();
  for (const lane of activeLanes) {
    const top = laneTop.get(lane) ?? 0;
    const contentTop = top + LANE_HEADER + 4;
    const contentHeight = (laneHeight.get(lane) ?? 120) - LANE_HEADER - 8;
    for (const col of [0, 1, 2] as const) {
      const columnNodes = nodes
        .filter((n) => n.lane === lane && n.col === col)
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
      if (columnNodes.length === 0) continue;

      const available = Math.max(
        NODE_MIN_H * columnNodes.length,
        contentHeight - (columnNodes.length - 1) * NODE_GAP,
      );
      const heights = new Map<string, number>();
      const pending = [...columnNodes];
      let remaining = available;
      while (pending.length > 0) {
        const total = pending.reduce((sum, n) => sum + n.value, 0);
        const tooSmall: FlowNode[] = [];
        for (const n of pending) {
          const height = total > 0 ? remaining * (n.value / total) : remaining / pending.length;
          if (height < NODE_MIN_H) tooSmall.push(n);
        }
        if (tooSmall.length === 0) {
          for (const n of pending) {
            heights.set(n.id, total > 0 ? remaining * (n.value / total) : remaining / pending.length);
          }
          break;
        }
        for (const n of tooSmall) {
          heights.set(n.id, NODE_MIN_H);
          remaining -= NODE_MIN_H;
          pending.splice(pending.indexOf(n), 1);
        }
      }

      let y = contentTop;
      for (const n of columnNodes) {
        const height = heights.get(n.id) ?? NODE_MIN_H;
        pos.set(n.id, { x: colX[col], y, h: height });
        y += height + NODE_GAP;
      }
    }
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const sourceTotals = new Map<string, number>();
  const destinationTotals = new Map<string, number>();
  for (const link of links) {
    sourceTotals.set(link.src, (sourceTotals.get(link.src) ?? 0) + link.value);
    destinationTotals.set(link.dst, (destinationTotals.get(link.dst) ?? 0) + link.value);
  }

  const outgoing = new Map<string, FlowLink[]>();
  const incoming = new Map<string, FlowLink[]>();
  for (const link of links) {
    const out = outgoing.get(link.src);
    if (out) out.push(link);
    else outgoing.set(link.src, [link]);
    const inc = incoming.get(link.dst);
    if (inc) inc.push(link);
    else incoming.set(link.dst, [link]);
  }
  const nodeY = (id: string): number => pos.get(id)?.y ?? 0;
  const sourceOffsets = new Map<string, number>();
  for (const [sourceId, sourceLinks] of outgoing) {
    const sourcePos = pos.get(sourceId);
    if (!sourcePos) continue;
    let offset = 0;
    sourceLinks
      .sort((a, b) => nodeY(a.dst) - nodeY(b.dst) || a.dst.localeCompare(b.dst))
      .forEach((link) => {
        sourceOffsets.set(link.src + "→" + link.dst, offset);
        offset += (link.value / (sourceTotals.get(sourceId) ?? link.value)) * sourcePos.h;
      });
  }
  const destinationOffsets = new Map<string, number>();
  for (const [destinationId, destinationLinks] of incoming) {
    const destinationPos = pos.get(destinationId);
    if (!destinationPos) continue;
    let offset = 0;
    destinationLinks
      .sort((a, b) => nodeY(a.src) - nodeY(b.src) || a.src.localeCompare(b.src))
      .forEach((link) => {
        destinationOffsets.set(link.src + "→" + link.dst, offset);
        offset += (link.value / (destinationTotals.get(destinationId) ?? link.value)) * destinationPos.h;
      });
  }

  const maxLink = Math.max(1, ...links.map((l) => l.value));
  const maxLinkByLane = new Map<FlowLane, number>();
  for (const link of links) {
    const lane = nodeById.get(link.src)?.lane;
    if (!lane) continue;
    maxLinkByLane.set(lane, Math.max(maxLinkByLane.get(lane) ?? 1, link.value));
  }
  const paths: { d: string; color: string; key: string; width: number; label: string }[] = [];
  for (const link of links) {
    const source = pos.get(link.src);
    const destination = pos.get(link.dst);
    const sourceNode = nodeById.get(link.src);
    const destinationNode = nodeById.get(link.dst);
    if (!source || !destination || !sourceNode || !destinationNode) continue;
    const key = link.src + "→" + link.dst;
    const sourcePortHeight =
      (link.value / (sourceTotals.get(link.src) ?? link.value)) * source.h;
    const destinationPortHeight =
      (link.value / (destinationTotals.get(link.dst) ?? link.value)) * destination.h;
    const sy = source.y + (sourceOffsets.get(key) ?? 0) + sourcePortHeight / 2;
    const dy = destination.y + (destinationOffsets.get(key) ?? 0) + destinationPortHeight / 2;
    const x1 = source.x + NODE_W;
    const x2 = destination.x;
    const curve = Math.max(30, (x2 - x1) * 0.42);
    const unit = metric === "credits" && sourceNode.lane === "provider"
      ? "Token（供应商近似口径）"
      : metric === "credits" ? "额度" : metric === "tokens" ? "Token" : "请求";
    // 额度模式下供应商回退到 Token，两条泳道分别缩放，避免池连线被压成一条细线。
    const widthMax = metric === "credits"
      ? (maxLinkByLane.get(sourceNode.lane) ?? maxLink)
      : maxLink;
    paths.push({
      key,
      d: `M ${x1} ${sy} C ${x1 + curve} ${sy}, ${x2 - curve} ${dy}, ${x2} ${dy}`,
      color: nodeColor(sourceNode),
      width: 1.1 + (link.value / widthMax) * (18 - 1.1),
      label: `${sourceNode.label} → ${destinationNode.label} · ${fmtFlowValue(link.value, metric)} ${unit}`,
    });
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="模型调用分流图"
      preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", minWidth: 720, height: "auto", display: "block" }}
    >
      {activeLanes.map((lane) => {
        const top = laneTop.get(lane) ?? 0;
        const height = laneHeight.get(lane) ?? 120;
        return (
          <g key={lane}>
            <rect x={0} y={top} width={W} height={height} rx={8} fill="var(--bg-soft)" opacity={0.34} />
            <text x={12} y={top + 18} style={{ fontSize: 11, fill: "var(--fg-dim)", fontFamily: "var(--mono)" }}>
              {lane === "pool" ? "内置池 · 池 → KEY → 模型" : "供应商 · 供应商 → 模型"}
            </text>
          </g>
        );
      })}
      {paths.map((p) => (
        <path
          key={p.key}
          className="an-flow-link"
          d={p.d}
          fill="none"
          stroke={p.color}
          strokeOpacity={0.3}
          strokeWidth={p.width}
          strokeLinecap="round"
        >
          <title>{p.label}</title>
        </path>
      ))}
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const color = nodeColor(n);
        const labelRight = n.col === 2;
        return (
          <g key={n.id}>
            <title>{`${n.label} · ${fmtFlowValue(n.value, metric)}${n.sub ? " · " + n.sub : ""}`}</title>
            <rect x={p.x} y={p.y} width={NODE_W} height={p.h} rx={2.5} fill={color} />
            <text
              x={labelRight ? p.x + NODE_W + 8 : p.x - 8}
              y={p.y + p.h / 2}
              textAnchor={labelRight ? "start" : "end"}
              dominantBaseline="middle"
              style={{ fontSize: 11.5, fill: "var(--fg)", fontFamily: "var(--mono)" }}
            >
              <tspan style={{ fontWeight: 600 }}>{truncatedLabel(n.label)}</tspan>
              <tspan style={{ fill: "var(--fg-dim)", fontSize: 10.5 }}>
                {"  " + fmtFlowValue(n.value, metric)}
              </tspan>
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/* ══ 模型状态卡 ══════════════════════════════════════════════════ */
interface ModelStatus {
  id: string; name: string; source: string; // 池 / 供应商名
  rate: string | null;
  measured: number | null;
  score: number | null; // 真实健康检查成功率；无记录时 null
  checks: HealthRec[]; // 真实心跳历史（旧→新）
}

function StatusCard({ s, busy, disabled, onProbe }: {
  s: ModelStatus;
  busy: boolean;
  disabled: boolean;
  onProbe: () => void;
}) {
  const pct = s.score;
  const color = pct === null ? "var(--fg-dim)" : pct >= 98 ? "var(--ok)" : pct >= 90 ? "var(--warn)" : "var(--err)";
  const up = s.checks.filter((c) => c.ok).length;
  const down = s.checks.length - up;
  const latest = s.checks[s.checks.length - 1];
  const previous = s.checks[s.checks.length - 2];
  const intervalMs = latest && previous
    ? new Date(latest.checked_at).getTime() - new Date(previous.checked_at).getTime()
    : null;
  return (
    <div className="an-status-card">
      <div className="pct" style={{ color }}>
        {pct === null ? "未探测" : pct.toFixed(Number.isInteger(pct) ? 0 : 2) + "%"}
      </div>
      <div className="nm" title={s.id}>
        {s.name}
        {s.rate && <span className="tag" style={{ marginLeft: 6 }}>{s.rate}</span>}
      </div>
      <div className="src dim">{s.source}{s.measured ? " · 实测 " + fmtTok(s.measured) : ""}</div>
      <div className="an-health-metrics" aria-label="最新探测指标">
        <span title={latest && previous
          ? `${new Date(previous.checked_at).toLocaleString("zh-CN", { hour12: false })} → ${new Date(latest.checked_at).toLocaleString("zh-CN", { hour12: false })}`
          : "需要至少两次落库探测才能计算实际间隔"}>
          <em>间隔</em><b>{fmtElapsed(intervalMs)}</b>
        </span>
        <span title={latest ? "从发起请求到收到首个有效响应帧" : "尚无探测记录"}>
          <em>延迟</em><b>{latest ? fmtElapsed(latest.latency_ms) : "—"}</b>
        </span>
        <span title={latest
          ? `本次输出 ${latest.completion_tokens ?? 0} tokens`
          : "尚无探测记录"}>
          <em>吞吐</em><b>{latest ? fmtThroughput(latest.tokens_per_second) : "—"}</b>
        </span>
      </div>
      <div className="hb-row" title={s.checks.map((c) =>
        `${new Date(c.checked_at).toLocaleString("zh-CN", { hour12: false })} · ${c.ok ? "成功" : "失败"}`
        + (c.error_kind ? " · " + c.error_kind : "")
        + (c.status ? " · HTTP " + c.status : "")
      ).join("\n")}>
        {s.checks.length === 0
          ? <span className="dim" style={{ fontSize: 11 }}>尚无真实心跳</span>
          : s.checks.map((c, i) => <i key={i} className={c.ok ? "up" : "down"} />)}
      </div>
      <div className="hb-meta dim">
        {s.checks.length === 0 ? "等待首次真实探测" : `真实心跳：${s.checks.length} 次 · ${up} 成功 · ${down} 失败`}
      </div>
      <div className="hb-foot">
        <span className="dim">{latest ? relTime(latest.checked_at) : "未探测"}</span>
        <button type="button" className="btn xs" disabled={disabled} onClick={onProbe}>
          {busy ? "探测中…" : "立即探测"}
        </button>
      </div>
    </div>
  );
}

/* ══ 视图 ════════════════════════════════════════════════════════ */
export function AnalyticsView({ flash }: { flash: Flash }) {
  const [hours, setHours] = useState(72);
  const [metric, setMetric] = useState<Metric>("tokens");
  const [topN, setTopN] = useState(10);
  const [other, setOther] = useState<"merge" | "hide">("merge");
  const [nf, setNf] = useState<NodeFilter>("all");
  const [u, setU] = useState<UsageResp | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeRec>>({});
  const [health, setHealth] = useState<Record<string, HealthRec[]>>({});
  const [probeBusy, setProbeBusy] = useState<"all" | string | null>(null);

  const loadUsage = useCallback(() => {
    req<UsageResp>("usage?hours=" + hours).then(setU)
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [hours, flash]);
  const loadStatus = useCallback(async () => {
    await Promise.all([
      req<{ models: ModelRow[] }>("models"),
      req<{ probes: Record<string, ProbeRec>; health?: Record<string, HealthRec[]> }>("model_probes")
        .catch(() => ({ probes: {}, health: {} })),
    ]).then(([m, p]) => {
      setModels(m.models);
      setProbes(p.probes ?? {});
      setHealth(p.health ?? {});
    })
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [flash]);

  useEffect(loadUsage, [loadUsage]);
  useEffect(() => { void loadStatus(); }, [loadStatus]);
  useAutoRefresh(loadUsage, 30_000);
  useAutoRefresh(loadStatus, 120_000);
  usePanelRefresh(() => { loadUsage(); void loadStatus(); });

  const probeHealth = useCallback(async (model = "") => {
    if (probeBusy !== null) return;
    setProbeBusy(model || "all");
    try {
      const r = await req<{ total: number; success: number; failed: number }>(
        "model_health/probe",
        { method: "POST", body: model ? { model } : {} },
      );
      const scope = model ? "单项" : "全部";
      flash("ok", `${scope}探测完成：${r.success} 成功 · ${r.failed} 失败 · ${r.total} 个模型`);
      await loadStatus();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setProbeBusy(null);
    }
  }, [flash, loadStatus, probeBusy]);

  const flow = useMemo(() => {
    if (!u) return { nodes: [], links: [] };
    const raw = buildFlow(u, metric, nf);
    return trimFlow(raw.nodes, raw.links, topN, other);
  }, [u, metric, nf, topN, other]);

  const statuses = useMemo<ModelStatus[]>(() => {
    const list = models ?? [];
    return list.map((m) => {
      const pr = probes[m.id];
      const checks = health[m.id] ?? [];
      const up = checks.filter((c) => c.ok).length;
      const score = checks.length > 0 ? Math.round((up / checks.length) * 10000) / 100 : null;
      return {
        id: m.id, name: m.name || bareOfId(m.id),
        source: m.provider ? (m.vendor ?? "供应商") : realmOfId(m.id) === "global" ? "池 · 全球" : "池 · CN",
        rate: typeof m.credits === "string" && m.credits ? m.credits : null,
        measured: pr?.measured ?? null,
        score, checks,
      };
    }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.id.localeCompare(b.id));
  }, [models, probes, health]);

  return (
    <>
      <Box title="模型调用分析" hint="分流图：池→KEY→模型 · 供应商→模型；连线粗细=量级"
        extra={<>
          <select className="select" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={24}>近 24 小时</option><option value={72}>近 3 天</option>
            <option value={168}>近 7 天</option><option value={720}>近 30 天</option>
            <option value={0}>全部历史</option>
          </select>
          <button className="btn xs" onClick={() => { loadUsage(); loadStatus(); }}>刷新</button>
        </>}>
        <div className="pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="an-controls">
            <span className="dim ctl-label">分流</span>
            <div className="ustabs">
              {([["credits", "按额度"], ["tokens", "按 Token"], ["requests", "按请求数"]] as [Metric, string][]).map(([k, l]) => (
                <button key={k} className={metric === k ? "on" : ""} onClick={() => setMetric(k)}>{l}</button>
              ))}
            </div>
            <span className="dim ctl-label">显示数量</span>
            <div className="ustabs">
              {([10, 20, 50, 100] as const).map((n) => (
                <button key={n} className={topN === n ? "on" : ""} onClick={() => setTopN(n)}>前 {n}</button>
              ))}
            </div>
            <span className="dim ctl-label">超出项</span>
            <div className="ustabs">
              <button className={other === "merge" ? "on" : ""} onClick={() => setOther("merge")}>合并为其他</button>
              <button className={other === "hide" ? "on" : ""} onClick={() => setOther("hide")}>隐藏</button>
            </div>
            <span className="dim ctl-label">节点筛选</span>
            <div className="ustabs">
              {([["all", "全部"], ["pool", "池"], ["provider", "供应商"]] as [NodeFilter, string][]).map(([k, l]) => (
                <button key={k} className={nf === k ? "on" : ""} onClick={() => setNf(k)}>{l}</button>
              ))}
            </div>
          </div>
          {!u ? (
            <div className="us-empty">加载用量…</div>
          ) : flow.nodes.length === 0 ? (
            <div className="us-empty">窗口内暂无用量。发起一次对话后再刷新。</div>
          ) : (
            <div className="an-sankey">
              <Sankey nodes={flow.nodes} links={flow.links} metric={metric} />
              <div className="note" style={{ marginTop: 6 }}>
                {flow.nodes.length} 节点 · {flow.links.length} 条分流
                {" · 连线粗细与" + (metric === "credits" ? "各泳道额度" : metric === "tokens" ? "Token" : "请求数") + "量级线性对应"}
                {metric === "credits" && " · 供应商通道暂无积分明细，按 Token 量级绘制"}
                {other === "merge" && flow.nodes.some((n) => n.id.startsWith("other:")) &&
                  " · 超出前 " + topN + " 的项已合并为「其他」"}
              </div>
            </div>
          )}
        </div>
      </Box>

      <Box title="模型状态" hint="真实最小聊天请求探测 · 每次结果落库 · 心跳为实际健康检查记录"
        extra={<button type="button" className="btn xs"
          disabled={probeBusy !== null || !models || statuses.length === 0}
          onClick={() => { void probeHealth(); }}>
          {probeBusy === "all" ? "探测全部中…" : "探测全部"}
        </button>}>
        {!models ? (
          <div className="pad dim">加载模型目录…</div>
        ) : statuses.length === 0 ? (
          <div className="pad dim">暂无模型。请先在「模型与档位」拉取目录。</div>
        ) : (
          <div className="pad an-status-grid">
            {statuses.map((s) => (
              <StatusCard key={s.id} s={s}
                busy={probeBusy === s.id}
                disabled={probeBusy !== null}
                onProbe={() => { void probeHealth(s.id); }} />
            ))}
          </div>
        )}
      </Box>
    </>
  );
}
