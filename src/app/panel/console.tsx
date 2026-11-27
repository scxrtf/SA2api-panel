"use client";
import React, { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { req, useAutoRefresh, emitPanelRefresh, PanelActivityProvider } from "./lib";
import { LoadingIndicator, type Overview } from "./components/ui";
import { Shell } from "./components/shell";
import { isPanelView, NAV, panelHref, panelView, type View } from "./nav";
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
import { CloudbaseView } from "./views/cloudbase";
import { LogsView } from "./views/logs";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { TrafficBoard } from "@/features/agent-workspace/traffic-board";

export function PanelConsole({ workspaceEnabled }: { workspaceEnabled: boolean }) {
  const router = useRouter();
  const view = panelView(usePathname(), useSearchParams()?.get("view") ?? null);
  // 首次进入后保持视图挂载：切 tab 只隐藏，不卸载。
  // 这样模型实测、指纹鉴别、任务队列等长时间执行不会被中断，结果也不会随
  // 组件卸载而丢失。
  const [visited, setVisited] = useState<Set<View>>(() => new Set([view]));
  const [ov, setOv] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [syncAt, setSyncAt] = useState<number | null>(null);
  const [authState, setAuthState] = useState<"checking" | "ready" | "unavailable">("checking");

  const selectView = useCallback((next: View) => {
    if (next !== view) router.push(panelHref(next), { scroll: false });
  }, [router, view]);

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [view]);
  useEffect(() => {
    if (visited.has(view)) return;
    const id = setTimeout(() => setVisited((items) => new Set(items).add(view)), 0);
    return () => clearTimeout(id);
  }, [view, visited]);

  const flash = useCallback((kind: "ok" | "err", text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 4200);
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      const r = await req<Overview>("overview");
      setOv(r);
      setSyncAt(Date.now());
      setAuthState("ready");
    } catch (e) {
      setAuthState((previous) => previous === "ready" ? "ready" : "unavailable");
      flash("err", e instanceof Error ? e.message : String(e));
    }
  }, [flash]);

  useEffect(() => { const t = setTimeout(() => { void loadOverview(); }, 0); return () => clearTimeout(t); }, [loadOverview]);
  useAutoRefresh(() => { void loadOverview(); }, 120_000, authState === "ready");

  // 顶栏刷新：先刷 overview（侧边栏统计），再广播事件让当前视图刷自己的数据。
  // 返回 Promise 供按钮进入加载态：转圈持续到 overview 落定，
  // 期间视图自己的 load 也在并行跑，视觉反馈与实际刷新基本同时结束。
  const handleRefresh = useCallback((): Promise<void> => {
    emitPanelRefresh();
    return loadOverview();
  }, [loadOverview]);

  if (view !== "workspace" && authState === "checking") {
    return <main className="login-wrap" aria-busy="true"><LoadingIndicator label="正在打开面板…" /></main>;
  }
  if (view !== "workspace" && authState === "unavailable") {
    return <main className="login-wrap"><div className="card">
      <p role="alert">{msg?.text || "面板暂时不可用。"}</p>
      <Button variant="outline" className="mt-3" onClick={() => { setAuthState("checking"); void loadOverview(); }}>重新连接</Button>
    </div></main>;
  }

  const panes: Record<View, React.ReactNode> = {
    accounts: ov ? <AccountsView ov={ov} flash={flash} onRefresh={loadOverview} />
      : <div className="box" aria-busy="true"><LoadingIndicator label="正在加载账号池…" /></div>,
    usage: <UsageView flash={flash} />,
    analytics: <AnalyticsView flash={flash} />,
    packages: <PackagesView flash={flash} />,
    balhist: <BalHistView flash={flash} />,
    taskscenter: <TasksCenterView flash={flash} />,
    models: <ModelsView flash={flash} />,
    aichecker: <AiCheckerView flash={flash} />,
    gateway: <GatewayView flash={flash} />,
    connect: <ConnectView />,
    config: <ConfigView flash={flash} />,
    cloudbase: <CloudbaseView flash={flash} />,
    logs: <LogsView flash={flash} />,
    workspace: <TrafficBoard enabled={workspaceEnabled} active={view === "workspace"} />,
  };

  return <Tabs className="panel-navigation-tabs" value={view} onValueChange={(next) => {
    if (isPanelView(next)) selectView(next);
  }}>
    <Shell view={view} onSelect={selectView} ov={ov} syncAt={syncAt} onRefresh={handleRefresh} msg={view === "workspace" ? null : msg}>
      {NAV.map(({ id }) => (id === view || visited.has(id)) && (
        <ViewPane value={id} active={id === view} key={id}>{panes[id]}</ViewPane>
      ))}
    </Shell>
  </Tabs>;
}

// ViewPane 为已访问视图保留挂载状态；隐藏用 hidden，不动子树。
function ViewPane({ value, active, children }: { value: View; active: boolean; children: React.ReactNode }) {
  return (
    <TabsContent value={value} keepMounted className={"view-pane" + (active ? " view-anim" : "")} hidden={!active}>
      <PanelActivityProvider active={active}>{children}</PanelActivityProvider>
    </TabsContent>
  );
}
