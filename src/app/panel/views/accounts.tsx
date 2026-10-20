"use client";
// 账号池视图（对齐 Go view-accounts）：统计条 + 批量操作 + 账号表 + 模型锁池。
import React, { useCallback, useState } from "react";
import { req, fmtNum, fmtTime, fmtDur } from "../lib";
import { Box, type StatusRow, type Overview, type Flash } from "../components/ui";
import { CtrlMetric, CtrlAction, CtrlCard, CtrlHint } from "../components/ctrl";
import { AddAccountModal } from "../components/addAccount";

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

export function AccountsView({ ov, flash, onRefresh }: {
  ov: Overview; flash: Flash; onRefresh: () => Promise<void>;
}) {
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

  const batch = useCallback(async (path: string, label: string) => {
    try { await req(path, { method: "POST" }); flash("ok", label + " 已开始，结果见运行日志"); }
    catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  }, [flash]);

  const modelLocks = React.useMemo(() => {
    const m = new Map<string, { realm: string; locked: string[]; until: number; reason: string }>();
    for (const a of ov.accounts) {
      for (const rl of a.rate_limited_models) {
        const cur = m.get(rl.model) ?? { realm: a.realm, locked: [], until: 0, reason: rl.reason };
        cur.locked.push(a.nickname || a.uid);
        if (rl.until > cur.until) cur.until = rl.until;
        m.set(rl.model, cur);
      }
    }
    return [...m.entries()];
  }, [ov.accounts]);

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
        <CtrlMetric label="粘性会话" value={ov.sticky_sessions} unit="SESS" />
      </div>

      {/* CloseRouter ControlAction 批量操作区：CODE 徽章 + → */}
      <CtrlCard style={{ marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
          <CtrlAction code="ADD" text="添加账号" onClick={() => setAddOpen(true)} />
          <CtrlAction code="CHK" text="全部签到" secondary onClick={() => batch("checkin_all", "全部签到")} />
          <CtrlAction code="TRV" text="旅行巡检" secondary onClick={() => batch("travel_all", "旅行巡检")} />
          <CtrlAction code="ACT" text="活跃上报" secondary onClick={() => batch("activity_all", "活跃上报")} />
          <CtrlAction code="KEEP" text="全部保活" secondary onClick={() => batch("keepalive_all", "全部保活")} />
          <CtrlAction code="BAL" text="刷新余额" secondary onClick={() => batch("balance_all", "刷新余额")} />
        </div>
        <CtrlHint>批量操作异步执行，结果见「运行日志」页；添加账号支持浏览器授权与 JSON 导入两种方式。</CtrlHint>
      </CtrlCard>

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
          <table className="tbl">
            <thead><tr>
              <th>账号</th><th>域</th><th>积分</th><th>状态</th><th style={{ width: 1 }}></th>
            </tr></thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 30 }}>
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
                  <td>{acctTags(a).map((t) => <span key={t.text} className={"tag " + t.cls}>{t.text}</span>)}</td>
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

      {modelLocks.length > 0 && (
        <Box title="模型锁池" hint="哪些模型不能用、还要锁多久">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>模型</th><th>域</th><th>锁定账号</th><th>最早解锁</th><th>原因</th></tr></thead>
              <tbody>
                {modelLocks.map(([model, v]) => (
                  <tr key={model}>
                    <td className="mono">{model}</td>
                    <td>{v.realm}</td>
                    <td>{v.locked.join("、")}</td>
                    <td className="dim">{fmtTime(v.until)}</td>
                    <td className="dim">{v.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Box>
      )}

      {addOpen && <AddAccountModal onClose={() => setAddOpen(false)}
        onDone={async () => { setAddOpen(false); await onRefresh(); }} />}
    </>
  );
}
