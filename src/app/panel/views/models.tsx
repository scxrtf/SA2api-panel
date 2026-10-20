"use client";
// 模型与档位视图（对齐 Go view-models）：实时模型目录 + 连通性实测（池/供应商双通道）。
import React, { useCallback, useEffect, useState } from "react";
import { req, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";

interface ModelRow {
  id: string; name: string; credits?: number | string; vendor?: string; provider?: boolean;
  // 上游目录全字段透出（对齐 Go 面板 mdRowHtml 徽标与档位/窗口列，缺失不显示）
  is_default?: boolean;
  supports_tool_call?: boolean;
  supports_images?: boolean;
  supports_reasoning?: boolean;
  only_reasoning?: boolean;
  can_disable_thinking?: boolean;
  reasoning_summary?: string;
  tags?: string[];
  promo_factor?: number;
  promo_credits?: string;
  promo_label?: string;
  promo_note?: string;
  promo_window?: string;
  promo_next_window?: string;
  default_effort?: string;
  supported_efforts?: string[];
  context_length?: number;
  max_output_tokens?: number;
  description?: string;
}
interface TestResult {
  model: string; first_token_ms: number; total_ms: number;
  output_tokens: number; tokens_per_sec: number;
  gen_ms?: number; chunks?: number; output_chars?: number; usage_tokens?: number | null;
}
interface ProbeRec {
  claimed: number | null; measured: number | null; verdict: string;
  note: string; tested_at: string; source: string;
}

// fmtK / probeDays / ProbeCell 移植 Go 面板 app.js 的实测上限标注（五态之三）。
function fmtK(n: number): string { return n >= 1000 ? Math.round(n / 1000) + "K" : String(n); }
function probeDays(ts: string): number | null {
  if (!ts) return null;
  const d = (Date.now() - new Date(ts).getTime()) / 86400000;
  return isNaN(d) ? null : Math.floor(d);
}
function ProbeCell({ pr }: { pr: ProbeRec | undefined }) {
  if (!pr) return <span className="dim">—</span>;
  const tip = `声称 ${pr.claimed ? fmtK(pr.claimed) : "?"} · 实测 ${pr.measured ? fmtK(pr.measured) : "?"}` +
    (pr.note ? " · " + pr.note : "") + (pr.tested_at ? " · 探测于 " + new Date(pr.tested_at).toLocaleString("zh-CN", { hour12: false }) : "");
  const days = probeDays(pr.tested_at);
  const stale = days !== null && days > 30 ? ` · ${days} 天前` : "";
  if (pr.verdict === "clamped" && pr.measured) {
    if (pr.claimed && pr.measured < pr.claimed) {
      const x = pr.claimed / pr.measured;
      const xs = (x >= 10 ? Math.round(x) : Math.round(x * 10) / 10) + "×";
      return (
        <span title={tip}>
          <span style={{ color: "var(--warn)", fontWeight: 600 }}>{fmtK(pr.measured)} ⚠</span>
          <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>钳制 {xs}{stale}</div>
        </span>
      );
    }
    return (
      <span title={tip}>
        <span style={{ color: "var(--ok)" }}>{fmtK(pr.measured)}{pr.claimed && pr.measured > pr.claimed ? " ↑" : " ✓"}</span>
      </span>
    );
  }
  if (pr.verdict === "at_least" && pr.measured) {
    return <span title={tip} style={{ color: "var(--fg-dim)" }}>≥{fmtK(pr.measured)}</span>;
  }
  return (
    <span title={tip}>
      <span style={{ color: "var(--fg-dim)" }}>?</span>
      <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>未测出{stale}</div>
    </span>
  );
}

// 实测状态分级：对齐 CloseRouter 测速页的直观好坏提示。
function gradeOf(r: TestResult): { cls: string; text: string } {
  const tps = r.tokens_per_sec;
  if (tps >= 30 && r.first_token_ms <= 1500) return { cls: "ok", text: "优秀" };
  if (tps >= 15 && r.first_token_ms <= 3000) return { cls: "info", text: "良好" };
  return { cls: "warn", text: "偏慢" };
}

// rateText 把上游 credits 原文（"x0.69" / "0.50x" / "x0.00"）归一成可读倍率。
function rateText(v: number | string | undefined): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return v === 0 ? "免费" : `${Math.round(v * 100) / 100}×`;
  const s = v.trim();
  const m = s.match(/^x?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!m) return s;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return s;
  if (n === 0) return "免费";
  return `${Math.round(n * 100) / 100}×`;
}

// badgeTags 解析企业目录塞在 tags 里的彩色徽章：badge:标签:#RRGGBB。
function badgeTags(tags?: string[]): { label: string; color?: string }[] {
  const out: { label: string; color?: string }[] = [];
  for (const t of tags ?? []) {
    if (!t.startsWith("badge:")) continue;
    const parts = t.split(":");
    const label = (parts[1] ?? "").trim();
    const color = (parts[2] ?? "").trim();
    if (label) out.push({ label, color: /^#[0-9a-f]{6}$/i.test(color) ? color : undefined });
  }
  return out;
}

// promoOf 统一优惠徽标：优先 promo_label，其次企业 tags 里的 badge。
// 只有标签没有 factor 时也能显示，但不编造折后价。
function promoOf(m: ModelRow): { label: string; cls: string; color?: string; note?: string } | null {
  const tagBadge = badgeTags(m.tags)[0];
  const label = m.promo_label || tagBadge?.label;
  if (!label) return null;
  const hasFactor = typeof m.promo_factor === "number";
  const cls = m.promo_factor === 0 ? "ok" : hasFactor ? "warn" : "info";
  const note = [m.promo_note, m.promo_window].filter(Boolean).join(" · ") || undefined;
  return { label, cls, color: tagBadge?.color, note };
}

// PromoPrice 牌价/生效价：有 factor 才显示折后，factor=0 显示免费。
function PromoPrice({ m }: { m: ModelRow }) {
  const base = rateText(m.credits);
  if (typeof m.promo_factor !== "number") {
    return base ? <span className="dim">{base}</span> : <span className="dim">—</span>;
  }
  if (m.promo_factor === 0) {
    return (
      <span title={m.promo_note} style={{ whiteSpace: "nowrap" }}>
        {base && base !== "免费" && <s className="dim" style={{ marginRight: 5 }}>{base}</s>}
        <span className="tag ok">免费</span>
      </span>
    );
  }
  const eff = rateText(m.promo_credits);
  return (
    <span title={m.promo_note} style={{ whiteSpace: "nowrap" }}>
      {base && base !== "免费" && <s className="dim" style={{ marginRight: 5 }}>{base}</s>}
      {eff ? <span className="tag ok">{eff}</span> : <span className="dim">折扣中</span>}
    </span>
  );
}

// CapBadges 能力徽标：默认模型 / 供应商 / 工具调用 / 视觉 / 思考常开（对齐
// Go 面板 mdRowHtml：上游目录全字段透出，缺失不显示）。
function CapBadges({ m }: { m: ModelRow }) {
  const caps: React.ReactNode[] = [];
  if (m.is_default) caps.push(<span key="d" className="tag ok">默认</span>);
  if (m.provider) caps.push(<span key="p" className="tag ok">供应商</span>);
  const promo = promoOf(m);
  if (promo) {
    const style = promo.color
      ? { color: promo.color, borderColor: promo.color, background: promo.color + "14" }
      : undefined;
    caps.push(<span key="promo" className={"tag " + promo.cls} title={promo.note} style={style}>{promo.label}</span>);
    if (m.promo_window) caps.push(<span key="win" className="dim" style={{ fontSize: 11.5, alignSelf: "center" }}>{m.promo_window}</span>);
  } else if (m.promo_next_window) {
    caps.push(<span key="next" className="dim" title="优惠未生效时段" style={{ fontSize: 11.5, alignSelf: "center" }}>⏳ 优惠时段 {m.promo_next_window}</span>);
  }
  if (m.supports_tool_call) caps.push(<span key="t" className="tag warn">工具</span>);
  if (m.supports_images) caps.push(<span key="v" className="tag warn">视觉</span>);
  if (m.only_reasoning) caps.push(<span key="r" className="tag info">仅思考</span>);
  else if (m.supports_reasoning && m.can_disable_thinking) caps.push(<span key="r" className="tag ok">可关思考</span>);
  else if (m.supports_reasoning) caps.push(<span key="r" className="tag warn">思考常开</span>);
  if (caps.length === 0) return null;
  return <div style={{ marginTop: 3, display: "flex", gap: 4, flexWrap: "wrap" }}>{caps}</div>;
}

// CAP_FILTERS 列表筛选 chip；多选时取交集。
const CAP_FILTERS: { key: string; label: string; test: (m: ModelRow) => boolean }[] = [
  { key: "promo", label: "有优惠", test: (m) => promoOf(m) !== null },
  { key: "free", label: "免费", test: (m) => m.promo_factor === 0 },
  { key: "vision", label: "视觉", test: (m) => !!m.supports_images },
  { key: "tool", label: "工具", test: (m) => !!m.supports_tool_call },
  { key: "reasoning", label: "推理", test: (m) => !!m.supports_reasoning },
  { key: "only", label: "仅思考", test: (m) => !!m.only_reasoning },
  { key: "disable", label: "可关思考", test: (m) => !!m.can_disable_thinking },
  { key: "default", label: "默认", test: (m) => !!m.is_default },
];

// EffortCell 支持的思考档位（对齐 Go：可关思考补 "off（可关）"；无档位列表时
// 退化为「固定档 · 默认 X / 不支持思考」文案）。
function EffortCell({ m }: { m: ModelRow }) {
  const eff = (m.supported_efforts ?? []).slice();
  if (m.can_disable_thinking && eff.length && !eff.includes("off")) eff.push("off（可关）");
  if (eff.length === 0) {
    // summary=auto 时上游不定义固定档（auto 路由按任务自动匹配），显示「自动」。
    if (m.reasoning_summary === "auto") {
      return <span className="tag info">自动</span>;
    }
    return (
      <span className="dim" style={{ fontSize: 12.5 }}>
        {m.supports_reasoning ? "固定档 · 默认 " + (m.default_effort || "?") : "不支持思考"}
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      {eff.map((e) => <span key={e} className="tag warn">{e}</span>)}
    </span>
  );
}

export function ModelsView({ flash }: { flash: Flash }) {
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [src, setSrc] = useState<"" | "pool" | "provider">("");
  const [realm, setRealm] = useState<"" | "cn" | "global">("");
  const [capFilters, setCapFilters] = useState<string[]>([]);
  const [results, setResults] = useState<Record<string, TestResult | "running" | string>>({});
  const [probes, setProbes] = useState<Record<string, ProbeRec>>({});
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      req<{ models: ModelRow[] }>("models"),
      req<{ probes: Record<string, ProbeRec> }>("model_probes").catch(() => ({ probes: {} })),
    ])
      .then(([r, pr]) => { setModels(r.models); setProbes(pr.probes ?? {}); setLoadedAt(Date.now()); })
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [flash]);
  useEffect(load, [load]);
  useAutoRefresh(load, 120_000);
  usePanelRefresh(load);

  const test = useCallback(async (m: ModelRow) => {
    const id = m.id;
    setResults((r) => ({ ...r, [id]: "running" }));
    try {
      const r = await req<{ result: TestResult }>("models/test", { method: "POST", body: { model: id } });
      setResults((s) => ({ ...s, [id]: r.result }));
    } catch (e) {
      setResults((s) => ({ ...s, [id]: e instanceof Error ? e.message : String(e) }));
    }
  }, []);

  // 探测键带域前缀（cn:glm-5.2），模型表 id 已是全前缀，直接精确命中。
  const probeOf = (id: string) => probes[id];

  const probe = useCallback(async (m: ModelRow) => {
    const id = m.id;
    setProbing((s) => ({ ...s, [id]: true }));
    try {
      // 已有可信结论时本次为强制重测（上游可能改限）；服务端默认命中缓存直接返回，不再探测。
      const cur = probes[id];
      const force = !!(cur && (cur.verdict === "clamped" || cur.verdict === "at_least") && cur.measured !== null);
      const r = await req<{ cached?: boolean; result: { measured: number | null; verdict: string; note: string; elapsed_s: number } }>(
        "models/probe", { method: "POST", body: { model: id, force } });
      // 探测结果落库，本地同步刷新该行（claimed 面板探测未知，置 null）。
      setProbes((s) => ({
        ...s,
        [id]: {
          claimed: null, measured: r.result.measured, verdict: r.result.verdict,
          note: r.result.note, tested_at: new Date().toISOString(), source: "panel-probe",
        },
      }));
      flash("ok", r.cached
        ? `${id} 已有实测结论（${r.result.verdict}${r.result.measured ? " " + fmtK(r.result.measured) : ""}），未重复探测`
        : `${id} 探测完成：${r.result.verdict}${r.result.measured ? " " + fmtK(r.result.measured) : ""}`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setProbing((s) => ({ ...s, [id]: false }));
    }
  }, [flash, probes]);

  const filtered = (models ?? []).filter((m) => {
    if (src === "pool" && m.provider) return false;
    if (src === "provider" && !m.provider) return false;
    if (realm === "cn" && !m.id.startsWith("cn:")) return false;
    if (realm === "global" && !m.id.startsWith("global:")) return false;
    for (const k of capFilters) {
      const f = CAP_FILTERS.find((x) => x.key === k);
      if (f && !f.test(m)) return false;
    }
    const needle = q.trim().toLowerCase();
    return needle === "" || m.id.toLowerCase().includes(needle) || (m.vendor ?? "").toLowerCase().includes(needle);
  });

  const toggleCap = (k: string) =>
    setCapFilters((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));

  return (
    <Box title="模型能力"
      hint="实时查询上游；max_tokens 可正常透传，官方返回的最大输出仅为参考"
      extra={<>
        <input className="input" style={{ width: 200 }} placeholder="过滤模型 / 供应商"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="btn-row" style={{ gap: 4 }}>
          {([["", "全部"], ["pool", "池"], ["provider", "供应商"]] as const).map(([v, label]) => (
            <button key={v} className={"btn xs" + (src === v ? " primary" : "")} onClick={() => setSrc(v)}>{label}</button>
          ))}
        </div>
        <div className="btn-row" style={{ gap: 4 }}>
          {([["", "全部域"], ["cn", "CN"], ["global", "全球"]] as const).map(([v, label]) => (
            <button key={v} className={"btn xs" + (realm === v ? " primary" : "")} onClick={() => setRealm(v)}>{label}</button>
          ))}
        </div>
        <button className="btn xs" onClick={load} disabled={loading}>
          {loading ? "获取中…" : "重新获取"}
        </button>
        {loadedAt && <span className="dim" style={{ fontSize: 12, alignSelf: "center" }}>
          更新于 {new Date(loadedAt).toLocaleTimeString("zh-CN", { hour12: false })}
        </span>}
      </>}>
      {!models ? (
        <div className="pad dim">实时查询上游中…</div>
      ) : (
        <>
          <div className="pad" style={{ paddingBottom: 6, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span className="dim" style={{ fontSize: 12 }}>筛选</span>
            {CAP_FILTERS.map((f) => (
              <button key={f.key} className={"btn xs" + (capFilters.includes(f.key) ? " primary" : "")}
                aria-pressed={capFilters.includes(f.key)} onClick={() => toggleCap(f.key)}>{f.label}</button>
            ))}
            {capFilters.length > 0 && (
              <button className="btn xs ghost" onClick={() => setCapFilters([])}>清除</button>
            )}
            <span className="dim" style={{ fontSize: 12, marginLeft: "auto" }}>
              {filtered.length} / {models.length}
            </span>
          </div>
          <div className="tbl-wrap">
            <table className="tbl tbl-models">
            <thead><tr><th>模型 ID</th><th>名称</th><th>来源</th><th>积分/1k</th><th>默认档</th><th>支持的思考档位</th><th>上下文长度</th><th>最大输出</th><th>实测上限</th><th>实测</th><th style={{ width: 1 }}></th></tr></thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={11} className="dim" style={{ textAlign: "center", padding: 24 }}>无匹配模型</td></tr>}
              {filtered.map((m) => {
                const r = results[m.id];
                const open = expanded === m.id;
                const pr = probeOf(m.id);
                return (
                  <React.Fragment key={m.id}>
                    <tr style={open ? { background: "var(--bg-soft)" } : undefined}>
                      <td className="mono">{m.id}<CapBadges m={m} /></td>
                      <td title={m.description}>{m.name}</td>
                      <td>{m.provider ? <span className="tag info">{m.vendor}</span> : <span className="tag">池</span>}</td>
                      <td><PromoPrice m={m} /></td>
                      <td>{m.default_effort ? <span className="tag ok">{m.default_effort}</span> : <span className="dim">—</span>}</td>
                      <td style={{ whiteSpace: "normal" }}><EffortCell m={m} /></td>
                      <td className="mono dim">{m.context_length ? fmtK(m.context_length) : "—"}</td>
                      <td className="mono dim">{m.max_output_tokens ? fmtK(m.max_output_tokens) : "—"}</td>
                      <td className="mono" style={{ fontSize: 12 }}><ProbeCell pr={pr} /></td>
                      <td>
                        {r === undefined && <span className="dim">-</span>}
                        {r === "running" && <span className="md-prog">测试中…</span>}
                        {typeof r === "string" && r !== "running" && (
                          // 错误串可能很长（上游 JSON / 堆栈），单元格内截断，完整内容放 title 与详情行。
                          <span className="tag err md-test-err" title={r}>{r}</span>
                        )}
                        {typeof r === "object" && (
                          <>
                            <span className={"tag " + gradeOf(r).cls}>{gradeOf(r).text}</span>{" "}
                            <span className="mono" style={{ fontSize: 12 }}>
                              TTFT {r.first_token_ms}ms · {r.tokens_per_sec} tok/s
                            </span>
                          </>
                        )}
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        <div className="btn-row" style={{ flexWrap: "nowrap" }}>
                          <button className="btn small" disabled={r === "running"} onClick={() => test(m)}>
                            {r === "running" ? "…" : "实测"}
                          </button>
                          <button className="btn small ghost" disabled={probing[m.id]} onClick={() => probe(m)}
                            title={probeOf(m.id) && probeOf(m.id)!.measured !== null
                              ? "已有实测结论（落库），点击强制重测（耗时较长）"
                              : "阶梯上探真实输出上限（耗时较长，结果落库，已有结论时不再重复探测）"}>
                            {probing[m.id] ? "探测中…" : (probeOf(m.id) && probeOf(m.id)!.measured !== null ? "重测" : "探测")}
                          </button>
                          {r !== undefined && r !== "running" && (
                            <button className="btn small ghost" onClick={() => setExpanded(open ? null : m.id)}>
                              {open ? "收起" : "详情"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td colSpan={11} style={{ background: "var(--bg-soft)", padding: "10px 16px" }}>
                          {typeof r === "object" ? <TestDetail r={r} /> : (
                            <div className="md-err-detail" role="alert">
                              <div className="hd">实测失败</div>
                              <div className="bd">{String(r)}</div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
            </table>
          </div>
        </>
      )}
    </Box>
  );
}

// TestDetail：实测细分面板（CloseRouter SpeedTester 口径）。
function TestDetail({ r }: { r: TestResult }) {
  const genMs = r.gen_ms ?? Math.max(0, r.total_ms - r.first_token_ms);
  const firstPct = r.total_ms > 0 ? Math.min(1, r.first_token_ms / r.total_ms) : 0;
  return (
    <div className="md-detail">
      <div className="md-metrics">
        <div className="stat">
          <div className="stat-label">首字延迟 TTFT</div>
          <span className="stat-num">{r.first_token_ms}</span><span className="stat-unit">MS</span>
        </div>
        <div className="stat">
          <div className="stat-label">生成吞吐</div>
          <span className="stat-num">{r.tokens_per_sec}</span><span className="stat-unit">TOK/S</span>
        </div>
        <div className="stat">
          <div className="stat-label">总耗时</div>
          <span className="stat-num">{r.total_ms}</span><span className="stat-unit">MS</span>
        </div>
        <div className="stat">
          <div className="stat-label">输出 TOKENS</div>
          <span className="stat-num">{r.usage_tokens ?? r.output_tokens}</span>
          <span className="stat-unit">{r.usage_tokens != null ? "USAGE" : "估算"}</span>
        </div>
      </div>
      <div className="md-timeline" title={"首字前 " + r.first_token_ms + "ms · 生成 " + genMs + "ms"}>
        <i className="ttft" style={{ width: (firstPct * 100).toFixed(1) + "%" }}></i>
        <i className="gen" style={{ width: ((1 - firstPct) * 100).toFixed(1) + "%" }}></i>
      </div>
      <div className="md-timeline-legend">
        <span><i className="sw ttft"></i>首字前 {r.first_token_ms} ms（{(firstPct * 100).toFixed(0)}%）</span>
        <span><i className="sw gen"></i>生成 {genMs} ms（{((1 - firstPct) * 100).toFixed(0)}%）</span>
      </div>
      <div className="kv-grid" style={{ marginTop: 10 }}>
        <span className="dim">模型</span><span className="mono">{r.model}</span>
        <span className="dim">输出字符</span><span>{r.output_chars ?? "-"}</span>
        <span className="dim">SSE 帧数</span><span>{r.chunks ?? "-"}</span>
        <span className="dim">口径</span><span>tok/s = 输出 tokens ÷（总耗时 − TTFT）</span>
      </div>
    </div>
  );
}
