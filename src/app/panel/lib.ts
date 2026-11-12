// 面板前端公共工具：统一请求封装。
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

// req 统一打面板 API。
export async function req<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T & ApiResp<T>> {
  const r = await fetch("/api/panel/" + path, {
    method: opts.method ?? "GET",
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  let j: ApiResp<T>;
  try { j = (await r.json()) as ApiResp<T>; } catch { j = { ok: false, error: "HTTP " + r.status }; }
  if (!j.ok) throw new Error(j.error ?? "HTTP " + r.status);
  return j as T & ApiResp<T>;
}

// ==================== 1 小时前端数据缓存 ====================
// 积分构成 / 余额趋势 / CloudBase 监控 / 模型与档位 / 模型鉴别 这五个视图的数据
// 变化频率低，实时轮询只会白白消耗出口流量。统一在这里加一层内存缓存：
//   · 默认 TTL 1 小时，到期前重复调用直接命中缓存，不发请求；
//   · 手动「刷新」按钮 / 顶栏刷新通过 force=true 绕过前端缓存，并给 URL 追加
//     refresh=1 同步绕过服务端 panel-cache，立即拉新数据；
//   · 缓存按 path 区分，写入操作（POST/DELETE）不经过这里；
//   · 进程内内存缓存，刷新页面即清空，不会读到跨会话的陈旧数据。
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小时
const dataCache = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

export async function reqCached<T = Record<string, unknown>>(
  path: string,
  opts: { force?: boolean; ttlMs?: number } = {},
): Promise<T & ApiResp<T>> {
  const ttl = opts.ttlMs ?? CACHE_TTL_MS;
  const hit = dataCache.get(path);
  if (!opts.force && hit && Date.now() - hit.at < ttl) {
    return hit.data as T & ApiResp<T>;
  }
  // 去重并发：同一 path 在途的重复请求复用同一个 Promise。
  const pending = inflight.get(path);
  if (!opts.force && pending) return pending as Promise<T & ApiResp<T>>;
  const fetchPath = opts.force ? path + (path.includes("?") ? "&" : "?") + "refresh=1" : path;
  const p = req<T>(fetchPath)
    .then((data) => { dataCache.set(path, { at: Date.now(), data }); return data; })
    .finally(() => { inflight.delete(path); });
  inflight.set(path, p);
  return p;
}

// 外部写入（新增/删除基准等）后调用，让相关缓存立即失效。
export function invalidateCache(pathPrefix?: string): void {
  if (!pathPrefix) { dataCache.clear(); return; }
  for (const k of dataCache.keys()) if (k.startsWith(pathPrefix)) dataCache.delete(k);
}

// fmt*：数字/时间展示工具。
export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  return n.toLocaleString("en-US");
}
export const PANEL_TIME_ZONE = "Asia/Shanghai";
const PANEL_TIME_OPTIONS = { timeZone: PANEL_TIME_ZONE, hour12: false } as const;

// 面板时间统一锚定北京时间，不受浏览器、容器或宿主机本地时区影响。
export function fmtDateTime(value: number | string | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return "-";
  return date.toLocaleString("zh-CN", PANEL_TIME_OPTIONS);
}
export function fmtClock(value: number | string | Date | null | undefined): string {
  if (value === null || value === undefined || value === "") return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return "-";
  return date.toLocaleTimeString("zh-CN", PANEL_TIME_OPTIONS);
}
export function fmtTime(ms: number | null | undefined): string {
  return fmtDateTime(ms);
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
