"use client";
// 账号池视图（对齐 Go view-accounts）：统计条 + 批量操作 + 账号表 + 模型锁池。
import React, { useCallback, useState } from "react";
import { req, fmtNum, fmtTime, fmtDur } from "../lib";
import { Box, type StatusRow, type Overview, type Flash } from "../components/ui";
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

  return (
    <>
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        <div className="stat"><div className="stat-num">{ov.total}</div><div className="stat-label">账号总数</div></div>
        <div className="stat"><div className="stat-num" style={{ color: "var(--ok)" }}>{ov.healthy}</div><div className="stat-label">可用</div></div>
        <div className="stat"><div className="stat-num" style={{ color: "var(--warn)" }}>{ov.cooling}</div><div className="stat-label">冷却中</div></div>
        <div className="stat"><div className="stat-num" style={{ color: "var(--err)" }}>{ov.disabled}</div><div className="stat-label">已禁用</div></div>
        <div className="stat"><div className="stat-num" style={{ color: "var(--warn)" }}>{ov.paused}</div><div className="stat-label">已暂停选号</div></div>
        <div className="stat"><div className="stat-num">{ov.sticky_sessions}</div><div className="stat-label">粘性会话</div></div>
      </div>

      <Box title="账号池" extra={<>
        <button className="btn xs" onClick={() => batch("checkin_all", "全部签到")}>全部签到</button>
        <button className="btn xs" onClick={() => batch("travel_all", "旅行巡检")}>旅行巡检</button>
        <button className="btn xs" onClick={() => batch("activity_all", "活跃上报")}>活跃上报</button>
        <button className="btn xs" onClick={() => batch("keepalive_all", "全部保活")}>全部保活</button>
        <button className="btn xs" onClick={() => batch("balance_all", "刷新余额")}>刷新余额</button>
        <button className="btn xs primary" onClick={() => setAddOpen(true)}>添加账号</button>
      </>}>
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr>
              <th>账号</th><th>域</th><th>积分</th><th>状态</th><th style={{ width: 1 }}></th>
            </tr></thead>
            <tbody>
              {ov.accounts.length === 0 && (
                <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 30 }}>
                  暂无账号，点「添加账号」开始设备授权登录。
                </td></tr>
              )}
              {ov.accounts.map((a) => (
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
                    <div className="btn-row">
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
