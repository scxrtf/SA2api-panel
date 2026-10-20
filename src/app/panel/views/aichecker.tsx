"use client";
// 模型指纹鉴别视图（hlwy-ai-checker 算法原生集成版）：
// 让模型反复输出 1-355 随机数，统计 355 桶分布与众数，与官方基准做
// 余弦×e^(-JS) + 众数各半的综合匹配度比对（算法在 src/lib/aichecker.ts，
// 判据与上游 v2.6.1 一致：≥96 一致 / ≥92 少许降智 / 横向高 0.5pt 判替换）。
// 支持三种通道：池模型（cn:/global:）、供应商模型（供应商名:）、自定义外站。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { req } from "../lib";
import { Box, type Flash } from "../components/ui";

interface ModelRow { id: string; name?: string; provider?: boolean }
interface BaselineItem {
  id: string; file: string;
  source?: "official" | "custom";
  label?: string; model?: string; createdAt?: string;
}
interface MatchRow { id: string; name: string; claimed: boolean; score: number }
interface CheckResult {
  model: string; baseline: string;
  baseline_name: string; baseline_distribution: number[];
  verdict: { text: string; level: "good" | "warn" | "bad"; replaced: boolean };
  score: number;
  similarity: { cosineSimilarity: number; jsDivergence: number; modeScore: number; overallScore: number };
  stats: { mean: number; median: number; stdDev: number; min: number; max: number; unique: number; mode: number; modeCount: number };
  distribution: number[];
  samples: number; requested: number; failed: number; errors: string[];
  matches: MatchRow[];
}

type Source = "pool" | "provider" | "custom";

const VERDICT_CLS = { good: "ok", warn: "warn", bad: "err" } as const;
const CHART_LEFT = 46;
const CHART_RIGHT = 12;

export function AiCheckerView({ flash }: { flash: Flash }) {
  const [models, setModels] = useState<ModelRow[]>([]);
  const [baselines, setBaselines] = useState<BaselineItem[]>([]);
  const [src, setSrc] = useState<Source>("pool");
  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseline, setBaseline] = useState("");
  const [iterations, setIterations] = useState(100);
  const [concurrency, setConcurrency] = useState(5);
  const [antiTarget, setAntiTarget] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [checkID, setCheckID] = useState<string | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [hoverBin, setHoverBin] = useState<number | null>(null);
  const [baselineBusy, setBaselineBusy] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveLabel, setSaveLabel] = useState("");
  const importRef = useRef<HTMLInputElement>(null);
  const distRef = useRef<HTMLCanvasElement>(null);

  // loadBaselines 拉取「官方快照 + 自建」合并列表，尽量保留当前选中项。
  const loadBaselines = useCallback(async (keep?: string): Promise<BaselineItem[]> => {
    const r = await req<{ models: BaselineItem[] }>("aichecker/baselines");
    const list = r.models ?? [];
    setBaselines(list);
    if (list.length) {
      setBaseline((cur) => {
        if (keep && list.some((b) => b.id === keep)) return keep;
        if (cur && list.some((b) => b.id === cur)) return cur;
        return (list.find((b) => b.id === "gpt-6-astra") ?? list[0]).id;
      });
    }
    return list;
  }, []);

  // 模型目录 + 基准列表。
  useEffect(() => {
    req<{ models: ModelRow[] }>("models")
      .then((r) => setModels(r.models ?? []))
      .catch((e) => {
        setModels([]);
        flash("err", "加载模型目录失败：" + (e instanceof Error ? e.message : String(e)));
      });
    // loadBaselines 内部在 await 之后 setState；规则误判为同步 setState，这里显式豁免。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadBaselines().catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const poolModels = useMemo(() => models.filter((m) => !m.provider), [models]);
  const providerModels = useMemo(() => models.filter((m) => m.provider), [models]);
  const currentList = useMemo(
    () => (src === "pool" ? poolModels : src === "provider" ? providerModels : []),
    [src, poolModels, providerModels],
  );

  // 按模型名自动匹配同名官方基准：如 cn:deepseek-v4.1-flash → deepseek-v4.1-flash。
  // 切换待测模型时同步基准，避免默认基准与待测模型不匹配导致误判。
  const chooseModel = useCallback((v: string) => {
    setModel(v);
    const bid = pickBaselineForModel(v, baselines);
    if (bid) setBaseline(bid);
  }, [baselines]);

  const chooseCustomModel = useCallback((v: string) => {
    setCustomModel(v);
    const bid = pickBaselineForModel(v, baselines);
    if (bid) setBaseline(bid);
  }, [baselines]);

  const switchSrc = useCallback((next: Source) => {
    setSrc(next);
    if (next === "custom") return;
    const first = (next === "pool" ? poolModels : providerModels)[0]?.id;
    if (first) chooseModel(first);
  }, [poolModels, providerModels, chooseModel]);

  // 切通道/目录刷新后若当前选中项不在列表内，回退到首项（受控修正，不用 effect 设值）。
  const selectValue = src === "custom"
    ? customModel
    : (currentList.some((m) => m.id === model) ? model : (currentList[0]?.id ?? ""));
  const selectedBaseline = useMemo(
    () => baselines.find((b) => b.id === baseline) ?? null,
    [baselines, baseline],
  );
  const officialCount = useMemo(() => baselines.filter((b) => b.source !== "custom").length, [baselines]);
  const customCount = baselines.length - officialCount;

  const start = useCallback(async () => {
    const m = (src === "custom" ? customModel : selectValue).trim();
    if (!m) { flash("err", "请选择或填写待测模型"); return; }
    if (!baseline) { flash("err", "请选择比对基准"); return; }
    if (src === "custom" && (!baseUrl.trim() || !apiKey.trim())) {
      flash("err", "自定义通道需填写 Base URL 与 API Key"); return;
    }
    setRunning(true); setResult(null); setErrorsOpen(false); setElapsed(0); setHoverBin(null);
    setSaveOpen(false);
    const id = crypto.randomUUID();
    setCheckID(id);
    try {
      const r = await req<{ check_id: string; result: CheckResult }>("aichecker/check", {
        method: "POST",
        body: {
          model: m, baseline, iterations, concurrency,
          anti_target: antiTarget, check_id: id,
          ...(src === "custom" ? { base_url: baseUrl.trim(), api_key: apiKey.trim() } : {}),
        },
      });
      setResult(r.result);
      flash("ok", `鉴别完成：${r.result.samples} 个有效样本`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false); setCheckID(null);
    }
  }, [customModel, selectValue, baseline, iterations, concurrency, antiTarget, src, baseUrl, apiKey, flash]);

  const stop = useCallback(() => {
    if (!checkID) return;
    req(`aichecker/check?id=${encodeURIComponent(checkID)}`, { method: "DELETE" }).catch(() => undefined);
  }, [checkID]);

  // 把本次鉴别的 355 桶分布存为自建基准，后续可直接横向比对。
  const openSave = useCallback(() => {
    if (!result) return;
    setSaveLabel(defaultBaselineLabel(result.model));
    setSaveOpen(true);
  }, [result]);

  const saveBaseline = useCallback(async () => {
    if (!result) return;
    const label = saveLabel.trim();
    if (!label) { flash("err", "请填写基准名称"); return; }
    setBaselineBusy(true);
    try {
      const r = await req<{ baseline: { id: string; label: string } }>("aichecker/baselines", {
        method: "POST",
        body: {
          label, model: result.model,
          distribution: result.distribution,
          samples: result.samples,
        },
      });
      await loadBaselines(r.baseline.id);
      setBaseline(r.baseline.id);
      setSaveOpen(false);
      flash("ok", `已保存自建基准「${r.baseline.label}」`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBaselineBusy(false);
    }
  }, [result, saveLabel, loadBaselines, flash]);

  const importBaseline = useCallback(async (file: File) => {
    setBaselineBusy(true);
    try {
      let raw: unknown;
      try { raw = JSON.parse(await file.text()) as unknown; }
      catch { throw new Error("JSON 解析失败：" + file.name); }
      const r = await req<{ baseline: { id: string; label: string } }>("aichecker/baselines", {
        method: "POST", body: { import: raw },
      });
      await loadBaselines(r.baseline.id);
      setBaseline(r.baseline.id);
      flash("ok", `已导入基准「${r.baseline.label}」`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBaselineBusy(false);
    }
  }, [loadBaselines, flash]);

  const removeBaseline = useCallback(async () => {
    if (!selectedBaseline || selectedBaseline.source !== "custom") return;
    if (!confirm(`删除自建基准「${selectedBaseline.label ?? selectedBaseline.id}」？此操作不可撤销。`)) return;
    setBaselineBusy(true);
    try {
      await req("aichecker/baselines?name=" + encodeURIComponent(selectedBaseline.id), { method: "DELETE" });
      await loadBaselines();
      flash("ok", `已删除自建基准「${selectedBaseline.label ?? selectedBaseline.id}」`);
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setBaselineBusy(false);
    }
  }, [selectedBaseline, loadBaselines, flash]);

  // 从上游 hlwy-ai-checker 仓库拉取最新官方基准快照，覆盖 public/ 内置副本。
  const [syncBusy, setSyncBusy] = useState(false);
  const syncBaselines = useCallback(async () => {
    setSyncBusy(true);
    try {
      const r = await req<{
        total: number; added: string[]; updated: string[];
        unchanged: number; skipped: { id: string; reason: string }[];
      }>("aichecker/baselines/sync", { method: "POST" });
      await loadBaselines();
      const parts = [
        r.added.length ? `新增 ${r.added.length}` : "",
        r.updated.length ? `更新 ${r.updated.length}` : "",
        `未变 ${r.unchanged}`,
      ].filter(Boolean);
      if (r.skipped.length) parts.push(`跳过 ${r.skipped.length}`);
      flash("ok", `基准已同步：${parts.join(" · ")}（共 ${r.total} 个）`);
      if (r.skipped.length) {
        flash("err", "跳过：" + r.skipped.map((s) => `${s.id}（${s.reason}）`).join("；"));
      }
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally {
      setSyncBusy(false);
    }
  }, [loadBaselines, flash]);

  // 采样期间显示已耗时：默认 100 次 × 并发 5 通常需要数十秒到数分钟。
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [running]);

  // 分布直方图（原生 canvas，保持面板轻量图表风格）。
  useEffect(() => {
    const cv = distRef.current;
    if (!cv || !result) return;
    const paint = () => drawDist(cv, result.distribution, result.baseline_distribution, hoverBin);
    paint();
    // 隐藏 tab 时宽度为 0；切回来时 ResizeObserver 会补画，避免空白图。
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(paint);
    if (ro) {
      ro.observe(cv);
      if (cv.parentElement) ro.observe(cv.parentElement);
    }
    window.addEventListener("resize", paint);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", paint);
    };
  }, [result, hoverBin]);

  const onChartMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const plotW = rect.width - CHART_LEFT - CHART_RIGHT;
    if (plotW <= 0) return;
    const x = e.clientX - rect.left - CHART_LEFT;
    if (x < 0 || x > plotW) { setHoverBin(null); return; }
    const idx = Math.max(0, Math.min(354, Math.floor((x / plotW) * 355)));
    setHoverBin((cur) => (cur === idx ? cur : idx));
  }, []);

  const peak = result ? peakOf(result.distribution) : null;

  return (
    <>
      <Box title="指纹采样" hint="反复请求模型输出 1-355 随机数，形成统计指纹（鉴别期间会持续消耗该模型额度）">
        <div className="pad">
          <div className="form-grid">
            <div className="form-row">
              <div className="form-label">通道</div>
              <div className="ustabs">
                <button className={src === "pool" ? "on" : ""} onClick={() => switchSrc("pool")}>池模型</button>
                <button className={src === "provider" ? "on" : ""} onClick={() => switchSrc("provider")}>供应商</button>
                <button className={src === "custom" ? "on" : ""} onClick={() => switchSrc("custom")}>自定义外站</button>
              </div>
            </div>
            {src !== "custom" ? (
              <div className="form-row">
                <div className="form-label">待测模型 <span className="dim">· {currentList.length} 个可选</span></div>
                <ModelPicker models={currentList} value={selectValue} onChange={chooseModel} />
              </div>
            ) : (
              <>
                <div className="form-row">
                  <div className="form-label">模型名</div>
                  <input className="input" value={customModel} onChange={(e) => chooseCustomModel(e.target.value)}
                    placeholder="gpt-5.6-sol" />
                </div>
                <div className="form-row">
                  <div className="form-label">Base URL</div>
                  <input className="input" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.example.com（自动补 /v1）" style={{ width: 280 }} />
                </div>
                <div className="form-row">
                  <div className="form-label">API Key</div>
                  <input className="input" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="仅本次请求使用，不落盘" style={{ width: 280 }} />
                </div>
              </>
            )}
            <div className="form-row">
              <div className="form-label">
                比对基准
                <span className="dim"> · 官方 {officialCount} / 自建 {customCount}</span>
              </div>
              <select className="select" style={{ width: "100%" }} value={baseline} onChange={(e) => setBaseline(e.target.value)}
                title="选择待测模型声称对应的模型；切换待测模型时若存在同名或同日快照基准会自动选中">
                {baselines.map((b) => <option key={b.id} value={b.id}>{baselineOptionLabel(b)}</option>)}
              </select>
              <div className="baseline-tools">
                <button className="btn small ghost" disabled={!result || running} onClick={openSave}
                  title={result ? "把本次鉴别的 355 桶分布存为自建基准" : "先完成一次鉴别才能保存基准"}>
                  存为基准
                </button>
                <button className="btn small ghost" disabled={baselineBusy} onClick={() => importRef.current?.click()}
                  title="导入上游 hlwy-ai-checker 导出的基准 JSON">
                  {baselineBusy ? "处理中…" : "导入 JSON"}
                </button>
                <input ref={importRef} type="file" accept=".json,application/json" hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void importBaseline(f);
                  }} />
                <button className="btn small ghost" disabled={syncBusy || running} onClick={syncBaselines}
                  title="从上游 hlwy-ai-checker 仓库拉取最新官方基准，覆盖内置快照">
                  {syncBusy && <span className="spin" style={{ marginRight: 5 }} />}
                  {syncBusy ? "拉取中…" : "更新基准"}
                </button>
                {selectedBaseline?.source === "custom" && (
                  <button className="btn small danger" disabled={baselineBusy} onClick={removeBaseline}>
                    删除自建
                  </button>
                )}
              </div>
              <div className="form-hint">
                官方快照只覆盖 {officialCount} 个模型；测试其他模型后可点「存为基准」，
                下次会按同名 / 同日快照自动选中，并参与横向比对。
              </div>
            </div>
            {saveOpen && result && (
              <div className="form-row baseline-save">
                <div className="form-label">保存为自建基准</div>
                <div className="baseline-save-line">
                  <input className="input" value={saveLabel} maxLength={60}
                    onChange={(e) => setSaveLabel(e.target.value)}
                    placeholder="基准名称（如 glm-5.2-1020）" />
                  <button className="btn primary small" disabled={baselineBusy} onClick={saveBaseline}>
                    {baselineBusy ? "保存中…" : "保存"}
                  </button>
                  <button className="btn ghost small" onClick={() => setSaveOpen(false)}>取消</button>
                </div>
                <div className="form-hint">
                  使用本次 {result.samples} 个有效样本的 355 桶分布；保存后会与官方基准一起参与横向比对。
                </div>
              </div>
            )}
            <div className="form-row">
              <div className="form-label">采样次数</div>
              <input className="input" type="number" min={40} max={500} value={iterations}
                onChange={(e) => setIterations(Math.max(40, Math.min(500, +e.target.value || 100)))} style={{ width: 90 }} />
            </div>
            <div className="form-row">
              <div className="form-label">并发</div>
              <input className="input" type="number" min={1} max={10} value={concurrency}
                onChange={(e) => setConcurrency(Math.max(1, Math.min(10, +e.target.value || 5)))} style={{ width: 70 }} />
            </div>
            <div className="form-row">
              <div className="form-label">反针对模式</div>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                <input type="checkbox" checked={antiTarget} onChange={(e) => setAntiTarget(e.target.checked)} />
                <span className="dim">提示词随机插入空格，防中转站按固定提示词识别</span>
              </label>
            </div>
          </div>
          <div className="btn-row" style={{ marginTop: 6 }}>
            {!running
              ? <button className="btn primary" onClick={start}>开始鉴别</button>
                : <>
                  <button className="btn" disabled>鉴别中… 已用 {elapsed}s · 计划 {iterations} 次采样</button>
                  <button className="btn danger" onClick={stop}>中止</button>
                </>}
          </div>
        </div>
      </Box>

      {result && (
        <>
          <Box title="鉴别结论" hint={`${result.model} · 基准 ${result.baseline} · ${result.samples} 有效样本 / ${result.failed} 失败`}>
            <div className="pad">
              <div className="kpi-grid">
                <div className="kpi">
                  <div className="k">综合匹配度</div>
                  <div className="v" style={{ color: `var(--${VERDICT_CLS[result.verdict.level]})` }}>{result.score}%</div>
                  <div className="s"><span className={`tag ${VERDICT_CLS[result.verdict.level]}`}>{result.verdict.text}</span></div>
                </div>
                <div className="kpi"><div className="k">余弦相似度</div><div className="v">{(result.similarity.cosineSimilarity * 100).toFixed(2)}%</div></div>
                <div className="kpi"><div className="k">JS 散度</div><div className="v">{result.similarity.jsDivergence.toFixed(4)}</div></div>
                <div className="kpi">
                  <div className="k">众数</div>
                  <div className="v">{result.stats.mode}<span className="stat-unit">×{result.stats.modeCount}</span></div>
                </div>
                <div className="kpi">
                  <div className="k">均值 ± 标准差</div>
                  <div className="v" style={{ fontSize: 16 }}>{result.stats.mean.toFixed(1)} ± {result.stats.stdDev.toFixed(1)}</div>
                  <div className="s">中位 {result.stats.median} · 唯一值 {result.stats.unique}</div>
                </div>
              </div>
              {result.errors.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <button className="btn ghost small" onClick={() => setErrorsOpen(!errorsOpen)}>
                    {errorsOpen ? "收起" : "展开"}错误明细（{result.failed}）
                  </button>
                  {errorsOpen && (
                    <div className="msg err" style={{ marginTop: 8 }}>
                      {result.errors.map((e, i) => <div key={i}>{e}</div>)}
                      {result.failed > result.errors.length && <div className="dim">… 其余省略</div>}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Box>

          <Box title="横向比对" hint="同一指纹与全部基准（官方 + 自建）的匹配度，其他基准高出 0.5 个百分点即判可能被替换">
            <div className="tbl-wrap">
              <table className="tbl tbl-match">
                <thead><tr><th>基准</th><th>匹配度</th><th style={{ width: "42%" }}>占比</th></tr></thead>
                <tbody>
                  {result.matches.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.id}
                        {m.name && m.name !== m.id && <span className="dim"> · {m.name}</span>}
                        {m.claimed && <span className="tag info" style={{ marginLeft: 6 }}>所选</span>}
                      </td>
                      <td style={{ fontFamily: "var(--mono)" }}>{m.score.toFixed(2)}%</td>
                      <td>
                        <div style={{ background: "var(--bg-soft)", borderRadius: 3, height: 8 }}>
                          <div style={{
                            width: Math.min(100, m.score) + "%", height: "100%", borderRadius: 3,
                            background: m.claimed ? "var(--accent)" : "var(--border-strong)",
                          }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Box>

          <Box title="输出分布" hint="355 桶采样分布直方图（柱高 = 该数字出现频率）">
            <div className="pad">
              <div className="dist-chart-head">
                <span className="dist-key"><i className="mine" />本渠道</span>
                <span className="dist-key"><i className="base" />基准 {result.baseline_name || result.baseline}</span>
                <span className="grow" />
                <span className="dim">
                  {result.samples} 个有效样本 · 悬停/触摸查看单桶
                </span>
              </div>
              <div className="dist-chart">
                <canvas
                  ref={distRef}
                  role="img"
                  aria-label={`${result.model} 与 ${result.baseline} 的 355 桶输出频率分布对比`}
                  onPointerMove={onChartMove}
                  onPointerLeave={() => setHoverBin(null)}
                  onPointerCancel={() => setHoverBin(null)}
                />
                {hoverBin !== null && (
                  <div
                    className="dist-tip"
                    style={{
                      left: `clamp(78px, calc(${CHART_LEFT}px + (100% - ${CHART_LEFT + CHART_RIGHT}px) * ${(hoverBin + 0.5) / 355}), calc(100% - 78px))`,
                    }}
                  >
                    <div className="t">数字 {hoverBin + 1}</div>
                    <div className="row">
                      <i className="mine" /><span>本渠道</span>
                      <b>{freqPct(result.distribution[hoverBin])}</b>
                    </div>
                    <div className="row">
                      <i className="base" /><span>基准</span>
                      <b>{freqPct(result.baseline_distribution[hoverBin])}</b>
                    </div>
                  </div>
                )}
              </div>
              <div className="dist-chart-foot">
                <span>横轴 <b className="mono">1–355</b></span>
                <span>纵轴 <b>出现频率</b></span>
                {peak && (
                  <span>本渠道峰值 <b className="mono">{peak.index + 1}</b> · {freqPct(peak.value)}</span>
                )}
                <span className="grow" />
                <span>灰线及浅灰区域为所选基准</span>
              </div>
            </div>
          </Box>
        </>
      )}
    </>
  );
}

// ModelPicker：可搜索的紧凑模型选择器。原生 select 会把「供应商 · 名称 · ID」
// 全塞进一行，长模型名会撑破表单；这里触发器只显示截断后的 ID，浮层里再展示名称。
function ModelPicker({ models, value, onChange }: {
  models: ModelRow[]; value: string; onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [rect, setRect] = useState<{ top: number; bottom: number; left: number; width: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect((prev) => prev && prev.top === r.top && prev.bottom === r.bottom
      && prev.left === r.left && prev.width === r.width
      ? prev
      : { top: r.top, bottom: r.bottom, left: r.left, width: r.width });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (rootRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open, measure]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return models;
    return models.filter((m) =>
      m.id.toLowerCase().includes(s) || (m.name ?? "").toLowerCase().includes(s));
  }, [models, q]);

  const toggle = () => {
    if (models.length === 0) return;
    if (open) { setOpen(false); return; }
    setQ("");
    measure();
    setOpen(true);
    requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(".model-picker-item.on")
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  // 浮层挂在 body 上，避开 .box 的 overflow: hidden 裁剪；位置跟随触发器。
  let pop: React.ReactNode = null;
  if (open && rect && typeof document !== "undefined") {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(Math.max(rect.width, 270), vw - 16);
    const left = Math.max(8, Math.min(rect.left, vw - width - 8));
    const below = vh - rect.bottom;
    const dropUp = below < 320 && rect.top > below;
    const listMax = dropUp
      ? Math.max(120, Math.min(260, rect.top - 110))
      : Math.max(120, Math.min(260, below - 100));
    const style: React.CSSProperties = dropUp
      ? { bottom: vh - rect.top + 5, left, width }
      : { top: rect.bottom + 5, left, width };
    pop = createPortal(
      <div className="model-picker-pop" ref={popRef} style={style}>
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="搜索模型 ID 或名称…" aria-label="搜索模型" />
        <div className="model-picker-list" role="listbox" ref={listRef} style={{ maxHeight: listMax }}>
          {filtered.length === 0 && <div className="model-picker-empty">无匹配模型</div>}
          {filtered.map((m) => (
            <button key={m.id} type="button" role="option" aria-selected={m.id === value}
              className={"model-picker-item" + (m.id === value ? " on" : "")}
              onClick={() => { onChange(m.id); setOpen(false); }}
              title={m.name && m.name !== m.id ? `${m.id} · ${m.name}` : m.id}>
              <span className="mp-id">{m.id}</span>
              {m.name && m.name !== m.id && <span className="mp-name">{m.name}</span>}
            </button>
          ))}
        </div>
        <div className="model-picker-foot">{filtered.length} / {models.length}</div>
      </div>,
      document.body,
    );
  }

  return (
    <div className="model-picker" ref={rootRef}>
      <button type="button" className="model-picker-trigger" ref={triggerRef} disabled={models.length === 0}
        aria-haspopup="listbox" aria-expanded={open} onClick={toggle}
        title={value || "无可用模型"}>
        <span className="mp-id">{value || "（无可用模型）"}</span>
        <span className="mp-count">{models.length}</span>
        <span className="mp-caret">▾</span>
      </button>
      {pop}
    </div>
  );
}

function baselineOptionLabel(b: BaselineItem): string {
  const label = b.label ?? b.id;
  const head = b.source === "custom" ? "〔自建〕" : "";
  return label !== b.id ? `${head}${label} · ${b.id}` : `${head}${b.id}`;
}

function defaultBaselineLabel(model: string): string {
  const bare = (model.includes(":") ? model.slice(model.indexOf(":") + 1) : model).trim();
  const p = (n: number) => String(n).padStart(2, "0");
  const d = new Date();
  return `${bare || "custom"}-${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

// pickBaselineForModel 按模型名匹配基准：
//   1. 优先同日快照（bare-1017 / bare-20261017 这类 4-8 位数字后缀，取最大者）；
//   2. 否则精确同名（claude-opus-5 不会被误配到 claude-opus-5-5）。
function pickBaselineForModel(model: string, list: BaselineItem[]): string | null {
  const bare = (model.includes(":") ? model.slice(model.indexOf(":") + 1) : model).trim().toLowerCase();
  if (!bare) return null;
  let exact = "";
  let snapshot = "";
  const prefix = bare + "-";
  for (const b of list) {
    const id = b.id.toLowerCase();
    if (id === bare) {
      exact = b.id;
    } else if (id.startsWith(prefix) && /^\d{4,8}$/.test(id.slice(prefix.length))) {
      // 数字后缀视为快照日期；同长度取字典序更大者（1018 > 1017）。
      if (id.length > snapshot.length || (id.length === snapshot.length && id > snapshot)) snapshot = b.id;
    }
  }
  return snapshot || exact || null;
}

// drawDist 响应式 355 桶直方图：按容器实际宽度和 DPR 绘制，带坐标轴、网格、
// 基准面积/折线与悬停高亮。分布值已经是频率（0-1），纵轴按百分比标尺。
function drawDist(cv: HTMLCanvasElement, dist: number[], base: number[] | undefined, hover: number | null) {
  const rect = cv.getBoundingClientRect();
  const W = Math.round(rect.width);
  const H = Math.round(rect.height);
  if (W < 80 || H < 80 || dist.length === 0) return;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pw = Math.round(W * dpr);
  const ph = Math.round(H * dpr);
  if (cv.width !== pw || cv.height !== ph) {
    cv.width = pw;
    cv.height = ph;
  }
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const css = getComputedStyle(cv);
  const accent = css.getPropertyValue("--accent").trim() || "#e8741c";
  const accentBright = css.getPropertyValue("--accent-bright").trim() || "#f28a2e";
  const ink = css.getPropertyValue("--ink").trim() || "#3a3a40";
  const dim = css.getPropertyValue("--fg-dim").trim() || "#81858c";
  const border = css.getPropertyValue("--border").trim() || "#e8e8e6";
  const mono = '11px "JetBrains Mono", "SF Mono", Consolas, monospace';

  const left = CHART_LEFT;
  const right = CHART_RIGHT;
  const top = 14;
  const bottom = 30;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  if (plotW <= 40 || plotH <= 20) return;

  const values = [...dist, ...(base && base.length === dist.length ? base : [])];
  const maxPct = Math.max(...values, 1e-9) * 100;
  const ticks = niceTicks(maxPct);
  const yMax = ticks[ticks.length - 1] || 1;
  const yOf = (v: number) => top + plotH - (v / yMax) * plotH;
  const bottomY = top + plotH;
  const bw = plotW / dist.length;

  // 横向网格与纵轴百分比刻度。
  ctx.font = mono;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.lineWidth = 1;
  ctx.strokeStyle = border;
  for (const t of ticks) {
    const y = Math.round(yOf(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(W - right, y);
    ctx.stroke();
    ctx.fillStyle = dim;
    ctx.fillText(formatPctTick(t, yMax), left - 7, y);
  }

  // 官方基准：浅灰面积 + 细折线。放在柱体下方，355 桶下仍能看清总体偏移。
  if (base && base.length === dist.length) {
    ctx.beginPath();
    ctx.moveTo(left, bottomY);
    for (let i = 0; i < base.length; i++) {
      const x = left + (i + 0.5) * bw;
      ctx.lineTo(x, yOf(base[i] * 100));
    }
    ctx.lineTo(W - right, bottomY);
    ctx.closePath();
    ctx.fillStyle = "rgba(129, 133, 140, .11)";
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i < base.length; i++) {
      const x = left + (i + 0.5) * bw;
      const y = yOf(base[i] * 100);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(58, 58, 64, .62)";
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }

  // 本渠道柱体：渐变橙色，单桶至少 1px，避免低频数字完全消失。
  const grad = ctx.createLinearGradient(0, top, 0, bottomY);
  grad.addColorStop(0, accentBright);
  grad.addColorStop(1, accent);
  ctx.fillStyle = grad;
  const gap = bw > 2 ? Math.min(1, bw * 0.2) : 0;
  for (let i = 0; i < dist.length; i++) {
    const h = dist[i] > 0 ? Math.max(1, (dist[i] * 100 / yMax) * plotH) : 0;
    if (h > 0) {
      ctx.fillRect(left + i * bw, bottomY - h, Math.max(1, bw - gap), h);
    }
  }

  // 悬停桶：橙色淡底 + 虚线定位，便于在 355 桶里精确读数。
  if (hover !== null && hover >= 0 && hover < dist.length) {
    const hx = left + hover * bw;
    ctx.fillStyle = "rgba(232, 116, 28, .10)";
    ctx.fillRect(hx, top, Math.max(1, bw), plotH);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = "rgba(232, 116, 28, .72)";
    ctx.beginPath();
    ctx.moveTo(hx + bw / 2, top);
    ctx.lineTo(hx + bw / 2, bottomY);
    ctx.stroke();
    ctx.restore();
    if (base && base.length === dist.length) {
      ctx.beginPath();
      ctx.arc(hx + bw / 2, yOf(base[hover] * 100), 2.4, 0, Math.PI * 2);
      ctx.fillStyle = ink;
      ctx.fill();
    }
  }

  // 坐标轴与横轴数字标签。
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left - 0.5, top);
  ctx.lineTo(left - 0.5, bottomY + 0.5);
  ctx.lineTo(W - right, bottomY + 0.5);
  ctx.stroke();

  ctx.font = mono;
  ctx.fillStyle = dim;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const labels = plotW >= 560 ? [1, 50, 100, 150, 200, 250, 300, 355] : [1, 100, 200, 300, 355];
  for (const n of labels) {
    const x = left + ((n - 0.5) / 355) * plotW;
    ctx.fillText(String(n), x, bottomY + 7);
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, bottomY);
    ctx.lineTo(Math.round(x) + 0.5, bottomY + 4);
    ctx.strokeStyle = border;
    ctx.stroke();
  }
}

function freqPct(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  const pct = v * 100;
  return (pct >= 10 ? pct.toFixed(1) : pct.toFixed(2)) + "%";
}

function peakOf(dist: number[]): { index: number; value: number } | null {
  if (dist.length === 0) return null;
  let index = 0;
  for (let i = 1; i < dist.length; i++) if (dist[i] > dist[index]) index = i;
  return { index, value: dist[index] };
}

// niceTicks 生成 4 段上下的百分比刻度，避免纵轴出现 0.37% 这类难读上限。
function niceTicks(maxPct: number): number[] {
  const target = Math.max(maxPct, 0.1);
  const rawStep = target / 4;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((n) => n * mag).find((n) => n >= rawStep) ?? 10 * mag;
  const top = Math.ceil(target / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step * 0.001; v += step) out.push(Number(v.toFixed(6)));
  return out;
}

function formatPctTick(v: number, max: number): string {
  const digits = max < 1 ? 2 : max < 10 ? 1 : 0;
  return v.toFixed(digits) + "%";
}
