"use client";
import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { fmtDur } from "../lib";
import type { Overview } from "./ui";
import { NAV, pad2, panelHref, type View } from "../nav";
import { Rack } from "./rack";
import { ButtonLoadingContent } from "./ui";

const query = "(max-width: 900px)";
const isNarrow = () => window.matchMedia(query).matches;
function onWidthChange(listener: () => void) {
  const mq = window.matchMedia(query);
  mq.addEventListener("change", listener);
  return () => mq.removeEventListener("change", listener);
}

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
  const mobile = useSyncExternalStore(onWidthChange, isNarrow, () => false);
  const navigation = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const idx = NAV.findIndex((n) => n.id === view);
  const t = NAV[idx];
  const workspace = view === "workspace";
  const expanded = mobile ? mobileNavOpen : navOpen;

  // 移动端抽屉：与桌面 nav-off 分开管理，避免收起侧栏后手机上无法再次展开。
  const toggleNav = () => {
    if (mobile) {
      setMobileNavOpen((v) => !v);
    } else {
      setNavOpen((v) => !v);
    }
  };

  const closeMobile = (restoreFocus = false) => {
    setMobileNavOpen(false);
    if (restoreFocus) toggle.current?.focus({ preventScroll: true });
  };

  // 抽屉打开时锁定背景滚动，并支持 Esc 关闭。
  useEffect(() => {
    if (!mobile || !mobileNavOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focus = requestAnimationFrame(() => navigation.current?.querySelector<HTMLElement>('[aria-current="page"]')?.focus({ preventScroll: true }));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMobileNavOpen(false);
      toggle.current?.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      cancelAnimationFrame(focus);
      document.removeEventListener("keydown", onKey);
    };
  }, [mobile, mobileNavOpen]);

  // 视口回到桌面宽度时复位抽屉状态，防止残留遮罩。
  useEffect(() => {
    const mq = window.matchMedia(query);
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
    <div className={"shell panel-shell" + (workspace ? " panel-shell-workspace" : "") + (navOpen ? "" : " nav-off") + (mobileNavOpen ? " mnav-open" : "")}>
      <nav className="sidenav" id="panel-navigation" aria-label="主导航" inert={!expanded} ref={navigation}>
        <div className="brand">
          <div><div className="name">SAworkApi</div><div className="sub">WB2A CONSOLE</div></div>
          {mobile && <Button size="icon-sm" variant="ghost" aria-label="关闭侧栏" onClick={() => closeMobile(true)}><X size={16} /></Button>}
        </div>
        <ul>
          {NAV.map((n, i) => (
            <li key={n.id}>
              <Link className={buttonVariants({ variant: "ghost" }) + " panel-nav-item" + (view === n.id ? " on" : "")}
                href={panelHref(n.id)} prefetch={false} scroll={false}
                aria-current={view === n.id ? "page" : undefined} onNavigate={() => closeMobile(mobileNavOpen)}>
                <span className="num" aria-hidden="true">{pad2(i + 1)}</span>
                <span className="ic" aria-hidden="true">{n.icon}</span><span>{n.label}</span>
              </Link>
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
      <div className="nav-scrim" onClick={() => closeMobile(true)} aria-hidden="true"></div>

      <main className="main" id="panel-main">
        <Rack view={view} />

        <header className="topbar">
          <div className="tb-meta">
            <span className="tb-idx">{pad2(idx + 1)} / {pad2(NAV.length)}</span>
            <span className="tb-slug">{t.code}</span>
            <span className="tb-dots" role="group" aria-label="页签快捷入口">
              {NAV.map((n) => (
                <Button key={n.id} variant="ghost" size="icon-xs" title={n.label} aria-label={n.label} aria-current={n.id === view ? "page" : undefined}
                  className={"tb-dot" + (n.id === view ? " on" : "")}
                  onClick={() => onSelect(n.id)} />
              ))}
            </span>
            <span className="grow"></span>
            {ov && <span className="meta">运行 {fmtDur(ov.uptime_sec)}</span>}
            <span className="meta">上次同步 {syncAt ? new Date(syncAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</span>
            <Button variant="outline" size="sm" className="panel-refresh" onClick={handleRefresh} disabled={refreshing} aria-busy={refreshing}>
              <ButtonLoadingContent loading={refreshing} loadingChildren="刷新中…">刷新</ButtonLoadingContent>
            </Button>
            <Button ref={toggle} variant="ghost" size="icon-sm" className="sidenav-toggle" title={expanded ? "收起导航" : "展开导航"}
              aria-label={expanded ? "收起导航" : "展开导航"}
              aria-expanded={expanded} aria-controls="panel-navigation" onClick={toggleNav}>
              {expanded ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </Button>
          </div>
          {workspace ? <h1 className="tb-title">{t.title}</h1> : <h2 className="tb-title">{t.title}</h2>}
          <div className="tb-sub">{t.sub}</div>
        </header>

        {msg && <div className={"msg " + msg.kind}>{msg.text}</div>}

        <div className="view-host">{children}</div>
      </main>
    </div>
  );
}
