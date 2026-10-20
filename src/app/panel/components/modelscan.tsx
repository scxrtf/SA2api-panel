"use client";
// 模型可用性扫描：启动 / 轮询 / 取消 + 结果表。
// 后台任务在服务端执行，切换页签或刷新面板都不会打断扫描本身。
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { req, fmtTime, fmtDur } from "../lib";
import { Box, type Flash } from "./ui";

export interface ScanIssue {
  uid: string;
  nickname: string;
  realm: string;
  model: string;
  full_model: string;
  status: number;
  kind: string;
  code: string;
  label: string;
  message: string;
  at: number;
}

export interface ModelScanSnapshot {
  id: string;
  running: boolean;
  status: "running" | "done" | "cancelled" | "error";
  started_at: number;
  updated_at: number;
  finished_at: number;
  accounts_total: number;
  accounts_done: number;
  total: number;
  done: number;
  ok: number;
  bad: number;
  skipped: number;
  skipped_accounts: number;
  current: string;
  issues: ScanIssue[];
  error: string;
}

export function useModelScan(flash: Flash, onDone: () => Promise<void>) {
  const [scan, setScan] = useState<ModelScanSnapshot | null>(null);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    const r = await req<{ scan: ModelScanSnapshot | null }>("accounts/scan_models");
    setScan(r.scan);
    if (wasRunning.current && r.scan && !r.scan.running) {
      try { await onDone(); } catch { /* overview 刷新失败不覆盖扫描结论 */ }
      if (r.scan.status === "done") {
        flash("ok", r.scan.bad > 0
          ? "模型扫描完成：发现 " + r.scan.bad + " 个异常"
          : "模型扫描完成：全部模型可用");
      } else if (r.scan.status === "cancelled") {
        flash("ok", "模型扫描已取消");
      } else if (r.scan.error) {
        flash("err", "模型扫描失败：" + r.scan.error);
      }
    }
    wasRunning.current = !!r.scan?.running;
  }, [flash, onDone]);

  useEffect(() => {
    // 首次挂载拉取当前任务；load 内部只会在 await 之后 setState。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load().catch((e) => {
      if (e instanceof Error && e.message === "__AUTH__") return;
      flash("err", e instanceof Error ? e.message : String(e));
    });
  }, [load, flash]);

  useEffect(() => {
    if (!scan?.running) return;
    const t = setInterval(() => {
      void load().catch(() => { /* 轮询失败下一轮重试 */ });
    }, 2000);
    return () => clearInterval(t);
  }, [scan?.running, load]);

  const start = useCallback(async (): Promise<void> => {
    try {
      const r = await req<{ scan: ModelScanSnapshot }>("accounts/scan_models", { method: "POST" });
      setScan(r.scan);
      wasRunning.current = true;
      flash("ok", "模型扫描已开始，后台执行，可切换其他页签");
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    }
  }, [flash]);

  const cancel = useCallback(async (): Promise<void> => {
    try {
      await req("accounts/scan_models", { method: "DELETE" });
      await load();
    } catch (e) {
      flash("err", e instanceof Error ? e.message : String(e));
    }
  }, [flash, load]);

  return { scan, start, cancel };
}

// useScanNow 扫描计时：只在扫描中每秒更新，避免渲染期取 Date.now。
function useScanNow(running: boolean): number {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!running) return;
    const tick = () => setNow(Date.now());
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [running]);
  return now;
}

export function ModelScanPanel({ scan, onCancel }: {
  scan: ModelScanSnapshot;
  onCancel: () => void | Promise<void>;
}) {
  const now = useScanNow(scan.running);
  const [filter, setFilter] = useState<"all" | "6004" | "429" | "11102" | "other">("all");

  const counts = useMemo(() => {
    let r6004 = 0, r429 = 0, r11102 = 0;
    for (const i of scan.issues) {
      if (i.code === "6004") r6004++;
      else if (i.code === "429") r429++;
      else if (i.code === "11102") r11102++;
    }
    return { "6004": r6004, "429": r429, "11102": r11102, other: scan.issues.length - r6004 - r429 - r11102 };
  }, [scan.issues]);

  const shown = useMemo(() => {
    if (filter === "all") return scan.issues;
    if (filter === "other") return scan.issues.filter((i) => !["6004", "429", "11102"].includes(i.code));
    return scan.issues.filter((i) => i.code === filter);
  }, [scan.issues, filter]);

  const pct = scan.total > 0 ? Math.min(100, (scan.done / scan.total) * 100) : 0;
  const endAt = scan.finished_at > 0 ? scan.finished_at : (now > 0 ? now : scan.updated_at);
  const elapsed = Math.max(0, Math.round((endAt - scan.started_at) / 1000));
  const statusTag = scan.running
    ? <span className="tag info">扫描中</span>
    : scan.status === "done"
      ? <span className="tag ok">已完成</span>
      : scan.status === "cancelled"
        ? <span className="tag warn">已取消</span>
        : <span className="tag err">失败</span>;

  return (
    <Box title="模型可用性扫描" hint="逐个账号真实探测；已锁定模型自动跳过"
      extra={<div className="btn-row" style={{ gap: 6, alignItems: "center" }}>
        {statusTag}
        <span className="dim" style={{ fontSize: 12 }}>用时 {fmtDur(elapsed)}</span>
        {scan.running && (
          <button className="btn xs danger" onClick={() => void onCancel()}>取消扫描</button>
        )}
      </div>}>
      <div className="pad" style={{ paddingBottom: 10 }}>
        <div className="scan-progress" title={scan.total > 0 ? scan.done + " / " + scan.total : "准备中"}>
          <i style={{ width: pct.toFixed(1) + "%" }}></i>
        </div>
        <div className="scan-meta">
          <span><b>{scan.accounts_done}</b><span className="dim"> / {scan.accounts_total} 账号</span></span>
          <span><b>{scan.done}</b><span className="dim"> / {scan.total} 模型</span></span>
          <span className="scan-ok"><b>{scan.ok}</b> 可用</span>
          <span className="scan-bad"><b>{scan.bad}</b> 异常</span>
          <span className="dim">跳过 {scan.skipped_accounts} 账号 / {scan.skipped} 模型</span>
          {scan.running && <span className="dim scan-current" title={scan.current}>
            当前：{scan.current || "准备中…"}
          </span>}
        </div>
        {scan.error && <div className="hint" style={{ color: "var(--err)" }}>{scan.error}</div>}
        {!scan.running && scan.issues.length === 0 && (
          <div className="dim" style={{ fontSize: 12.5 }}>
            {scan.status === "done" ? "未发现限流或不可用的模型。" : "没有扫描结果。"}
          </div>
        )}
      </div>

      {scan.issues.length > 0 && (
        <>
          <div className="pad" style={{ paddingTop: 0, paddingBottom: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
            {([
              ["all", "全部 " + scan.issues.length],
              ["6004", "6004 " + counts["6004"]],
              ["429", "429 " + counts["429"]],
              ["11102", "11102 " + counts["11102"]],
              ["other", "其他 " + counts.other],
            ] as const).map(([v, text]) => (
              <button key={v} className={"btn xs" + (filter === v ? " primary" : "")}
                onClick={() => setFilter(v)}>{text}</button>
            ))}
          </div>
          <div className="tbl-wrap" style={{ maxHeight: 420, overflow: "auto" }}>
            <table className="tbl tbl-scan">
              <thead><tr>
                <th>账号</th><th>模型</th><th>结果</th><th>HTTP</th><th>上游信息</th><th>时间</th>
              </tr></thead>
              <tbody>
                {shown.length === 0 && (
                  <tr><td colSpan={6} className="dim" style={{ textAlign: "center", padding: 24 }}>
                    当前筛选下没有记录
                  </td></tr>
                )}
                {shown.map((i, n) => (
                  <tr key={i.uid + "\x1f" + i.model + "\x1f" + i.at + "\x1f" + n}>
                    <td>
                      <div>{i.nickname || i.uid}</div>
                      <div className="dim mono" style={{ fontSize: 11 }}>{i.uid}</div>
                    </td>
                    <td className="mono" style={{ whiteSpace: "normal" }}>
                      {i.model}
                      <div className="dim" style={{ fontSize: 11 }}>{i.realm === "global" ? "国际版" : "国内版"}</div>
                    </td>
                    <td><span className={"tag " + issueCls(i)}>{i.label}</span></td>
                    <td className="mono dim">{i.status > 0 ? i.status : "—"}</td>
                    <td className="dim" style={{ maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      title={i.message}>{i.message || "—"}</td>
                    <td className="mono dim">{fmtTime(i.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Box>
  );
}

function issueCls(i: ScanIssue): string {
  if (i.code === "6004") return "warn";
  if (i.code === "429" || i.code === "11102" || i.code === "402" || i.code === "12153" || i.code === "catalog") return "err";
  if (i.code === "timeout" || i.code === "transport" || i.code === "5xx") return "warn";
  return "info";
}
