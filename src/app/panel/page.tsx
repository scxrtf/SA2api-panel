"use client";
// 管理面板入口（CloseRouter 大改版）：只负责鉴权态 / 视图调度 / overview 轮询，
// 外壳（机柜+侧边栏+页头）在 components/shell.tsx，登录页在 components/login.tsx。
import React, { useCallback, useEffect, useState } from "react";
import { req, useAutoRefresh, emitPanelRefresh } from "./lib";
import type { Overview } from "./components/ui";
import { Shell } from "./components/shell";
import { LoginScreen } from "./components/login";
import type { View } from "./nav";
import { AccountsView } from "./views/accounts";
import { UsageView } from "./views/usage";
import { AnalyticsView } from "./views/analytics";
import { PackagesView } from "./views/packages";
import { BalHistView } from "./views/balhist";
import { TasksCenterView } from "./views/taskscenter";
import { ModelsView } from "./views/models";
import { AiCheckerView } from "./views/aichecker";
import { GatewayView } from "./views/gateway";
import { ConnectView } from "./views/connect";
import { ConfigView } from "./views/config";
import { LogsView } from "./views/logs";

export default function PanelPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [view, setView] = useState<View>("accounts");
  // 首次进入后保持视图挂载：切 tab 只隐藏，不卸载。
  // 这样模型实测、指纹鉴别、任务队列等长时间执行不会被中断，结果也不会随
  // 组件卸载而丢失。
  const [visited, setVisited] = useState<Set<View>>(() => new Set(["accounts"]));
  const [ov, setOv] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [syncAt, setSyncAt] = useState<number | null>(null);

  const selectView = useCallback((v: View) => {
    setView(v);
    setVisited((prev) => {
      if (prev.has(v)) return prev;
      const next = new Set(prev);
      next.add(v);
      return next;
    });
  }, []);

  const flash = useCallback((kind: "ok" | "err", text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 4200);
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      const r = await req<Overview>("overview");
      setOv(r); setAuthed(true);
      setSyncAt(Date.now());
    } catch (e) {
      if (e instanceof Error && e.message === "__AUTH__") setAuthed(false);
      else flash("err", e instanceof Error ? e.message : String(e));
    }
  }, [flash]);

  useEffect(() => { loadOverview(); }, [loadOverview]);
  useAutoRefresh(() => { void loadOverview(); }, 15_000, authed === true);

  // 顶栏刷新：先刷 overview（侧边栏统计），再广播事件让当前视图刷自己的数据。
  // 返回 Promise 供按钮进入加载态：转圈持续到 overview 落定，
  // 期间视图自己的 load 也在并行跑，视觉反馈与实际刷新基本同时结束。
  const handleRefresh = useCallback((): Promise<void> => {
    emitPanelRefresh();
    return loadOverview();
  }, [loadOverview]);

  if (authed === false) {
    return <LoginScreen onSubmit={loadOverview} msg={msg} />;
  }

  return (
    <Shell view={view} onSelect={selectView} ov={ov} syncAt={syncAt}
      onRefresh={handleRefresh} msg={msg}>
      {visited.has("accounts") && (
        <ViewPane active={view === "accounts"}>
          {ov
            ? <AccountsView ov={ov} flash={flash} onRefresh={loadOverview} />
            : <div className="box"><div className="pad dim">加载中…</div></div>}
        </ViewPane>
      )}
      {visited.has("usage") && <ViewPane active={view === "usage"}><UsageView flash={flash} /></ViewPane>}
      {visited.has("analytics") && <ViewPane active={view === "analytics"}><AnalyticsView flash={flash} /></ViewPane>}
      {visited.has("packages") && <ViewPane active={view === "packages"}><PackagesView flash={flash} /></ViewPane>}
      {visited.has("balhist") && <ViewPane active={view === "balhist"}><BalHistView flash={flash} /></ViewPane>}
      {visited.has("taskscenter") && <ViewPane active={view === "taskscenter"}><TasksCenterView flash={flash} /></ViewPane>}
      {visited.has("models") && <ViewPane active={view === "models"}><ModelsView flash={flash} /></ViewPane>}
      {visited.has("aichecker") && <ViewPane active={view === "aichecker"}><AiCheckerView flash={flash} /></ViewPane>}
      {visited.has("gateway") && <ViewPane active={view === "gateway"}><GatewayView flash={flash} /></ViewPane>}
      {visited.has("connect") && <ViewPane active={view === "connect"}><ConnectView /></ViewPane>}
      {visited.has("config") && <ViewPane active={view === "config"}><ConfigView flash={flash} /></ViewPane>}
      {visited.has("logs") && <ViewPane active={view === "logs"}><LogsView flash={flash} /></ViewPane>}
    </Shell>
  );
}

// ViewPane 为已访问视图保留挂载状态；隐藏用 hidden，不动子树。
function ViewPane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <div className={"view-pane" + (active ? " view-anim" : "")} hidden={!active} aria-hidden={!active}>
      {children}
    </div>
  );
}
