"use client";
// 模型与档位视图（对齐 Go view-models）：实时模型目录 + 连通性实测（池/供应商双通道）。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { req, useAutoRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";

interface ModelRow { id: string; name: string; credits?: number | string; vendor?: string; provider?: boolean }
interface TestResult { model: string; first_token_ms: number; total_ms: number; output_tokens: number; tokens_per_sec: number }

export function ModelsView({ flash }: { flash: Flash }) {
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [q, setQ] = useState("");
  const [src, setSrc] = useState<"" | "pool" | "provider">("");
  const [results, setResults] = useState<Record<string, TestResult | "running" | string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const gen = useRef(0);

  const load = useCallback(() => {
    setLoading(true);
    req<{ models: ModelRow[] }>("models")
      .then((r) => { setModels(r.models); setLoadedAt(Date.now()); })
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [flash]);
  useEffect(load, [load]);
  useAutoRefresh(load, 120_000);

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
            <thead><tr><th>模型 ID</th><th>名称</th><th>来源</th><th>积分/1k</th><th>实测</th><th style={{ width: 1 }}></th></tr></thead>
            <tbody>
              {filtered.length === 0 && <tr><td colSpan={6} className="dim" style={{ textAlign: "center", padding: 24 }}>无匹配模型</td></tr>}
              {filtered.map((m) => {
                const r = results[m.id];
                const open = expanded === m.id;
                return (
                  <React.Fragment key={m.id}>
                    <tr style={open ? { background: "var(--bg-soft)" } : undefined}>
                      <td className="mono">{m.id}</td>
                      <td>{m.name}</td>
                      <td>{m.provider ? <span className="tag info">{m.vendor}</span> : <span className="tag">池</span>}</td>
                      <td className="dim">{m.credits === "" || m.credits === undefined ? "-" : m.credits}</td>
                      <td>
                        {r === undefined && <span className="dim">-</span>}
                        {r === "running" && <span className="md-prog">测试中…</span>}
                        {typeof r === "string" && r !== "running" && <span className="tag err">{r}</span>}
                        {typeof r === "object" && (
                          <span className="tag ok">
                            首字 {r.first_token_ms}ms · {r.tokens_per_sec} tok/s
                          </span>
                        )}
                      </td>
                      <td>
                        <div className="btn-row" style={{ flexWrap: "nowrap" }}>
                          <button className="btn small" disabled={r === "running"} onClick={() => test(m)}>
                            {r === "running" ? "…" : "实测"}
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
                        <td colSpan={6} style={{ background: "var(--bg-soft)", padding: "10px 16px" }}>
                          {typeof r === "object" ? (
                            <div className="kv-grid">
                              <span className="dim">模型</span><span className="mono">{r.model}</span>
                              <span className="dim">首字延迟</span><span>{r.first_token_ms} ms</span>
                              <span className="dim">总耗时</span><span>{r.total_ms} ms</span>
                              <span className="dim">输出 tokens</span><span>{r.output_tokens}</span>
                              <span className="dim">吞吐</span><span>{r.tokens_per_sec} tok/s</span>
                              <span className="dim">输入侧耗时</span><span>{Math.max(0, r.first_token_ms)} ms（首字前）</span>
                              <span className="dim">生成侧耗时</span><span>{Math.max(0, r.total_ms - r.first_token_ms)} ms</span>
                            </div>
                          ) : (
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
