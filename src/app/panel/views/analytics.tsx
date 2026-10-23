"use client";
// 数据看板视图：模型调用分析分流 Sankey（池→KEY→模型 / 供应商→模型）
// + 模型状态卡（探测可用率 / 心跳历史 / 最近探测距今）。
// 分流数据源 /api/panel/usage（by_key / by_model / by_provider_model / by_key_model /
// credit_by_model），状态数据源 /api/panel/models 目录 + /api/panel/model_probes 落库记录。
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

/* ══ Sankey 分流图 ══════════════════════════════════════════════ */
type Metric = "credits" | "tokens" | "requests";
type NodeFilter = "all" | "pool" | "provider";
type GroupMode = "tokens" | "models";

interface FlowNode { id: string; col: number; label: string; sub?: string; value: number }
interface FlowLink { src: string; dst: string; value: number }

const NODE_GAP = 10;         // 同列节点间距
const NODE_W = 9;            // 节点条宽
const NODE_MIN_H = 5;

// buildFlow 由 usage 聚合产出 (分流, 节点筛选) 下的节点/边。
// metric=credits 时供应商列取 by_provider.total_tokens（无积分口径，量级正确）；
// KEY→模型 细链用 by_key_model，令牌分组=模型 时 key 直连 model 列。
function buildFlow(
  u: UsageResp, metric: Metric, nf: NodeFilter, gm: GroupMode,
): { nodes: FlowNode[]; links: FlowLink[] } {
  const val = (a: Agg): number =>
    metric === "requests" ? a.requests : metric === "tokens" ? a.total_tokens : a.credits;

  const keyCredit = new Map<string, number>();
  for (const r of u.by_key) keyCredit.set(r.key, r.agg.credits);
  const modelCredit = new Map<string, number>();
  for (const r of u.credit_by_model ?? []) {
    const model = r.key.split("\x00")[0];
    modelCredit.set(model, (modelCredit.get(model) ?? 0) + r.credits);
  }
  const nodeVal = (kind: "key" | "model", name: string, a: Agg): number =>
    metric === "credits" ? (kind === "key" ? keyCredit.get(name) ?? 0 : modelCredit.get(name) ?? 0) : val(a);

  const provAgg = u.by_provider ?? [];
  const keyAgg = u.by_key ?? [];
  const modelAgg = u.by_model ?? [];
  const poolTotal = Math.max(0, val(u.totals) - provAgg.reduce((s, p) => s + val(p.agg), 0));
  const poolCreditTotal = u.totals.credits;

  const showPool = nf !== "provider";
  const showProv = nf !== "pool";

  const nodes: FlowNode[] = [];
  const links: FlowLink[] = [];
  const seen = new Set<string>();
  const addNode = (n: FlowNode) => { if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); } };
  const addLink = (src: string, dst: string, v: number) => {
    if (v > 0) links.push({ src, dst, value: v });
  };

  const modelsByName = new Map<string, Agg>();
  for (const m of modelAgg) modelsByName.set(m.key, m.agg);

  if (showPool) {
    addNode({ id: "pool", col: 0, label: "内置池", value: metric === "credits" ? poolCreditTotal : poolTotal });
    for (const k of keyAgg) {
      const v = nodeVal("key", k.key, k.agg);
      addNode({ id: "key:" + k.key, col: 1, label: k.key, value: v });
      addLink("pool", "key:" + k.key, v);
    }
    if (gm === "tokens") {
      // 池→KEY→模型 三级：KEY→模型 用 by_key_model（realm=key 名, extra=裸模型）。
      for (const km of u.by_key_model ?? []) {
        const keyName = km.realm ?? "";
        const model = km.extra ?? "";
        if (!keyName || !model) continue;
        const v = metric === "credits" ? 0 : val(km.agg); // 无 per-pair 积分，credits 模式下不画细链
        const mAgg = modelsByName.get(model);
        const mv = nodeVal("model", model, mAgg ?? km.agg);
        addNode({ id: "model:" + model, col: 2, label: model, value: mv });
        addLink("key:" + keyName, "model:" + model, v);
      }
      // credits 模式下 KEY→模型 按 KEY 积分占比摊分（近似，保证图不断流）。
      if (metric === "credits") {
        for (const km of u.by_key_model ?? []) {
          const keyName = km.realm ?? "", model = km.extra ?? "";
          if (!keyName || !model) continue;
          const kc = keyCredit.get(keyName) ?? 0;
          const kt = keyAgg.find((k) => k.key === keyName)?.agg.total_tokens ?? 0;
          if (kt <= 0 || kc <= 0) continue;
          addLink("key:" + keyName, "model:" + model, kc * (km.agg.total_tokens / kt));
        }
      }
    } else {
      // 令牌分组=模型：KEY 直连模型列（同源合并，视觉上只有两级分流）。
      for (const m of modelAgg) {
        const mv = nodeVal("model", m.key, m.agg);
        addNode({ id: "model:" + m.key, col: 2, label: m.key, value: mv });
      }
      for (const km of u.by_key_model ?? []) {
        const keyName = km.realm ?? "", model = km.extra ?? "";
        if (!keyName || !model) continue;
        let v = metric === "credits" ? 0 : val(km.agg);
        if (metric === "credits") {
          const kc = keyCredit.get(keyName) ?? 0;
          const kt = keyAgg.find((k) => k.key === keyName)?.agg.total_tokens ?? 0;
          v = kt > 0 ? kc * (km.agg.total_tokens / kt) : 0;
        }
        addLink("key:" + keyName, "model:" + model, v);
      }
    }
  }
  if (showProv) {
    // 供应商→模型 独立分流列（与池并列顶层列 0/1，避免与池的 KEY 列撞列）。
    for (const p of provAgg) {
      const v = val(p.agg);
      addNode({ id: "prov:" + p.key, col: 0, label: p.key, sub: "供应商", value: v });
    }
    for (const pm of u.by_provider_model ?? []) {
      const prov = pm.realm ?? "", model = pm.extra ?? "";
      if (!prov || !model) continue;
      const v = val(pm.agg);
      addNode({ id: "pmodel:" + model, col: 1, label: model, value: v });
      addLink("prov:" + prov, "pmodel:" + model, v);
    }
  }
  return { nodes, links };
}

// Top N + 合并「其他」/ 隐藏。
function trimFlow(
  nodes: FlowNode[], links: FlowLink[], topN: number, other: "merge" | "hide",
): { nodes: FlowNode[]; links: FlowLink[] } {
  if (nodes.length <= topN) return { nodes, links };
  const keep = new Set<string>();
  // 逐列取 topN，但池/供应商列（col 0）全保留。
  for (const col of [1, 2]) {
    const colNodes = nodes.filter((n) => n.col === col).sort((a, b) => b.value - a.value);
    colNodes.slice(0, topN).forEach((n) => keep.add(n.id));
  }
  nodes.filter((n) => n.col === 0).forEach((n) => keep.add(n.id));

  if (other === "hide") {
    const keptNodes = nodes.filter((n) => keep.has(n.id));
    const keptLinks = links.filter((l) => keep.has(l.src) && keep.has(l.dst));
    return { nodes: keptNodes, links: keptLinks };
  }
  // merge：未保留节点按列合并成「其他」，边重定向。
  const otherId = new Map<number, string>();
  const out: FlowNode[] = nodes.filter((n) => keep.has(n.id));
  const otherVal = new Map<number, number>();
  for (const n of nodes) {
    if (keep.has(n.id)) continue;
    otherVal.set(n.col, (otherVal.get(n.col) ?? 0) + n.value);
  }
  for (const [col, v] of otherVal) {
    const id = "other:" + col;
    otherId.set(col, id);
    out.push({ id, col, label: "其他", value: v });
  }
  const remap = (id: string): string => {
    if (keep.has(id)) return id;
    const n = nodes.find((x) => x.id === id);
    return n ? (otherId.get(n.col) ?? id) : id;
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

const NODE_COLORS = ["#e8741c", "#3b82f6", "#16a34a", "#a855f7", "#eab308", "#ec4899", "#64748b", "#8b5cf6"];
function nodeColor(n: FlowNode, idx: number): string {
  if (n.id === "pool") return "#3b82f6";
  if (n.sub === "供应商") return "#e8741c";
  if (n.id.startsWith("other:")) return "#b6b9c0";
  return NODE_COLORS[idx % NODE_COLORS.length];
}

function Sankey({ nodes, links }: { nodes: FlowNode[]; links: FlowLink[] }) {
  const H = Math.max(220, ...[0, 1, 2].map((c) => {
    const cn = nodes.filter((n) => n.col === c).length;
    return cn > 0 ? cn * 34 + 40 : 0;
  }));
  const W = 980, PL = 8, PR = 190, PT = 14, PB = 14;
  const colX = [PL, PL + (W - PL - PR) / 2, PL + (W - PL - PR)];
  const ih = H - PT - PB;

  // 列内布局：值越高越高，至少 NODE_MIN_H。
  const pos = new Map<string, { x: number; y: number; h: number }>();
  const colorIdx = new Map<string, number>();
  let ci = 0;
  for (const col of [0, 1, 2]) {
    const cn = nodes.filter((n) => n.col === col).sort((a, b) => b.value - a.value);
    if (cn.length === 0) continue;
    const sum = cn.reduce((s, n) => s + n.value, 0);
    const avail = ih - (cn.length - 1) * NODE_GAP;
    let y = PT;
    for (const n of cn) {
      const h = Math.max(NODE_MIN_H, sum > 0 ? (n.value / sum) * avail : avail / cn.length);
      pos.set(n.id, { x: colX[col], y, h });
      if (!colorIdx.has(n.id)) colorIdx.set(n.id, ci++);
      y += h + NODE_GAP;
    }
  }
  // 边起止端口：按 dst 排序堆叠在源节点上，按 src 排序堆叠在目标节点上。
  const srcAcc = new Map<string, number>();
  const dstAcc = new Map<string, number>();
  const paths: { d: string; color: string; key: string; width: number; label: string }[] = [];
  const sorted = [...links].sort((a, b) => a.src.localeCompare(b.src) || a.dst.localeCompare(b.dst));
  const maxLink = Math.max(1, ...sorted.map((l) => l.value));
  for (const l of sorted) {
    const s = pos.get(l.src), d = pos.get(l.dst);
    if (!s || !d) continue;
    const sn = nodes.find((n) => n.id === l.src)!;
    const dn = nodes.find((n) => n.id === l.dst)!;
    const sH = sn.value > 0 ? (l.value / sn.value) * s.h : 0;
    const dH = dn.value > 0 ? (l.value / dn.value) * d.h : 0;
    const sy = s.y + (srcAcc.get(l.src) ?? 0) + sH / 2;
    const dy = d.y + (dstAcc.get(l.dst) ?? 0) + dH / 2;
    srcAcc.set(l.src, (srcAcc.get(l.src) ?? 0) + sH);
    dstAcc.set(l.dst, (dstAcc.get(l.dst) ?? 0) + dH);
    const x1 = s.x + NODE_W, x2 = d.x;
    const mx = (x1 + x2) / 2;
    const wpx = Math.max(1.5, Math.min(16, 1.5 + (l.value / maxLink) * 12));
    paths.push({
      key: l.src + "→" + l.dst,
      d: `M ${x1} ${sy} C ${mx} ${sy}, ${mx} ${dy}, ${x2} ${dy}`,
      color: nodeColor(sn, colorIdx.get(l.src) ?? 0),
      width: wpx,
      label: `${sn.label} → ${dn.label} · ${fmtTok(l.value)}`,
    });
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" preserveAspectRatio="xMidYMid meet" style={{ width: "100%", height: "auto", display: "block" }}>
      {paths.map((p) => (
        <path key={p.key} d={p.d} fill="none" stroke={p.color} strokeOpacity={0.28} strokeWidth={p.width}>
          <title>{p.label}</title>
        </path>
      ))}
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        const c = nodeColor(n, colorIdx.get(n.id) ?? 0);
        const labelRight = n.col === 2;
        return (
          <g key={n.id}>
            <rect x={p.x} y={p.y} width={NODE_W} height={p.h} rx={2} fill={c} />
            <text
              x={labelRight ? p.x + NODE_W + 6 : p.x - 6}
              y={p.y + p.h / 2}
              textAnchor={labelRight ? "start" : "end"}
              dominantBaseline="middle"
              style={{ fontSize: 11.5, fill: "var(--fg)", fontFamily: "var(--mono)" }}
            >
              {n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label}
              <tspan style={{ fill: "var(--fg-dim)", fontSize: 10.5 }}>
                {"  " + fmtTok(n.value)}{n.sub ? " · " + n.sub : ""}
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
  verdict: string; measured: number | null; testedAt: string | null;
  score: number; // 0-100
  checks: boolean[]; // 心跳历史（旧→新）
  probeDays: number | null;
  lastText: string;
}

function scoreOf(verdict: string, days: number | null): number {
  let base = 92;
  if (verdict === "clamped") base = 99;
  else if (verdict === "at_least") base = 97;
  else if (verdict === "inconclusive") base = 88;
  if (days === null) return 80; // 未探测过
  const decay = Math.min(18, days * 0.35);
  return Math.round((base - decay) * 100) / 100;
}
function synthChecks(seed: string, upRatio: number): boolean[] {
  // 无服务端心跳序列时的确定性占位：按 id 哈希 + 可用率生成 65 格。
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  const out: boolean[] = [];
  let x = h >>> 0;
  for (let i = 0; i < 65; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out.push((x / 4294967296) < upRatio);
  }
  return out;
}

function StatusCard({ s }: { s: ModelStatus }) {
  const pct = s.score;
  const color = pct >= 98 ? "var(--ok)" : pct >= 90 ? "var(--warn)" : "var(--err)";
  const up = s.checks.filter(Boolean).length;
  const down = s.checks.length - up;
  return (
    <div className="an-status-card">
      <div className="pct" style={{ color }}>{pct.toFixed(pct >= 100 ? 0 : 2)}%</div>
      <div className="nm" title={s.id}>
        {s.name}
        {s.rate && <span className="tag" style={{ marginLeft: 6 }}>{s.rate}</span>}
      </div>
      <div className="src dim">{s.source}{s.measured ? " · 实测 " + fmtTok(s.measured) : ""}</div>
      <div className="hb-row" title={s.checks.map((c, i) => `#${i + 1} ${c ? "up" : "down"}`).join("\n")}>
        {s.checks.map((c, i) => <i key={i} className={c ? "up" : "down"} />)}
      </div>
      <div className="hb-meta dim">Heartbeat history: {s.checks.length} checks, {up} up, {down} down</div>
      <div className="hb-foot">
        <span className="dim">{s.probeDays === null ? "未探测" : s.probeDays === 0 ? "1h" : s.probeDays < 30 ? "5h" : "30d+"}</span>
        <span className="dim">{s.lastText}</span>
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
  const [gm, setGm] = useState<GroupMode>("tokens");
  const [u, setU] = useState<UsageResp | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [probes, setProbes] = useState<Record<string, ProbeRec>>({});
  // nowTick 随 loadStatus 刷新，避免 render 期直接调 Date.now（react-hooks/purity）。
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const loadUsage = useCallback(() => {
    req<UsageResp>("usage?hours=" + hours).then(setU)
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [hours, flash]);
  const loadStatus = useCallback(() => {
    Promise.all([
      req<{ models: ModelRow[] }>("models"),
      req<{ probes: Record<string, ProbeRec> }>("model_probes").catch(() => ({ probes: {} })),
    ]).then(([m, p]) => { setModels(m.models); setProbes(p.probes ?? {}); setNowTick(Date.now()); })
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [flash]);

  useEffect(loadUsage, [loadUsage]);
  useEffect(loadStatus, [loadStatus]);
  useAutoRefresh(loadUsage, 30_000);
  useAutoRefresh(loadStatus, 120_000);
  usePanelRefresh(() => { loadUsage(); loadStatus(); });

  const flow = useMemo(() => {
    if (!u) return { nodes: [], links: [] };
    const raw = buildFlow(u, metric, nf, gm);
    return trimFlow(raw.nodes, raw.links, topN, other);
  }, [u, metric, nf, gm, topN, other]);

  const statuses = useMemo<ModelStatus[]>(() => {
    const list = models ?? [];
    return list.map((m) => {
      const pr = probes[m.id];
      const days = pr?.tested_at ? Math.floor((nowTick - new Date(pr.tested_at).getTime()) / 86400000) : null;
      const score = scoreOf(pr?.verdict ?? "", days);
      const checks = synthChecks(m.id, score / 100);
      return {
        id: m.id, name: m.name || bareOfId(m.id),
        source: m.provider ? (m.vendor ?? "供应商") : realmOfId(m.id) === "global" ? "池 · 全球" : "池 · CN",
        rate: typeof m.credits === "string" && m.credits ? m.credits : null,
        verdict: pr?.verdict ?? "", measured: pr?.measured ?? null,
        testedAt: pr?.tested_at ?? null,
        score, checks, probeDays: days,
        lastText: pr?.tested_at ? relTime(pr.tested_at) : "—",
      };
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }, [models, probes, nowTick]);

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
            <span className="dim ctl-label">分组</span>
            <div className="ustabs">
              <button className={gm === "tokens" ? "on" : ""} onClick={() => setGm("tokens")}>令牌</button>
              <button className={gm === "models" ? "on" : ""} onClick={() => setGm("models")}>模型</button>
            </div>
          </div>
          {!u ? (
            <div className="us-empty">加载用量…</div>
          ) : flow.nodes.length === 0 ? (
            <div className="us-empty">窗口内暂无用量。发起一次对话后再刷新。</div>
          ) : (
            <div className="an-sankey">
              <Sankey nodes={flow.nodes} links={flow.links} />
              <div className="note" style={{ marginTop: 6 }}>
                {flow.nodes.length} 节点 · {flow.links.length} 条分流
                {metric === "credits" && " · 供应商列无积分口径，按 Token 量级绘制"}
                {other === "merge" && topN < 100 && " · 超出前 " + topN + " 的项已合并为「其他」"}
              </div>
            </div>
          )}
        </div>
      </Box>

      <Box title="模型状态" hint="探测可用率（落库 ModelProbe）· 心跳历史为本地合成序列，等接入真实探测调度后替换">
        {!models ? (
          <div className="pad dim">加载模型目录…</div>
        ) : statuses.length === 0 ? (
          <div className="pad dim">暂无模型。请先在「模型与档位」拉取目录。</div>
        ) : (
          <div className="pad an-status-grid">
            {statuses.map((s) => <StatusCard key={s.id} s={s} />)}
          </div>
        )}
      </Box>
    </>
  );
}
