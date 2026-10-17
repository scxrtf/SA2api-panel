// 面板前端公共工具：API key 存取、统一请求封装。
"use client";

const KEY = "wb2a_panel_key";

export function getKey(): string {
  try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; }
}
export function setKey(k: string) {
  try { localStorage.setItem(KEY, k); } catch { /* 忽略 */ }
}

export interface ApiResp<T> {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
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
  try { j = (await r.json()) as ApiResp<T>; } catch { j = { ok: false, error: "HTTP " + r.status } as ApiResp<T>; }
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
import { useEffect } from "react";
export function useAutoRefresh(loader: () => void, ms: number, enabled = true): void {
  useEffect(() => {
    if (!enabled || ms <= 0) return;
    const tick = () => { if (document.visibilityState === "visible") loader(); };
    const t = setInterval(tick, ms);
    return () => clearInterval(t);
  }, [loader, ms, enabled]);
}
