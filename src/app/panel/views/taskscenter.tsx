"use client";
// 任务中心视图（对齐 Go view-taskscenter）：成长任务队列 + 扫描待办 + 执行全部。
import React, { useCallback, useEffect, useRef, useState } from "react";
import { req } from "../lib";
import { Box, type Flash } from "../components/ui";
import { CtrlAction, CtrlCard, CtrlHint } from "../components/ctrl";

interface GrowthTask {
  task_code: string; title?: string; task_desc?: string; description?: string;
  target: number; current: number;
  claimable?: boolean; claimed?: boolean; locked?: boolean;
  credit?: number; reward_buddy?: boolean;
}
interface ScanAccount { uid: string; nickname: string; growth?: GrowthTask[]; growth_error?: string }
interface QueueItem { uid: string; nickname: string; code: string; status: string; message?: string }
interface QueueStatus {
  running: boolean; total: number; conc: number; started: boolean; seq: number;
  items: QueueItem[];
}

function taskName(t: GrowthTask): string {
  return t.title ?? t.task_desc ?? t.description ?? t.task_code;
}
function progressText(t: GrowthTask): string {
  if (t.claimed) return "已领奖";
  if (t.claimable) return "可领奖";
  return t.current + "/" + t.target;
}

export function TasksCenterView({ flash }: { flash: Flash }) {
  const [scanned, setScanned] = useState<ScanAccount[] | null>(null);
  const [pending, setPending] = useState(0);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [conc, setConc] = useState(1);
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => { if (poll.current) { clearInterval(poll.current); poll.current = null; } };
  useEffect(() => stopPoll, []);

  const refreshQueue = useCallback(async () => {
    try { setQueue(await req<QueueStatus>("tasks/queue")); } catch { /* 忽略 */ }
  }, []);

  const scan = useCallback(async () => {
    setBusy(true);
    try {
      const r = await req<{ accounts: ScanAccount[]; pending_count: number }>("tasks/scan_all", { method: "POST" });
      setScanned(r.accounts); setPending(r.pending_count);
      flash("ok", "扫描完成：共 " + r.pending_count + " 项待办");
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [flash]);

  const runQueue = useCallback(async () => {
    setBusy(true);
    try {
      const r = await req<{ started: boolean; total: number; msg: string }>(
        "tasks/run_queue", { method: "POST", body: { concurrency: conc } });
      if (r.started) {
        flash("ok", "队列已启动：" + r.total + " 项待办");
        stopPoll();
        poll.current = setInterval(refreshQueue, 2000);
      } else {
        flash("err", r.msg);
      }
      await refreshQueue();
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }, [conc, flash, refreshQueue]);

  // 队列结束后停止轮询。
  useEffect(() => {
    if (queue && !queue.running && poll.current) { stopPoll(); }
  }, [queue]);

  const schoolVouchers = useCallback(async () => {
    try {
      const d = await req<{ vouchers?: { code: string; name?: string }[] }>("school/vouchers");
      const list = d.vouchers ?? [];
      window.alert(list.length === 0 ? "无历史券码" : list.map((v) => v.code + (v.name ? "（" + v.name + "）" : "")).join("\n"));
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  }, [flash]);

  const items = queue?.items ?? [];
  const doneCount = items.filter((i) => i.status === "done" || i.status === "skipped").length;
  const pct = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;

  return (
    <>
    {/* CloseRouter ControlAction 操作区 */}
    <CtrlCard style={{ marginBottom: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 8 }}>
        <CtrlAction code="RUN" text="执行全部待办" pendingText="发起执行中…" onClick={runQueue} disabled={busy} />
        <CtrlAction code="SCAN" text="扫描待办" pendingText="扫描中…" secondary onClick={scan} disabled={busy} />
        <CtrlAction code="VOCH" text="查询券码" pendingText="查询中…" secondary onClick={schoolVouchers}
          title="开学季抽奖抽中的第三方券码（活动已结束，历史券码仍可查）" />
      </div>
      <label className="sel-note">队列并发
        <select className="select" value={conc} onChange={(e) => setConc(Number(e.target.value))}>
          <option value={1}>1</option><option value={2}>2</option><option value={3}>3</option>
        </select>
      </label>
      <CtrlHint>扫描所有账号的成长任务与开学季待办，排成队列后按并发执行；执行结果实时刷新。</CtrlHint>
    </CtrlCard>

    <Box title="成长任务队列" hint={queue?.running ? "执行中 " + doneCount + "/" + items.length : undefined}>
      {queue && queue.total > 0 && (
        <div className="qprog">
          <div className="qbar"><i style={{ width: pct + "%" }}></i></div>
          <div className="note" style={{ marginTop: 6 }}>
            {queue.running ? "执行中 " : "已结束 "} {doneCount}/{items.length}（{pct}%）
          </div>
        </div>
      )}

      {queue && items.length > 0 ? (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>账号</th><th>任务</th><th>状态</th><th>说明</th></tr></thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td>{it.nickname || it.uid}</td>
                  <td className="mono">{it.code}</td>
                  <td><span className={"tag " + (it.status === "done" ? "ok" : it.status === "error" ? "err" : it.status === "running" ? "info" : "")}>{it.status}</span></td>
                  <td className="dim">{it.message ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : scanned === null ? (
        <div className="tc-empty">
          <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="8" y="6" width="24" height="36" rx="3" />
            <path d="M14 16h12M14 24h12M14 32h7" opacity=".45" />
            <circle cx="35" cy="33" r="8" /><path d="m40 38 5 5" />
          </svg>
          <div className="t">还没有扫描过</div>
          <div className="d">扫描所有账号的成长任务与开学季待办，把没做的排成一列，一键执行。</div>
        </div>
      ) : (
        <div>
          {scanned.length === 0 && <div className="pad dim">所有账号均无待办，或均为 global/企业号（无 CN 成长体系）。</div>}
          {scanned.map((a) => (
            <div className="tc-acct" key={a.uid}>
              <h4>{a.nickname || a.uid} <span className="dim mono">{a.uid}</span></h4>
              {a.growth_error && <div className="msg err">{a.growth_error}</div>}
              {(a.growth ?? []).length === 0 && !a.growth_error && <div className="dim" style={{ fontSize: 13 }}>无待办</div>}
              {(a.growth ?? []).map((t) => (
                <div className="tc-task" key={t.task_code}>
                  <span className="nm">{taskName(t)}</span>
                  {t.reward_buddy && <span className="tag info">buddy</span>}
                  {t.credit ? <span className="tag ok">+{t.credit}</span> : null}
                  <span className="st dim">{progressText(t)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Box>
    </>
  );
}
