"use client";
// 面板外壳（CloseRouter 布局）：侧边栏 + 机柜 + ControlHeader 分页式顶栏。
// 机柜单元 / 侧边栏 / 页头圆点三者共享同一 view 选中态，与原作
// 「机柜七层与功能页双向联动」一致。
import React, { useEffect, useState } from "react";
import { fmtDur } from "../lib";
import type { Overview } from "./ui";
import { NAV, pad2, type View } from "../nav";
import { Rack, RackBase } from "./rack";

export function Shell({ view, onSelect, ov, syncAt, onRefresh, msg, children }: {
  view: View; onSelect: (v: View) => void;
  ov: Overview | null; syncAt: number | null;
  onRefresh: () => void | Promise<void>;
  msg: { kind: "ok" | "err"; text: string } | null;
  children: React.ReactNode;
}) {
  const [navOpen, setNavOpen] = useState(true);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const idx = NAV.findIndex((n) => n.id === view);
  const t = NAV[idx];

  // 移动端抽屉：与桌面 nav-off 分开管理，避免收起侧栏后手机上无法再次展开。
  const toggleNav = () => {
    if (window.matchMedia("(max-width: 900px)").matches) {
      setMobileNavOpen((v) => !v);
    } else {
      setNavOpen((v) => !v);
    }
  };

  const selectView = (v: View) => {
    setMobileNavOpen(false);
    onSelect(v);
  };

  // 抽屉打开时锁定背景滚动，并支持 Esc 关闭。
  useEffect(() => {
    if (!mobileNavOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileNavOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [mobileNavOpen]);

  // 视口回到桌面宽度时复位抽屉状态，防止残留遮罩。
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const onChange = () => { if (!mq.matches) setMobileNavOpen(false); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // 顶栏刷新：onRefresh 返回 Promise 时进入加载态（转圈 + 「刷新中…」），
  // 与扫描待办等 CtrlAction 的反馈一致；落定后复位。
  const handleRefresh = () => {
    if (refreshing) return;
    const p = onRefresh();
    if (p && typeof (p as Promise<void>).then === "function") {
      setRefreshing(true);
      (p as Promise<void>).catch(() => {}).finally(() => setRefreshing(false));
    }
  };

  return (
    <div className={"shell" + (navOpen ? "" : " nav-off") + (mobileNavOpen ? " mnav-open" : "")}>
      <nav className="sidenav">
        <div className="brand">
          <div className="name">SAworkApi</div>
          <div className="sub">WB2A · CONSOLE</div>
        </div>
        <ul>
          {NAV.map((n, i) => (
            <li key={n.id}>
              <a className={view === n.id ? "on" : ""} onClick={() => selectView(n.id)}>
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
      <div className="nav-scrim" onClick={() => setMobileNavOpen(false)} aria-hidden="true"></div>

      <div className="main">
        <Rack view={view} onSelect={selectView} />
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
                  onClick={() => selectView(n.id)} />
              ))}
            </span>
            <span className="grow"></span>
            {ov && <span className="meta">运行 {fmtDur(ov.uptime_sec)}</span>}
            <span className="meta">上次同步 {syncAt ? new Date(syncAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</span>
            <button className="btn ghost xs" onClick={handleRefresh} disabled={refreshing}>
              {refreshing && <span className="spin" style={{ marginRight: 5 }} />}
              {refreshing ? "刷新中…" : "刷新"}
            </button>
            <button className="sidenav-toggle" title="收起/展开导航"
              aria-label={mobileNavOpen ? "关闭导航" : "打开导航"}
              aria-expanded={mobileNavOpen || navOpen} onClick={toggleNav}>
              {mobileNavOpen ? "✕" : "☰"}
            </button>
          </div>
          <h2 className="tb-title">{t.title}</h2>
          <div className="tb-sub">{t.sub}</div>
        </div>

        {msg && <div className={"msg " + msg.kind}>{msg.text}</div>}

        <div className="view-host">{children}</div>
      </div>
    </div>
  );
}
