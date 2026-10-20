"use client";
// 面板外壳（CloseRouter 布局）：侧边栏 + 机柜 + ControlHeader 分页式顶栏。
// 机柜单元 / 侧边栏 / 页头圆点三者共享同一 view 选中态，与原作
// 「机柜七层与功能页双向联动」一致。
import React, { useState } from "react";
import { fmtDur } from "../lib";
import type { Overview } from "./ui";
import { NAV, pad2, type View } from "../nav";
import { Rack, RackBase } from "./rack";

export function Shell({ view, onSelect, ov, syncAt, onRefresh, msg, children }: {
  view: View; onSelect: (v: View) => void;
  ov: Overview | null; syncAt: number | null;
  onRefresh: () => void;
  msg: { kind: "ok" | "err"; text: string } | null;
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(true);
  const idx = NAV.findIndex((n) => n.id === view);
  const t = NAV[idx];

  return (
    <div className={"shell" + (navOpen ? "" : " nav-off")}>
      <nav className="sidenav">
        <div className="brand">
          <div className="name">WorkBuddy2API</div>
          <div className="sub">WB2A · CONSOLE</div>
        </div>
        <ul>
          {NAV.map((n, i) => (
            <li key={n.id}>
              <a className={view === n.id ? "on" : ""} onClick={() => onSelect(n.id)}>
                <span className="num">{pad2(i + 1)}</span>
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
        <Rack view={view} onSelect={onSelect} />
        <RackBase />

        <div className="topbar">
          <div className="tb-meta">
            <span className="tb-idx">{pad2(idx + 1)} / {pad2(NAV.length)}</span>
            <span className="tb-dot-sep">·</span>
            <span className="tb-slug">{t.code}</span>
            <span className="tb-dots">
              {NAV.map((n) => (
                <button key={n.id} title={n.label}
                  className={"tb-dot" + (n.id === view ? " on" : "")}
                  onClick={() => onSelect(n.id)} />
              ))}
            </span>
            <span className="grow"></span>
            {ov && <span className="meta">运行 {fmtDur(ov.uptime_sec)}</span>}
            <span className="meta">上次同步 {syncAt ? new Date(syncAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</span>
            <button className="btn ghost xs" onClick={onRefresh}>刷新</button>
            <button className="sidenav-toggle" title="收起/展开导航" onClick={() => setNavOpen(!navOpen)}>☰</button>
          </div>
          <h2 className="tb-title">{t.title}</h2>
          <div className="tb-sub">{t.sub}</div>
        </div>

        {msg && <div className={"msg " + msg.kind}>{msg.text}</div>}

        <div key={view} className="view-anim">{children}</div>
      </div>
    </div>
  );
}
