"use client";
// 账号池视图（对齐 Go view-accounts）：统计条 + 批量操作 + 账号表 + 模型锁池。
import React, { useCallback, useEffect, useState } from "react";
import { req, fmtNum, fmtTime, fmtDur } from "../lib";
import { Box, type StatusRow, type Overview, type Flash } from "../components/ui";
import { CtrlMetric, CtrlAction, CtrlCard, CtrlHint } from "../components/ctrl";
import { AddAccountModal } from "../components/addAccount";
import { ModelScanPanel, useModelScan } from "../components/modelscan";

// fmtAgo 相对时间（Go app.js ago 同口径）：42s / 5m / 3h / 2d。
function fmtAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + "s 前";
  if (s < 3600) return Math.floor(s / 60) + "m 前";
  if (s < 86400) return Math.floor(s / 3600) + "h 前";
  return Math.floor(s / 86400) + "d 前";
}

// fmtMsShort 延迟缩写：999ms / 1.2s / 6s（对齐 Go formatLatency）。
function fmtMsShort(ms: number | null | undefined): string {
  const v = Number(ms ?? 0);
  if (!v || v <= 0) return "—";
  if (v < 1000) return Math.round(v) + "ms";
  if (v < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "s";
  return Math.round(v / 1000) + "s";
}

function acctTags(a: StatusRow) {
  const tags: { text: string; cls: string }[] = [];
  if (a.disabled) tags.push({ text: "禁用" + (a.disabled_reason ? ":" + a.disabled_reason : ""), cls: "err" });
  else if (a.paused) tags.push({ text: "暂停", cls: "warn" });
  else if (a.cooling) tags.push({ text: "冷却 " + fmtDur(a.cool_remaining_sec) + (a.cool_kind ? " " + a.cool_kind : ""), cls: "warn" });
  else tags.push({ text: "健康", cls: "ok" });
  if (a.checkin_done) tags.push({ text: "已签到", cls: "info" });
  if (a.in_flight > 0) tags.push({ text: "在途 " + a.in_flight, cls: "info" });
  if (a.rate_limited_models.length > 0) tags.push({ text: "限流模型 " + a.rate_limited_models.length, cls: "warn" });
  return tags;
}

// useNow 客户端时钟：挂载前为 0，挂载后每 15s 更新一次。
// 剩余时间必须在渲染期之外取时间（react-hooks/purity），同时保证首帧
// 服务端/客户端渲染一致。
function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// RateLimitRows 账号行内「哪些模型暂时不能用」（对齐 Go rateLimitRowsHtml）。
// rate_limited_models 只含未过期条目；kind=model_unavailable 为 11102 模型不可用，
// 其余为 6004 等上游限流。剩余时间由 useNow 定时刷新，不随 overview 轮询老化。
function RateLimitRows({ rows, now }: { rows: StatusRow["rate_limited_models"]; now: number }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div className="rate-limits">
      {rows.map((r) => {
        const remain = now > 0 ? Math.max(0, Math.round((r.until - now) / 1000)) : null;
        const unavailable = r.kind === "model_unavailable";
        const detail = unavailable
          ? (remain === null ? "模型不可用" : remain > 0 ? "不可用 · " + fmtDur(remain) + " 后重试" : "不可用 · 等待重新探测")
          : (remain === null ? "限流中" : remain > 0 ? "限流 · " + fmtDur(remain) + " 后可重试" : "限流 · 即将恢复");
        const title = [
          r.model,
          unavailable ? "模型当前不可用" : "上游限流",
          "最早重试：" + fmtTime(r.until),
          r.reason ? "原因：" + r.reason : "",
        ].filter(Boolean).join("\n");
        return (
          <div key={r.model + "@" + r.until}
            className={"rate-limit" + (unavailable ? " model-unavailable" : "")} title={title}>
            <b>{r.model}</b><span>{detail}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AccountsView({ ov, flash, onRefresh }: {
  ov: Overview; flash: Flash; onRefresh: () => Promise<void>;
}) {
  const now = useNow();
  const scan = useModelScan(flash, onRefresh);
  const [addOpen, setAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | "healthy" | "cooling" | "paused" | "disabled">("");
  const [realm, setRealm] = useState("");

  const op = useCallback(async (uid: string, action: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await req("accounts/" + encodeURIComponent(uid) + "/" + action, { method: "POST" });
      flash("ok", "操作完成：" + action);
      await onRefresh();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }, [flash, onRefresh]);

  // batch 返回 Promise 供 CtrlAction 进入「发起中…」加载态，空窗期按钮即反馈。
  const batch = useCallback(async (path: string, label: string): Promise<void> => {
    try { await req(path, { method: "POST" }); flash("ok", label + " 已开始，结果见运行日志"); }
    catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  }, [flash]);



  const realms = React.useMemo(() => [...new Set(ov.accounts.map((a) => a.realm))], [ov.accounts]);

  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ov.accounts.filter((a) => {
      if (status === "healthy" && (a.disabled || a.paused || a.cooling)) return false;
      if (status === "cooling" && !a.cooling) return false;
      if (status === "paused" && !a.paused) return false;
      if (status === "disabled" && !a.disabled) return false;
      if (realm && a.realm !== realm) return false;
      if (needle && !(a.uid.toLowerCase().includes(needle) || (a.nickname ?? "").toLowerCase().includes(needle))) return false;
      return true;
    });
  }, [ov.accounts, q, status, realm]);

  return (
    <>
      {/* CloseRouter ControlMetric 栅格：等宽大数字 + 小标签 */}
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <CtrlMetric label="账号总数" value={ov.total} unit="ACC" />
        <CtrlMetric label="可用" value={ov.healthy} unit="OK" color="var(--ok)" />
        <CtrlMetric label="冷却中" value={ov.cooling} unit="COOL" color="var(--warn)" />
        <CtrlMetric label="已禁用" value={ov.disabled} unit="OFF" color="var(--err)" />
        <CtrlMetric label="已暂停选号" value={ov.paused} unit="HOLD" color="var(--warn)" />
        <CtrlMetric
          label="积分剩余 / 总额"
          value={(() => {
            const rem = ov.accounts.reduce((n, a) => n + (a.credits || 0), 0);
            const tot = ov.accounts.reduce((n, a) => n + (a.credits_total || 0), 0);
            return tot > 0 ? fmtNum(rem) + " / " + fmtNum(tot) : fmtNum(rem);
          })()}
          unit="PTS"
          // 千分位长值（如 1,234,567 / 8,901,234）会被 .stat-num 的 nowrap+ellipsis
          // 截断——这张卡单独缩小字号并允许换行，保证“剩余 / 总额”完整可见。
          numStyle={{ fontSize: 15, whiteSpace: "normal", overflow: "visible", textOverflow: "clip" }}
        />        <CtrlMetric label="粘性会话" value={ov.sticky_sessions} unit="SESS" />
      </div>

      {/* CloseRouter ControlAction 批量操作区：CODE 徽章 + → */}
      <CtrlCard style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
          <CtrlAction code="ADD" text="添加账号" onClick={() => setAddOpen(true)} />
          <CtrlAction code="CHK" text="全部签到" pendingText="发起签到中…" secondary onClick={() => batch("checkin_all", "全部签到")} />
          <CtrlAction code="TRV" text="旅行巡检" pendingText="发起巡检中…" secondary onClick={() => batch("travel_all", "旅行巡检")} />
          <CtrlAction code="ACT" text="活跃上报" pendingText="发起上报中…" secondary onClick={() => batch("activity_all", "活跃上报")} />
          <CtrlAction code="KEEP" text="全部保活" pendingText="发起保活中…" secondary onClick={() => batch("keepalive_all", "全部保活")} />
          <CtrlAction code="BAL" text="刷新余额" pendingText="刷新中…" secondary onClick={() => batch("balance_all", "刷新余额")} />
          <CtrlAction code="SCAN" text="扫描模型限流" pendingText="启动中…" secondary
            disabled={scan.scan?.running} onClick={async () => {
              if (!window.confirm("扫描会向每个未禁用账号的每个模型发送一次最小请求，可能消耗少量积分并触发上游限流。确认开始？")) return;
              await scan.start();
            }} />
        </div>
        <CtrlHint>
          批量操作异步执行，结果见「运行日志」页；添加账号支持浏览器授权与 JSON 导入两种方式。
          「扫描模型限流」会真实探测每个模型的 429 / 6004 / 11102 状态，已锁定的模型自动跳过。
        </CtrlHint>
      </CtrlCard>

      {scan.scan && (
        <div style={{ marginBottom: 16 }}>
          <ModelScanPanel scan={scan.scan} onCancel={scan.cancel} />
        </div>
      )}

      <Box title="账号池">
        <div className="pad" style={{ paddingBottom: 0, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input className="input" style={{ width: 220 }} placeholder="搜索 UID / 昵称"
            value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">全部状态</option>
            <option value="healthy">仅健康</option>
            <option value="cooling">冷却中</option>
            <option value="paused">已暂停</option>
            <option value="disabled">已禁用</option>
          </select>
          <select className="select" value={realm} onChange={(e) => setRealm(e.target.value)}>
            <option value="">全部域</option>
            {realms.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {(q || status || realm) && (
            <button className="btn ghost xs" onClick={() => { setQ(""); setStatus(""); setRealm(""); }}>清除筛选</button>
          )}
          <span className="dim" style={{ alignSelf: "center", fontSize: 12, marginLeft: "auto" }}>
            {filtered.length} / {ov.accounts.length} 个账号
          </span>
        </div>
        <div className="tbl-wrap">
          <table className="tbl tbl-accounts">
            <thead><tr>
              <th>账号</th><th>域</th><th>积分</th><th>状态</th>
              <th className="num">成功 / 失败</th><th className="num">在途</th>
              <th className="num">用量</th><th className="num">最近成功</th>
              <th style={{ width: 1 }}></th>
            </tr></thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={9} className="dim" style={{ textAlign: "center", padding: 30 }}>
                  {ov.accounts.length === 0 ? "暂无账号，点「添加账号」开始设备授权登录。" : "无匹配账号，调整筛选条件。"}
                </td></tr>
              )}
              {filtered.map((a) => (
                <tr key={a.uid}>
                  <td>
                    <div>{a.nickname || a.uid}</div>
                    <div className="dim mono">{a.uid}</div>
                  </td>
                  <td>{a.realm}{a.enterprise ? "（企）" : ""}</td>
                  <td>
                    {fmtNum(a.credits)} / {fmtNum(a.credits_total)}
                    {a.credits_expiring > 0 && (
                      <div className="dim" style={{ fontSize: 12 }}>
                        将过期 {fmtNum(a.credits_expiring)}
                        {a.credits_earliest_expiry > 0 && " · 最早 " + fmtTime(a.credits_earliest_expiry)}
                      </div>
                    )}
                  </td>
                  <td>
                    {acctTags(a).map((t) => <span key={t.text} className={"tag " + t.cls}>{t.text}</span>)}
                    {a.reason && (
                      <div className="dim" style={{ fontSize: 11.5, marginTop: 3 }} title={a.reason}>{a.reason}</div>
                    )}
                    <RateLimitRows rows={a.rate_limited_models} now={now} />
                  </td>
                  <td className="mono">
                    {fmtNum(a.success_count ?? 0)} <span className="dim">/</span>{" "}
                    <span style={{ color: (a.err_total ?? 0) > 0 ? "var(--err)" : undefined }}>{fmtNum(a.err_total ?? 0)}</span>
                  </td>
                  <td className="mono">{a.in_flight > 0 ? a.in_flight : <span className="dim">0</span>}</td>
                  {/* 用量四段（Go app.js:430 usage-line 同口径）：次数 · 总 token · 均延迟 · 均速率 */}
                  <td className="mono" title={`累计 ${a.token_usage?.request_count ?? 0} 次 / ${fmtNum(a.token_usage?.total_tokens ?? 0)} tok · 均延迟 ${a.token_usage?.last_latency_ms ? a.token_usage.last_latency_ms + "ms" : "—"} · 均速率 ${a.token_usage?.last_tokens_per_second ? a.token_usage.last_tokens_per_second.toFixed(1) + " tok/s" : "—"}`}>
                    {(a.token_usage?.request_count ?? 0) > 0 ? (
                      <span style={{ display: "inline-flex", gap: 8, whiteSpace: "nowrap" }}>
                        <span><b>{fmtNum(a.token_usage!.request_count)}</b><span className="dim" style={{ fontSize: 10 }}>次</span></span>
                        <span><b>{fmtNum(a.token_usage!.total_tokens)}</b><span className="dim" style={{ fontSize: 10 }}>tok</span></span>
                        <span><b>{fmtMsShort(a.token_usage!.last_latency_ms)}</b></span>
                        <span><b>{a.token_usage!.last_tokens_per_second > 0 ? a.token_usage!.last_tokens_per_second.toFixed(1) : "—"}</b><span className="dim" style={{ fontSize: 10 }}>tok/s</span></span>
                      </span>
                    ) : <span className="dim">—</span>}
                  </td>
                  <td className="mono dim">{a.last_success ? fmtAgo(a.last_success) : "—"}</td>
                  <td>
                    <div className="btn-row" style={{ flexWrap: "nowrap" }}>
                      <button className="btn small" disabled={busy} onClick={() => op(a.uid, "checkin")}>签到</button>
                      <button className="btn small" disabled={busy} onClick={() => op(a.uid, "balance")}>余额</button>
                      {a.paused
                        ? <button className="btn small" disabled={busy} onClick={() => op(a.uid, "resume")}>恢复</button>
                        : <button className="btn small" disabled={busy} onClick={() => op(a.uid, "pause")}>暂停</button>}
                      {a.disabled
                        ? <button className="btn small" disabled={busy} onClick={() => op(a.uid, "revive")}>复活</button>
                        : <button className="btn small danger" disabled={busy} onClick={() => op(a.uid, "disable", "确认禁用 " + a.uid + "？")}>禁用</button>}
                      <button className="btn small danger" disabled={busy}
                        onClick={() => op(a.uid, "remove", "确认移除 " + a.uid + "？该操作不可撤销。")}>移除</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Box>

      {/* 模型锁池（Go renderModelLocks 同口径）：服务端 model_locks 已按
          整池不可用 → 没号可用 → 部分限流 排好序，这里只做展示。
          无锁时也保留区块并渲染空态，避免「看不到锁池」被误读为功能缺失。 */}
      {(() => {
        const locks = ov.model_locks ?? [];
        const STATE: Record<string, [string, string]> = {
          locked: ["err", "整池不可用"],
          starved: ["warn", "没号可用"],
          partial: ["warn", "部分限流"],
        };
        const left = (iso: string) => {
          const ms = Date.parse(iso);
          if (!Number.isFinite(ms)) return "—";
          if (now <= 0) return fmtTime(ms);
          return fmtDur(Math.max(0, Math.round((ms - now) / 1000)));
        };
        const bad = locks.filter((r) => r.state === "locked" || r.state === "starved").length;
        return (
          <Box title="模型锁池" hint="哪些模型不能用、还要锁多久"
            extra={locks.length > 0 ? <span className="dim" style={{ fontSize: 12 }}>
              {bad ? bad + " 个模型整池不可用" : locks.length + " 个模型部分限流"}
            </span> : undefined}>
            <div className="tbl-wrap">
              <table className="tbl tbl-locks">
                <thead><tr>
                  <th>模型</th><th>域</th><th>状态</th><th>可选/总数</th><th>锁定</th>
                  <th>最早解锁</th><th>全部解锁</th><th>原因</th>
                </tr></thead>
                <tbody>
                  {locks.length === 0 && (
                    <tr><td colSpan={8} className="dim" style={{ textAlign: "center", padding: 30 }}>
                      当前没有模型级限流 —— 所有模型均可选
                    </td></tr>
                  )}
                  {locks.map((r) => {
                    const st = STATE[r.state] ?? ["dim", r.state];
                    return (
                      <tr key={r.realm + "/" + r.model}>
                        <td className="mono">{r.model}</td>
                        <td>{r.realm === "global" ? "国际版" : "国内版"}</td>
                        <td><span className={"tag " + st[0]}>{st[1]}</span></td>
                        <td className="mono">{r.servable} / {r.total}</td>
                        <td className="mono">{r.locked}</td>
                        <td className="dim">{left(r.unlock_at || r.fully_unlock_at)}</td>
                        <td className="dim">{left(r.fully_unlock_at)}</td>
                        <td className="dim" style={{ maxWidth: 260 }}>{r.reason || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Box>
        );
      })()}

      {addOpen && <AddAccountModal onClose={() => setAddOpen(false)}
        onDone={async () => { setAddOpen(false); await onRefresh(); }} />}
    </>
  );
}
