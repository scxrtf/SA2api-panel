"use client";
// 管理面板入口（CloseRouter 大改版）：只负责鉴权态 / 视图调度 / overview 轮询，
// 外壳（机柜+侧边栏+页头）在 components/shell.tsx，登录页在 components/login.tsx。
import React, { useCallback, useEffect, useState } from "react";
import { req, useAutoRefresh } from "./lib";
import type { Overview } from "./components/ui";
import { Shell } from "./components/shell";
import { LoginScreen } from "./components/login";
import type { View } from "./nav";
import { AccountsView } from "./views/accounts";
import { UsageView } from "./views/usage";
import { PackagesView } from "./views/packages";
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
  const [ov, setOv] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [syncAt, setSyncAt] = useState<number | null>(null);

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

  if (authed === false) {
    return <LoginScreen onSubmit={loadOverview} msg={msg} />;
  }

  return (
    <Shell view={view} onSelect={setView} ov={ov} syncAt={syncAt}
      onRefresh={loadOverview} msg={msg}>
      {view === "accounts" && (ov
        ? <AccountsView ov={ov} flash={flash} onRefresh={loadOverview} />
        : <div className="box"><div className="pad dim">加载中…</div></div>)}
      {view === "usage" && <UsageView flash={flash} />}
      {view === "packages" && <PackagesView flash={flash} />}
      {view === "taskscenter" && <TasksCenterView flash={flash} />}
      {view === "models" && <ModelsView flash={flash} />}
      {view === "aichecker" && <AiCheckerView />}
      {view === "gateway" && <GatewayView flash={flash} />}
      {view === "connect" && <ConnectView />}
      {view === "config" && <ConfigView flash={flash} />}
      {view === "logs" && <LogsView flash={flash} />}
    </Shell>
  );
}
