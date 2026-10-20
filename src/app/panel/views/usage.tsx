"use client";
// 用量视图（对齐 Go app.js renderUsage 全量同构）：
// totals 六 KPI 卡（含 prompt/completion 构成条）+ 五维度切换明细表 +
// 积分双维表 + 时序图。口径与 /api/panel/usage（Go Snapshot 同构 JSON）一一对应。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { req, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";
import { UsageChart, type SeriesPoint } from "../components/usageChart";

/* ── 类型：/api/panel/usage 响应（Go Snapshot 同构） ─────────────── */
interface Agg {
  requests: number; errors: number;
  prompt_tokens: number; completion_tokens: number; total_tokens: number;
  credits: number; credit_samples: number; credit_tokens: number;
  credits_per_1m_tokens: number;
  cache_hit_tokens: number; cache_miss_tokens: number; cache_hit_rate: number;
  avg_latency_ms: number; avg_tokens_per_second: number;
}

interface KeyedRow { key: string; realm?: string; extra?: string; agg: Agg }

interface CreditRow {
  key: string; realm?: string; nickname?: string; rate?: string;
  requests: number; credits: number; credit_samples: number; credit_tokens: number;
  credits_per_1m_tokens: number;
  cache_hit_tokens: number; cache_miss_tokens: number; cache_hit_rate: number;
}

interface UsageResp {
  totals: Agg;
  by_realm: KeyedRow[];
  by_account: KeyedRow[];
  by_model: KeyedRow[];
  by_key: KeyedRow[];
  by_provider: KeyedRow[];
  by_provider_model: KeyedRow[];
  credit_by_account: CreditRow[];
  credit_by_model: CreditRow[];
  credit_by_key: CreditRow[];
  series: SeriesPoint[];
  buckets: number;
  since: string;
  window_from: string;
  window_to: string;
  generated: string;
}

/* ── 展示工具（Go app.js 同名函数同语义） ──────────────────────── */
function fmtTok(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "k";
  return String(v);
}

function fmtMs(ms: number | null | undefined): string {
  const v = Number(ms ?? 0);
  if (!v) return "—";
  return v >= 1000 ? (v / 1000).toFixed(2) + "s" : Math.round(v) + "ms";
}

function fmtRate(r: number | null | undefined): string {
  return r ? Number(r).toFixed(1) + " tok/s" : "—";
}

// trimFixed 去尾零：12.50 → 12.5，12.00 → 12（Go 同名）。
function trimFixed(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

function fmtCredit(n: number | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? trimFixed(v.toFixed(2)) : "—";
}

// fmtCreditRatio：无样本/无 Token 不伪造数字，直接 "—"（Go 同名）。
function fmtCreditRatio(v: number, samples: number, tokens: number): string {
  if (!samples || !tokens) return "—";
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? trimFixed(n.toFixed(4)) + " / 1M" : "—";
}

function fmtModelRate(rate: string | null | undefined): string {
  const s = (rate ?? "").trim();
  return s ? "x" + s : "—";
}

// usPct：占比文案，无样本显示 "—" 而不是 0.0%（Go 同名）。
function usPct(part: number, total: number): string {
  if (!total) return "—";
  return (Number(part ?? 0) / total * 100).toFixed(1) + "%";
}

function cacheRateText(hit: number, miss: number): string {
  const h = Number(hit ?? 0), m = Number(miss ?? 0);
  if (!h && !m) return "—";
  return String(Math.round(h / (h + m) * 1000) / 10) + "%";
}

// cacheRateColor：≥90 绿 / 80–90 黄 / <80 红（Go cacheRateCell 的色阶）。
function cacheRateColor(hit: number, miss: number): string {
  const h = Number(hit ?? 0), m = Number(miss ?? 0);
  if (!h && !m) return "var(--fg-dim)";
  const pct = h / (h + m) * 100;
  return pct >= 90 ? "var(--ok)" : pct >= 80 ? "var(--warn)" : "var(--err)";
}

// realmLabel 美化："provider:artex" → "供应商 · artex"（Go 同名）。
function realmLabel(realm: string | null | undefined): string {
  const r = String(realm ?? "");
  if (r.startsWith("provider:")) return "供应商 · " + r.slice("provider:".length);
  return r || "—";
}

/* ── KPI 卡（Go usKpi 同构：标题大数字 + 构成条 + 副标题） ──────── */
function Kpi({ value, label, color, sub, bar }: {
  value: string; label: string; color?: string; sub?: string; bar?: React.ReactNode;
}) {
  return (
    <div className="kpi" style={color ? ({ ["--kpi-accent" as string]: color } as React.CSSProperties) : undefined}>
      <div className="k">{label}</div>
      <div className="v" style={color ? { color } : undefined}>{value}</div>
      {bar}
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

// 构成条：合法 CSS 宽度由这里保证，usPct 的 "—" 不能进 style（Go pctW 同语义）。
function pctWidth(part: number, total: number): string {
  if (!total) return "0%";
  return Math.max(0, Math.min(100, Number(part ?? 0) / total * 100)).toFixed(2) + "%";
}

// MixBar 表格内的 prompt/completion 双色条（Go usMixBar 同构）。
function MixBar({ prompt, completion, total }: { prompt: number; completion: number; total: number }) {
  if (!total) return null;
  const pp = Math.max(0, Math.min(100, prompt / total * 100));
  const pc = Math.max(0, Math.min(100, completion / total * 100));
  return (
    <span className="us-mix" title={"prompt " + pp.toFixed(1) + "% · completion " + pc.toFixed(1) + "%"}>
      <i className="p" style={{ width: pp.toFixed(2) + "%" }}></i>
      <i className="c" style={{ width: pc.toFixed(2) + "%" }}></i>
    </span>
  );
}

/* ── 维度定义（Go US_DIMS 同构） ────────────────────────────────── */
type DimKey = "account" | "key" | "model" | "provider" | "realm";
const DIMS: Record<DimKey, { key: keyof UsageResp; title: string; withRealm: boolean; withPerf: boolean; span: number }> = {
  account: { key: "by_account", title: "账号", withRealm: true, withPerf: true, span: 10 },
  key: { key: "by_key", title: "Key 归属", withRealm: true, withPerf: true, span: 10 },
  model: { key: "by_model", title: "模型", withRealm: false, withPerf: false, span: 7 },
  provider: { key: "by_provider", title: "供应商", withRealm: false, withPerf: false, span: 7 },
  realm: { key: "by_realm", title: "域", withRealm: false, withPerf: false, span: 7 },
};
const DIM_TABS: [DimKey, string][] = [
  ["account", "按账号"], ["key", "按 Key"], ["model", "按模型"],
  ["provider", "按供应商"], ["realm", "按域"],
];

type SortKey = "total" | "requests" | "errors" | "latency";

function sortRows(rows: KeyedRow[], sort: SortKey): KeyedRow[] {
  const val = (a: KeyedRow) => sort === "requests" ? a.agg.requests
    : sort === "errors" ? a.agg.errors
    : sort === "latency" ? a.agg.avg_latency_ms
    : a.agg.total_tokens;
  return rows.slice().sort((a, b) => val(b) - val(a));
}

// DimRow 明细行：withPerf 控制延迟/速率两列（Go usRow 同构）。
function DimRow({ name, sub, a, realm, withPerf }: {
  name: string; sub?: string; a: Agg; realm?: string; withPerf: boolean;
}) {
  return (
    <tr>
      <td className="mark" aria-hidden="true"></td>
      <td>
        {name}
        {sub && <div className="note">{sub}</div>}
      </td>
      {realm !== undefined && <td className="num">{realmLabel(realm)}</td>}
      <td className="num">{fmtTok(a.requests)}</td>
      <td className="num">{a.errors
        ? <span style={{ color: "var(--warn)" }}>{fmtTok(a.errors)}</span>
        : "—"}</td>
      <td className="num">{fmtTok(a.prompt_tokens)}</td>
      <td className="num">{fmtTok(a.completion_tokens)}</td>
      <td className="num">
        {fmtTok(a.total_tokens)}
        <MixBar prompt={a.prompt_tokens} completion={a.completion_tokens} total={a.total_tokens} />
      </td>
      {withPerf && <>
        <td className="num">{fmtMs(a.avg_latency_ms)}</td>
        <td className="num">{fmtRate(a.avg_tokens_per_second)}</td>
      </>}
    </tr>
  );
}

/* ── 视图 ───────────────────────────────────────────────────────── */
export function UsageView({ flash }: { flash: Flash }) {
  const [hours, setHours] = useState(72);
  const [u, setU] = useState<UsageResp | null>(null);
  const [dim, setDim] = useState<DimKey>("account");
  const [sort, setSort] = useState<SortKey>("total");
  const [creditDim, setCreditDim] = useState<"account" | "model" | "key">("account");
  const [provOpen, setProvOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    req<UsageResp>("usage?hours=" + hours).then(setU)
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [hours, flash]);
  useEffect(load, [load]);
  useAutoRefresh(load, 30_000);
  // 顶栏「刷新」按钮广播的事件：否则在该 tab 点刷新只更新了侧边栏统计。
  usePanelRefresh(load);

  const rows = useMemo(() => {
    if (!u) return [] as KeyedRow[];
    return sortRows((u[DIMS[dim].key] as KeyedRow[]) ?? [], sort);
  }, [u, dim, sort]);

  // 供应商维度：行下展开该供应商各模型明细（Go by_provider_model）。
  const provSubs = useMemo(() => {
    const m = new Map<string, KeyedRow[]>();
    if (!u) return m;
    for (const p of u.by_provider_model ?? []) {
      const k = p.realm ?? "";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(p);
    }
    return m;
  }, [u]);

  if (!u) return <Box title="用量统计" pad><div className="dim">加载用量…</div></Box>;

  const t = u.totals;
  const total = t.total_tokens, pt = t.prompt_tokens, ct = t.completion_tokens;
  const reqs = t.requests, errs = t.errors;
  const okRate = reqs ? (reqs - errs) / reqs * 100 : null;
  const m = DIMS[dim];

  const dimTabs = (
    <div className="ustabs">
      {DIM_TABS.map(([k, label]) => {
        const n = ((u[DIMS[k].key] as KeyedRow[]) ?? []).length;
        return (
          <button key={k} className={k === dim ? "on" : ""} onClick={() => setDim(k)}>
            {label}<span className="cnt">{n}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <Box title="用量统计" hint="请求与积分均按所选窗口统计" extra={<>
        <select className="select" style={{ width: 140 }} value={hours}
          onChange={(e) => setHours(Number(e.target.value))}>
          <option value={24}>近 24 小时</option><option value={72}>近 3 天</option>
          <option value={168}>近 7 天</option><option value={720}>近 30 天</option>
          <option value={0}>全部历史</option>
        </select>
        <button className="btn xs" onClick={load}>刷新</button>
      </>}>
        <div className="pad">
          <div className="kpi-grid">
            <Kpi value={fmtTok(reqs)} label="请求数" color="var(--accent)"
              sub={errs ? "其中失败 " + errs + " 次" : "全部成功"} />
            <Kpi value={fmtTok(total)} label="总 token" color="var(--accent)"
              sub={"prompt " + usPct(pt, total) + " · completion " + usPct(ct, total)}
              bar={<div className="kbar">
                <i style={{ width: pctWidth(pt, total), background: "var(--us-prompt)" }}></i>
                <i style={{ width: pctWidth(ct, total), background: "var(--ok)" }}></i>
              </div>} />
            <Kpi value={fmtTok(pt)} label="prompt" color="var(--us-prompt)" sub={"占比 " + usPct(pt, total)} />
            <Kpi value={fmtTok(ct)} label="completion" color="var(--ok)" sub={"占比 " + usPct(ct, total)} />
            <Kpi value={String(errs)} label="失败尝试" color={errs ? "var(--warn)" : undefined}
              sub={okRate == null ? "—" : errs ? "成功率 " + okRate.toFixed(1) + "%" : "成功率 100%"} />
            <Kpi value={fmtMs(t.avg_latency_ms)} label="平均延迟"
              sub={t.avg_tokens_per_second ? "吐字 " + fmtRate(t.avg_tokens_per_second) : "无速率样本"} />
          </div>
          <div className="note" title={u.since ? "数据自 " + u.since.replace("T", " ") : ""}>
            {u.buckets} 条事件 · {u.series.length} 个分桶
            {u.since ? " · 数据自 " + u.since.replace("T", " ").slice(0, 16) : ""}
          </div>
        </div>
      </Box>

      <Box title="用量时序" hint="蓝=prompt · 绿=completion；横轴为真实时间"
        extra={<span className="note">峰值 {u.series.length > 0 ? fmtTok(Math.max(...u.series.map((p) => p.total_tokens))) : "—"}</span>}>
        <div className="uschart-body">
          <UsageChart series={u.series} />
        </div>
      </Box>

      <Box title="用量明细" extra={<>
        <select className="select" style={{ width: 120 }} value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}>
          <option value="total">按合计 Token</option>
          <option value="requests">按请求数</option>
          <option value="errors">按失败数</option>
          <option value="latency">按延迟</option>
        </select>
      </>}>
        <div className="pad" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {dimTabs}
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr>
                <th className="mark" aria-hidden="true"></th>
                <th>{m.title}</th>
                {m.withRealm && <th>域</th>}
                <th className="num">请求</th><th className="num">失败</th>
                <th className="num">Prompt</th><th className="num">Completion</th><th className="num">合计</th>
                {m.withPerf && <><th className="num">均延迟</th><th className="num">均速率</th></>}
              </tr></thead>
              <tbody>
                {rows.length === 0 && <tr><td colSpan={m.span} className="dim" style={{ textAlign: "center", padding: 20 }}>暂无数据</td></tr>}
                {rows.map((x) => {
                  if (dim === "provider") {
                    const open = provOpen === x.key;
                    const subs = provSubs.get(x.key) ?? [];
                    return (
                      <React.Fragment key={x.key}>
                        <tr className={open ? "exp open" : "exp"} onClick={() => setProvOpen(open ? null : x.key)}>
                          <td className="mark" aria-hidden="true"><span className="expv">{open ? "▾" : "▸"}</span></td>
                          <td>{x.key}</td>
                          <td className="num">{fmtTok(x.agg.requests)}</td>
                          <td className="num">{x.agg.errors
                            ? <span style={{ color: "var(--warn)" }}>{fmtTok(x.agg.errors)}</span>
                            : "—"}</td>
                          <td className="num">{fmtTok(x.agg.prompt_tokens)}</td>
                          <td className="num">{fmtTok(x.agg.completion_tokens)}</td>
                          <td className="num">
                            {fmtTok(x.agg.total_tokens)}
                            <MixBar prompt={x.agg.prompt_tokens} completion={x.agg.completion_tokens} total={x.agg.total_tokens} />
                          </td>
                        </tr>
                        {open && subs.map((p) => (
                          <tr key={p.key} className="sub" style={{ ["--depth" as string]: 1 } as React.CSSProperties}>
                            <td className="mark" aria-hidden="true"></td>
                            <td className="mono">{"└ " + (p.extra || p.key)}</td>
                            <td className="num">{fmtTok(p.agg.requests)}</td>
                            <td className="num">{p.agg.errors
                              ? <span style={{ color: "var(--warn)" }}>{fmtTok(p.agg.errors)}</span>
                              : "—"}</td>
                            <td className="num">{fmtTok(p.agg.prompt_tokens)}</td>
                            <td className="num">{fmtTok(p.agg.completion_tokens)}</td>
                            <td className="num">
                              {fmtTok(p.agg.total_tokens)}
                              <MixBar prompt={p.agg.prompt_tokens} completion={p.agg.completion_tokens} total={p.agg.total_tokens} />
                            </td>
                          </tr>
                        ))}
                      </React.Fragment>
                    );
                  }
                  const name = dim === "account" ? String(x.key || "").slice(0, 8)
                    : dim === "realm" ? realmLabel(x.key) : x.key;
                  const sub = dim === "account" || dim === "key" ? (x.extra || "") : undefined;
                  return (
                    <DimRow key={x.key} name={name} sub={sub} a={x.agg}
                      realm={m.withRealm ? x.realm : undefined} withPerf={m.withPerf} />
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="note">
            {dim === "provider"
              ? rows.length + " 个供应商 · " + (u.by_provider_model ?? []).length + " 个模型 · 请求数含失败尝试"
              : rows.length + " 行 · 请求数含失败尝试"}
          </div>
        </div>
      </Box>

      <Box title="积分扣除" hint="仅统计与积分同时观测到的 Token">
        <div className="pad">
          <div className="kpi-grid">
            <Kpi value={fmtCredit(t.credits)} label="扣除积分" color="var(--accent)" sub="按上游 usage.credit 累计" />
            <Kpi value={fmtTok(t.credit_tokens)} label="匹配 Token" sub="与积分同时观测到的 Token" />
            <Kpi value={fmtCreditRatio(t.credits_per_1m_tokens, t.credit_samples, t.credit_tokens)}
              label="平均积分 / 1M Token" color="var(--ok)" sub="越低越划算" />
            <Kpi value={String(t.credit_samples)} label="有效积分样本" sub="缺字段的历史不参与折算" />
            <Kpi value={cacheRateText(t.cache_hit_tokens, t.cache_miss_tokens)} label="缓存命中率"
              color={cacheRateColor(t.cache_hit_tokens, t.cache_miss_tokens)}
              sub="上游前缀缓存命中 / (命中+未命中)" />
          </div>
          <div className="note">
            {(u.credit_by_account ?? []).length} 个账号 · {(u.credit_by_model ?? []).length} 个模型倍率分组 · {(u.credit_by_key ?? []).length} 个 KEY
          </div>
        </div>
      </Box>

      <Box title="积分扣除明细" extra={
        <div className="ustabs">
          <button className={creditDim === "account" ? "on" : ""} onClick={() => setCreditDim("account")}>
            按账号<span className="cnt">{(u.credit_by_account ?? []).length}</span>
          </button>
          <button className={creditDim === "model" ? "on" : ""} onClick={() => setCreditDim("model")}>
            按模型<span className="cnt">{(u.credit_by_model ?? []).length}</span>
          </button>
          <button className={creditDim === "key" ? "on" : ""} onClick={() => setCreditDim("key")}>
            按KEY<span className="cnt">{(u.credit_by_key ?? []).length}</span>
          </button>
        </div>
      }>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr>
              <th className="mark" aria-hidden="true"></th>
              <th>{creditDim === "model" ? "模型" : creditDim === "key" ? "Key" : "账号"}</th>
              {creditDim === "model" && <th>积分倍率</th>}
              <th className="num">请求</th><th className="num">扣除积分</th>
              <th className="num">有效样本 Token</th><th className="num">积分 / 1M Token</th>
              <th className="num">缓存命中率</th>
            </tr></thead>
            <tbody>
              {(creditDim === "model" ? (u.credit_by_model ?? [])
                : creditDim === "key" ? (u.credit_by_key ?? [])
                : (u.credit_by_account ?? [])).map((row) => (
                <tr key={row.key + "|" + (row.rate ?? "")}>
                  <td className="mark" aria-hidden="true"></td>
                  {creditDim === "account"
                    ? <td>
                        {row.nickname || String(row.key || "").slice(0, 8) || "—"}
                        <div className="note">{(row.realm || "cn") + " · " + String(row.key || "").slice(0, 8)}</div>
                      </td>
                    : <td className="mono">{row.key || "—"}</td>}
                  {creditDim === "model" && <td>{fmtModelRate(row.rate)}</td>}
                  <td className="num">{fmtTok(row.requests)}</td>
                  <td className="num">{fmtCredit(row.credits)}</td>
                  <td className="num">{fmtTok(row.credit_tokens)}</td>
                  <td className="num">{fmtCreditRatio(row.credits_per_1m_tokens, row.credit_samples, row.credit_tokens)}</td>
                  <td className="num" title={"命中 " + fmtTok(row.cache_hit_tokens) + " / 未命中 " + fmtTok(row.cache_miss_tokens) + " tok"}>
                    <span style={{ color: cacheRateColor(row.cache_hit_tokens, row.cache_miss_tokens) }}>
                      {cacheRateText(row.cache_hit_tokens, row.cache_miss_tokens)}
                    </span>
                  </td>
                </tr>
              ))}
              {((creditDim === "model" ? u.credit_by_model
                : creditDim === "key" ? u.credit_by_key
                : u.credit_by_account) ?? []).length === 0 &&
                <tr><td colSpan={creditDim === "model" ? 8 : 7} className="dim" style={{ textAlign: "center", padding: 20 }}>
                  暂无积分扣除记录；升级前仅含 Token 的历史不会伪造积分。
                </td></tr>}
            </tbody>
          </table>
        </div>
      </Box>

    </>
  );
}
