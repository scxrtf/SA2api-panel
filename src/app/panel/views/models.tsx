"use client";
// 模型与档位视图（对齐 Go view-models）：实时模型目录 + 连通性实测（池/供应商双通道）。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { req, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";

interface ModelRow {
  id: string; name: string; credits?: number | string; vendor?: string; provider?: boolean;
  // 上游目录全字段透出（对齐 Go 面板 mdRowHtml 徽标与档位/窗口列，缺失不显示）
  is_default?: boolean;
  supports_tool_call?: boolean;
  supports_images?: boolean;
  supports_reasoning?: boolean;
  can_disable_thinking?: boolean;
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

// CapBadges 能力徽标：默认模型 / 供应商 / 工具调用 / 视觉 / 思考常开（对齐
// Go 面板 mdRowHtml：上游目录全字段透出，缺失不显示）。
function CapBadges({ m }: { m: ModelRow }) {
  const caps: React.ReactNode[] = [];
  if (m.is_default) caps.push(<span key="d" className="tag ok">默认</span>);
  if (m.provider) caps.push(<span key="p" className="tag ok">供应商</span>);
  if (m.supports_tool_call) caps.push(<span key="t" className="tag warn">工具</span>);
  if (m.supports_images) caps.push(<span key="v" className="tag warn">视觉</span>);
  if (m.supports_reasoning && !m.can_disable_thinking) caps.push(<span key="r" className="tag warn">思考常开</span>);
  if (caps.length === 0) return null;
  return <div style={{ marginTop: 3, display: "flex", gap: 4, flexWrap: "wrap" }}>{caps}</div>;
}

// EffortCell 支持的思考档位（对齐 Go：可关思考补 "off（可关）"；无档位列表时
// 退化为「固定档 · 默认 X / 不支持思考」文案）。
function EffortCell({ m }: { m: ModelRow }) {
  const eff = (m.supported_efforts ?? []).slice();
  if (m.can_disable_thinking && eff.length && !eff.includes("off")) eff.push("off（可关）");
  if (eff.length === 0) {
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
  const [results, setResults] = useState<Record<string, TestResult | "running" | string>>({});
  const [probes, setProbes] = useState<Record<string, ProbeRec>>({});
  const [probing, setProbing] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const gen = useRef(0);

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
    return q === "" || m.id.toLowerCase().includes(q.toLowerCase()) || (m.vendor ?? "").toLowerCase().includes(q.toLowerCase());
  });

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
        <div className="tbl-wrap">
          <table className="tbl">
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
                      <td className="dim">{m.credits === "" || m.credits === undefined ? "-" : m.credits}</td>
                      <td>{m.default_effort ? <span className="tag ok">{m.default_effort}</span> : <span className="dim">—</span>}</td>
                      <td style={{ whiteSpace: "normal" }}><EffortCell m={m} /></td>
                      <td className="mono dim">{m.context_length ? fmtK(m.context_length) : "—"}</td>
                      <td className="mono dim">{m.max_output_tokens ? fmtK(m.max_output_tokens) : "—"}</td>
                      <td className="mono" style={{ fontSize: 12 }}><ProbeCell pr={pr} /></td>
                      <td>
                        {r === undefined && <span className="dim">-</span>}
                        {r === "running" && <span className="md-prog">测试中…</span>}
                        {typeof r === "string" && r !== "running" && <span className="tag err">{r}</span>}
                        {typeof r === "object" && (
                          <>
                            <span className={"tag " + gradeOf(r).cls}>{gradeOf(r).text}</span>{" "}
                            <span className="mono" style={{ fontSize: 12 }}>
                              TTFT {r.first_token_ms}ms · {r.tokens_per_sec} tok/s
                            </span>
                          </>
                        )}
                      </td>
                      <td>
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
                            <span className="tag err">{String(r)}</span>
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
