// 面板前端公共工具：API key 存取、统一请求封装。
"use client";

const KEY = "wb2a_panel_key";

export function getKey(): string {
  try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; }
}
export function setKey(k: string) {
  try { localStorage.setItem(KEY, k); } catch { /* 忽略 */ }
}

export interface ApiResp<T = unknown> {
  // 泛型标记用于 req<T> 的返回类型组合。
  ok: boolean;
  error?: string;
  [k: string]: unknown;
  readonly __type?: T;
}

// req 统一打面板 API；401 时抛出特殊错误由调用方跳回登录态。
export async function req<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T & ApiResp<T>> {
  const r = await fetch("/api/panel/" + path, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: "Bearer " + getKey(),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  let j: ApiResp<T>;
  try { j = (await r.json()) as ApiResp<T>; } catch { j = { ok: false, error: "HTTP " + r.status }; }
  if (r.status === 401) throw new Error("__AUTH__");
  if (!j.ok) throw new Error(j.error ?? "HTTP " + r.status);
  return j as T & ApiResp<T>;
}

// fmt*：数字/时间展示工具。
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return n.toLocaleString("en-US");
}
export function fmtTime(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return "-";
  return new Date(ms).toLocaleString("zh-CN", { hour12: false });
}
export function fmtDur(sec: number): string {
  if (sec <= 0) return "0s";
  if (sec < 60) return sec + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m";
  if (sec < 86400) return Math.floor(sec / 3600) + "h" + Math.floor((sec % 3600) / 60) + "m";
  return Math.floor(sec / 86400) + "d" + Math.floor((sec % 86400) / 3600) + "h";
}

// useAutoRefresh：到点重跑一次 loader，页面不可见时暂停。
// 用于面板视图轮询（对齐 Go app.js 的 setInterval 刷新约定）。
import React, { createContext, useContext, useEffect, type ReactNode } from "react";

// 每个保持挂载的 ViewPane 提供自己的可见状态；隐藏视图不轮询、不响应全局刷新。
export const PanelActivityContext = createContext(true);
export function PanelActivityProvider({ active, children }: { active: boolean; children: ReactNode }) {
  return React.createElement(PanelActivityContext.Provider, { value: active }, children);
}
export function useAutoRefresh(loader: () => void, ms: number, enabled = true): void {
  const active = useContext(PanelActivityContext);
  useEffect(() => {
    // ms <= 0 表示调用方明确关停，必须保留这个语义；其余一律夹到最低 60s，
    // 避免游离的短间隔轮询把 Supabase 免费档的 egress 打满。
    if (!enabled || !active || ms <= 0) return;
    const interval = Math.max(ms, 60_000);
    const tick = () => { if (document.visibilityState === "visible") loader(); };
    const t = setInterval(tick, interval);
    return () => clearInterval(t);
  }, [loader, ms, enabled, active]);
}

// PANEL_REFRESH_EVENT：顶栏「刷新」按钮广播的事件名。顶栏只刷 overview，
// 各视图的数据在自己组件里，靠这个事件让当前视图也跑自己的 load——
// 否则在用量/日志等 tab 点顶栏刷新只更新了侧边栏统计，主区纹丝不动。
export const PANEL_REFRESH_EVENT = "wb2a:panel-refresh";

export function emitPanelRefresh(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(PANEL_REFRESH_EVENT));
}

// usePanelRefresh：视图订阅顶栏刷新事件，触发自己的 loader。
export function usePanelRefresh(loader: () => void): void {
  const active = useContext(PanelActivityContext);
  useEffect(() => {
    if (!active) return;
    const h = () => loader();
    window.addEventListener(PANEL_REFRESH_EVENT, h);
    return () => window.removeEventListener(PANEL_REFRESH_EVENT, h);
  }, [loader, active]);
}
