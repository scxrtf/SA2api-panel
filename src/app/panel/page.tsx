"use client";
// 管理面板外壳（P3 重构）：侧边栏导航 + 8 视图调度。
// 对齐 Go internal/panel/index.html 的 shell/nav/main/topbar 结构。
import React, { useCallback, useEffect, useState } from "react";
import { req, getKey, setKey, fmtDur, useAutoRefresh } from "./lib";
import type { Overview } from "./components/ui";
import { AccountsView } from "./views/accounts";
import { UsageView } from "./views/usage";
import { PackagesView } from "./views/packages";
import { TasksCenterView } from "./views/taskscenter";
import { ModelsView } from "./views/models";
import { GatewayView } from "./views/gateway";
import { ConnectView } from "./views/connect";
import { ConfigView } from "./views/config";
import { LogsView } from "./views/logs";

type View = "accounts" | "usage" | "packages" | "taskscenter" | "models" | "gateway" | "connect" | "config" | "logs";

const NAV: { id: View; label: string; icon: React.ReactNode }[] = [
  { id: "accounts", label: "账号池", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="5.5" r="2.6" /><path d="M2.8 13.5c.6-2.6 2.7-4 5.2-4s4.6 1.4 5.2 4" /></svg> },
  { id: "usage", label: "用量", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2 13.5h12" /><path d="M4.5 13.5V8.2M8 13.5V3.5M11.5 13.5v-3" /></svg> },
  { id: "packages", label: "积分构成", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2.2 5.4 8 2.5l5.8 2.9v5.2L8 13.5l-5.8-2.9z" /><path d="M2.2 5.4 8 8.3l5.8-2.9M8 8.3v5.2" /></svg> },
  { id: "taskscenter", label: "任务中心", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 2.5h10v9H8l-3 3v-3H3z" /><path d="M6 6.5h4M6 9h2.5" /></svg> },
  { id: "models", label: "模型与档位", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M8 1.8 14 5v6L8 14.2 2 11V5z" /><path d="M2 5l6 3.2L14 5M8 8.2v6" /></svg> },
  { id: "gateway", label: "供应商与密钥", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2.5 8h3M10.5 8h3M8 2.5v3M8 10.5v3" /><circle cx="8" cy="8" r="2.2" /><circle cx="4" cy="8" r="1.4" /><circle cx="12" cy="8" r="1.4" /></svg> },
  { id: "connect", label: "接入引导", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M6.5 9.5 9.5 6.5" /><path d="M3 10.5c.8.8 2 .8 2.8 0L7 9.3M13 5.5c-.8-.8-2-.8-2.8 0L9 6.7" /><circle cx="3.5" cy="10.5" r="1.2" /><circle cx="12.5" cy="5.5" r="1.2" /></svg> },
  { id: "config", label: "配置", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><circle cx="8" cy="8" r="2.2" /><path d="M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" /></svg> },
  { id: "logs", label: "运行日志", icon: <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7" /></svg> },
];

const TITLES: Record<View, { title: string; sub: string }> = {
  accounts: { title: "账号池", sub: "池内账号状态与批量操作" },
  usage: { title: "用量", sub: "请求与积分消耗统计" },
  packages: { title: "积分构成", sub: "各账号套餐包与到期分布" },
  taskscenter: { title: "任务中心", sub: "成长任务扫描与队列执行" },
  models: { title: "模型与档位", sub: "可用模型目录与连通性实测" },
  gateway: { title: "供应商与密钥", sub: "聚合供应商与网关子密钥" },
  connect: { title: "接入引导", sub: "OpenAI / Anthropic 客户端接入片段" },
  config: { title: "配置", sub: "运行与调度参数，保存即热生效" },
  logs: { title: "运行日志", sub: "请求日志与运行日志" },
};

export default function PanelPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
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

  // 登录页
  if (authed === false) {
    return (
      <div className="login-wrap">
        <div className="card">
          <div className="card-title">workbuddy2api 面板登录</div>
          <div className="form-row">
            <input className="input" type="password" value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { setKey(keyInput); loadOverview(); } }}
              placeholder="输入 WB2A_API_KEY" autoFocus />
          </div>
          {msg && <div className={"msg " + msg.kind}>{msg.text}</div>}
          <button className="btn primary" style={{ width: "100%" }}
            onClick={() => { setKey(keyInput); loadOverview(); }}>进入面板</button>
          <div className="dim" style={{ marginTop: 10, fontSize: 12 }}>
            密钥仅保存在浏览器 localStorage，所有请求以 Bearer 头携带。
          </div>
        </div>
      </div>
    );
  }

  const t = TITLES[view];

  return (
    <div className="shell">
      <nav className="sidenav">
        <div className="brand">
          <div className="name">WorkBuddy2API</div>
          <div className="sub">控制台（Next.js 版）</div>
        </div>
        <ul>
          {NAV.map((n) => (
            <li key={n.id}>
              <a className={view === n.id ? "on" : ""} onClick={() => setView(n.id)}>
                <span className="ic">{n.icon}</span>{n.label}
              </a>
            </li>
          ))}
        </ul>
        <div className="sig">
          <div className="row">
            <span className={"pulse" + (ov ? "" : " off")}></span>
            <span>{ov ? "已连接" : "连接中"}</span>
          </div>
          <div className="row" style={{ marginTop: 5 }}>
            <span>{ov ? "v" + ov.version : "v-"}</span>
          </div>
        </div>
      </nav>

      <div className="main">
        <div className="topbar">
          <h2>{t.title}</h2>
          <span className="sep">/</span>
          <span className="meta">{t.sub}</span>
          <div className="grow"></div>
          {ov && <span className="meta">运行 {fmtDur(ov.uptime_sec)}</span>}
          <span className="meta">上次同步 {syncAt ? new Date(syncAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</span>
          <button className="btn ghost" onClick={loadOverview}>刷新</button>
        </div>

        {msg && <div className={"msg " + msg.kind}>{msg.text}</div>}

        {view === "accounts" && (ov
          ? <AccountsView ov={ov} flash={flash} onRefresh={loadOverview} />
          : <div className="box"><div className="pad dim">加载中…</div></div>)}
        {view === "usage" && <UsageView flash={flash} />}
        {view === "packages" && <PackagesView flash={flash} />}
        {view === "taskscenter" && <TasksCenterView flash={flash} />}
        {view === "models" && <ModelsView flash={flash} />}
        {view === "gateway" && <GatewayView flash={flash} />}
        {view === "connect" && <ConnectView />}
        {view === "config" && <ConfigView flash={flash} />}
        {view === "logs" && <LogsView flash={flash} />}
      </div>
    </div>
  );
}
