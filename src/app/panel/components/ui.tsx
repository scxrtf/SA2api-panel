"use client";
// 面板共享 UI 组件与类型（P3 拆分自原单文件 page.tsx）。
import React from "react";

export interface StatusRow {
  uid: string; nickname: string; realm: string; enterprise: boolean;
  credits: number; credits_total: number; credits_expiring: number;
  credits_earliest_expiry: number; credits_earliest_remaining: number;
  cooling: boolean; cool_kind: string; cool_remaining_sec: number; reason: string;
  disabled: boolean; disabled_reason: string; paused: boolean; checkin_done: boolean;
  soft_streak: number; in_flight: number; breaker_fails: number;
  breaker_until: number; degrade_until: number;
  rate_limited_models: { model: string; kind: string; until: number; reason: string }[];
  model_costs: { model: string; cost_per_1k: number; last_seen: number }[];
}
export interface Overview {
  version: string; uptime_sec: number; auth_required: boolean;
  total: number; healthy: number; cooling: number; disabled: number; paused: number;
  sticky_sessions: number; accounts: StatusRow[];
  gateway: { enabled: boolean; providers: number; keys: number };
}
export type Flash = (k: "ok" | "err", t: string) => void;

// Box 容器（对齐 Go .box）。
export function Box({ title, hint, extra, children, pad }: {
  title: React.ReactNode; hint?: string; extra?: React.ReactNode;
  children: React.ReactNode; pad?: boolean;
}) {
  return (
    <div className="box">
      <header>
        <h3>{title}{hint && <span className="hint">{hint}</span>}</h3>
        <span className="grow"></span>
        {extra}
      </header>
      {pad ? <div className="pad">{children}</div> : children}
    </div>
  );
}
