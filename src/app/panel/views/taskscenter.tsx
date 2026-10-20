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

interface DisplayTask {
  code: string;
  name: string;
  progress: string;
  credit?: number;
  rewardBuddy?: boolean;
  queue?: QueueItem;
}

interface DisplayAccount {
  uid: string;
  nickname: string;
  error?: string;
  tasks: DisplayTask[];
}

function taskName(t: GrowthTask): string {
  return t.title ?? t.task_desc ?? t.description ?? t.task_code;
}
function progressText(t: GrowthTask): string {
  if (t.claimed) return "已领奖";
  if (t.claimable) return "可领奖";
  return t.current + "/" + t.target;
}

const QUEUE_STATUS: Record<string, { text: string; cls: string }> = {
  pending: { text: "排队中", cls: "" },
  running: { text: "执行中", cls: "info" },
  done: { text: "已完成", cls: "ok" },
  skipped: { text: "已跳过", cls: "warn" },
  error: { text: "失败", cls: "err" },
};

export function TasksCenterView({ flash }: { flash: Flash }) {
  const [scanned, setScanned] = useState<ScanAccount[] | null>(null);
  const [pending, setPending] = useState(0);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [conc, setConc] = useState(1);
  const [busy, setBusy] = useState(false);
  // scanSeq / scanAt：每次手动扫描递增/更新。scanSeq 用来强制重建列表
  // （即使第二次扫描拿到的数据与第一次完全相同，也能看到刷新发生），
  // scanAt 在标题栏显示「上次扫描」时间，避免用户误以为按钮没生效。
  const [scanSeq, setScanSeq] = useState(0);
  const [scanAt, setScanAt] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => { if (poll.current) { clearInterval(poll.current); poll.current = null; } };
  useEffect(() => stopPoll, []);

  const refreshQueue = useCallback(async () => {
    try { setQueue(await req<QueueStatus>("tasks/queue")); } catch { /* 忽略 */ }
  }, []);

  const scan = useCallback(async () => {
    setBusy(true);
    setScanning(true);
    // 重新扫描时先把上一轮已结束的队列状态摘掉，避免旧状态在新一轮扫描
    // 完成前继续贴在列表上；仍在执行的队列保留，扫描期间继续显示实时进度。
    setQueue((q) => (q?.running ? q : null));
    try {
      const r = await req<{ accounts: ScanAccount[]; pending_count: number }>("tasks/scan_all", { method: "POST" });
      setScanned(r.accounts); setPending(r.pending_count);
      setScanSeq((n) => n + 1);
      setScanAt(Date.now());
      // 再对一次队列状态：只接纳仍在执行的队列。上一轮已经结束的队列
      // 若继续回填，会以「已完成/失败」的名义重新贴到新一轮扫描结果上。
      try {
        const qs = await req<QueueStatus>("tasks/queue");
        setQueue(qs.running && qs.total > 0 ? qs : null);
      } catch { /* 队列状态失败不影响扫描结果 */ }
      flash("ok", "扫描完成：共 " + r.pending_count + " 项待办");
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
    finally { setScanning(false); setBusy(false); }
  }, [flash]);

  const runQueue = useCallback(async () => {
    setBusy(true);
    try {
      const r = await req<{ started: boolean; total: number; msg?: string; message?: string }>(
        "tasks/run_queue", { method: "POST", body: { concurrency: conc } });
      if (r.started) {
        flash("ok", "队列已启动：" + r.total + " 项待办");
        stopPoll();
        poll.current = setInterval(refreshQueue, 2000);
      } else {
        flash("err", r.msg ?? r.message ?? "队列未启动");
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

  const items = React.useMemo(() => queue?.items ?? [], [queue]);
  const doneCount = items.filter((i) => i.status === "done" || i.status === "skipped").length;
  const pct = items.length > 0 ? Math.round((doneCount / items.length) * 100) : 0;

  // 执行状态不再切到另一张队列表：把 queue 的 status/message 直接回填到
  // 原「扫描待办」的账号-任务列表里。没有先扫描时，用 queue items 反推同一
  // 套账号-任务结构，保证执行开始后页面结构不变。
  const display = React.useMemo<DisplayAccount[]>(() => {
    const byUid = new Map<string, DisplayAccount>();
    const ensure = (uid: string, nickname?: string) => {
      let a = byUid.get(uid);
      if (!a) {
        a = { uid, nickname: nickname ?? "", tasks: [] };
        byUid.set(uid, a);
      } else if (!a.nickname && nickname) {
        a.nickname = nickname;
      }
      return a;
    };

    if (scanned) {
      for (const a of scanned) {
        const d = ensure(a.uid, a.nickname);
        d.error = a.growth_error;
        for (const t of a.growth ?? []) {
          d.tasks.push({
            code: t.task_code,
            name: taskName(t),
            progress: progressText(t),
            credit: t.credit,
            rewardBuddy: t.reward_buddy,
          });
        }
      }
    }

    for (const it of items) {
      // 有扫描结果时以扫描列表为准，只回填同账号同任务码的状态，避免上一轮
      // 队列的旧条目把已不在待办里的任务又带出来；没扫描过才用队列反推列表。
      if (scanned !== null) {
        const d = byUid.get(it.uid);
        const t = d?.tasks.find((x) => x.code === it.code);
        if (t) t.queue = it;
        continue;
      }
      const d = ensure(it.uid, it.nickname);
      let t = d.tasks.find((x) => x.code === it.code);
      if (!t) {
        t = { code: it.code, name: it.code, progress: "" };
        d.tasks.push(t);
      }
      t.queue = it;
    }

    return [...byUid.values()];
  }, [scanned, items]);

  const hasData = scanned !== null || items.length > 0;

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
      <CtrlHint>扫描所有账号的成长任务与开学季待办，排成队列后按并发执行；执行状态会直接回填到下方原列表。</CtrlHint>
    </CtrlCard>

    <Box title="成长任务队列"
      hint={scanning
        ? "正在刷新…"
        : queue?.running
          ? "执行中 " + doneCount + "/" + items.length
          : scanned
            ? pending + " 项待办" + (scanAt
              ? " · 上次扫描 " + new Date(scanAt).toLocaleTimeString("zh-CN", { hour12: false })
              : "")
            : undefined}>
      {queue && queue.total > 0 && (
        <div className="qprog">
          <div className="qbar"><i style={{ width: pct + "%" }}></i></div>
          <div className="note" style={{ marginTop: 6 }}>
            {queue.running ? "执行中 " : "已结束 "} {doneCount}/{items.length}（{pct}%）
          </div>
        </div>
      )}

      {!hasData ? (
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
        <>
          {scanning && (
            <div className="tc-refreshing">
              <span className="spin" /> 已扫描过，正在重新拉取最新待办…
            </div>
          )}
          <div className={"tc-list" + (scanning ? " is-refreshing" : "")} key={scanSeq} aria-busy={scanning}>
            {display.length === 0 && <div className="pad dim">所有账号均无待办，或均为 global/企业号（无 CN 成长体系）。</div>}
            {display.map((a) => (
              <div className="tc-acct" key={a.uid}>
                <h4>{a.nickname || a.uid} <span className="dim mono">{a.uid}</span></h4>
                {a.error && <div className="msg err">{a.error}</div>}
                {a.tasks.length === 0 && !a.error && <div className="dim" style={{ fontSize: 13 }}>无待办</div>}
                {a.tasks.map((t) => {
                  const st = t.queue ? (QUEUE_STATUS[t.queue.status] ?? { text: t.queue.status, cls: "" }) : null;
                  return (
                    <div className={"tc-task" + (t.queue?.status === "running" ? " running" : "")} key={t.code}>
                      <span className="nm">{t.name}</span>
                      {t.rewardBuddy && <span className="tag info">buddy</span>}
                      {t.credit ? <span className="tag ok">+{t.credit}</span> : null}
                      {st && <span className={"tag " + st.cls}>{st.text}</span>}
                      <span className="st dim qmsg" title={t.queue?.message || undefined}>
                        {t.queue?.message || t.progress}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </Box>
    </>
  );
}
