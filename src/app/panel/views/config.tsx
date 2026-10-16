"use client";
// 配置视图（对齐 Go view-config）：运行配置编辑，保存即热生效（含调度时点）。
import React, { useEffect, useState } from "react";
import { req } from "../lib";
import { Box, type Flash } from "../components/ui";

type Config = Record<string, string | number | boolean | number[]>;

interface Field { key: string; label: string; type: "number" | "text" | "bool" | "select" | "hours"; options?: string[] }

const FIELDS: Field[] = [
  { key: "api_key", label: "主密钥（留空=不鉴权，慎用）", type: "text" },
  { key: "max_rotate", label: "单请求最大轮换次数", type: "number" },
  { key: "refresh_skew_sec", label: "token 提前刷新窗口（秒）", type: "number" },
  { key: "soft_cooldown_ms", label: "软限流冷却基数（ms）", type: "number" },
  { key: "soft_rate_max_ms", label: "软限流冷却封顶（ms）", type: "number" },
  { key: "breaker_threshold", label: "熔断连败阈值", type: "number" },
  { key: "breaker_cooldown_ms", label: "熔断冷却基数（ms）", type: "number" },
  { key: "breaker_cooldown_max_ms", label: "熔断冷却封顶（ms）", type: "number" },
  { key: "max_in_flight", label: "单账号最大在途（0=不限）", type: "number" },
  { key: "max_in_flight_global", label: "global 域在途上限（0=同上）", type: "number" },
  { key: "idle_weight_per_hour", label: "闲置补偿权重/小时", type: "number" },
  { key: "idle_weight_max", label: "闲置补偿上限", type: "number" },
  { key: "prefer_expiring", label: "快过期积分优先", type: "bool" },
  { key: "credit_floor", label: "积分保底（收费模型门槛）", type: "number" },
  { key: "session_sticky", label: "会话粘性", type: "bool" },
  { key: "passthrough_ip", label: "客户端 IP 透传", type: "bool" },
  { key: "client_name", label: "用量归属名", type: "text" },
  { key: "client_version", label: "客户端版本段", type: "text" },
  { key: "cli_version", label: "CLI 版本段", type: "text" },
  { key: "user_agent", label: "UA 覆盖", type: "text" },
  { key: "device_token", label: "全局 X-Device-Token", type: "text" },
  { key: "prompt_mode", label: "提示词模式", type: "select", options: ["passthrough", "custom", "append"] },
  { key: "prompt_text", label: "提示词内容", type: "text" },
  { key: "header_timeout_ms", label: "上游响应头超时（ms）", type: "number" },
  { key: "stream_idle_ms", label: "流空闲看门狗（ms，0=关）", type: "number" },
];

// 调度排程（对齐 Go schedule.*）：整点小时数组 + 开关 + 余额刷新 + 快过期窗口。
const SCHED_FIELDS: Field[] = [
  { key: "schedule_checkin_hours", label: "签到时点（小时，逗号分隔）", type: "hours" },
  { key: "schedule_travel_hours", label: "旅行巡检时点", type: "hours" },
  { key: "schedule_activity_hours", label: "活跃上报时点", type: "hours" },
  { key: "schedule_keepalive_hours", label: "token 保活时点", type: "hours" },
  { key: "schedule_blackcat_hours", label: "夜猫子时点", type: "hours" },
  { key: "schedule_growth_hours", label: "成长任务队列时点", type: "hours" },
  { key: "schedule_checkin_disabled", label: "关闭签到排程", type: "bool" },
  { key: "schedule_travel_disabled", label: "关闭旅行巡检", type: "bool" },
  { key: "schedule_activity_disabled", label: "关闭活跃上报", type: "bool" },
  { key: "schedule_keepalive_disabled", label: "关闭 token 保活", type: "bool" },
  { key: "schedule_blackcat_disabled", label: "关闭夜猫子", type: "bool" },
  { key: "schedule_growth_disabled", label: "关闭成长任务队列", type: "bool" },
  { key: "schedule_include_disabled_in_tasks", label: "保号任务覆盖已禁用账号", type: "bool" },
  { key: "schedule_balance_refresh_enabled", label: "启用余额自动刷新", type: "bool" },
  { key: "schedule_balance_refresh_minutes", label: "余额刷新间隔（分钟）", type: "number" },
  { key: "expiring_soon_hours", label: "快过期积分窗口（小时，0=关）", type: "number" },
];

export function ConfigView({ flash }: { flash: Flash }) {
  const [cfg, setCfg] = useState<Config | null>(null);

  useEffect(() => {
    req<{ config: Config }>("config")
      .then((r) => setCfg(r.config))
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [flash]);

  if (!cfg) return <Box title="运行配置" pad><div className="dim">加载配置…</div></Box>;

  const set = (k: string, v: string | number | boolean | number[]) => setCfg({ ...cfg, [k]: v });

  const save = async () => {
    try {
      await req("config", { method: "POST", body: cfg });
      flash("ok", "配置已保存并热生效");
    } catch (e) {
      flash("err", "保存失败：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  const renderField = (f: Field) => (
    <div key={f.key} className="form-row">
      <label className="form-label">{f.label}</label>
      {f.type === "bool" ? (
        <select className="select" value={String(cfg[f.key])}
          onChange={(e) => set(f.key, e.target.value === "true")}>
          <option value="true">开</option><option value="false">关</option>
        </select>
      ) : f.type === "select" ? (
        <select className="select" value={String(cfg[f.key] ?? "")}
          onChange={(e) => set(f.key, e.target.value)}>
          {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : f.type === "hours" ? (
        <input className="input" value={Array.isArray(cfg[f.key]) ? (cfg[f.key] as number[]).join(",") : ""}
          placeholder="如 9,21（0-23 整点）"
          onChange={(e) => {
            const arr = e.target.value.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
            set(f.key, arr);
          }} />
      ) : (
        <input className="input" type={f.type === "number" ? "number" : "text"}
          value={String(cfg[f.key] ?? "")}
          onChange={(e) => set(f.key, f.type === "number" ? Number(e.target.value) : e.target.value)} />
      )}
    </div>
  );

  return (
    <>
      <Box title="运行配置" hint="保存即热生效（无需重启）" pad>
        <div className="form-grid">{FIELDS.map(renderField)}</div>
      </Box>
      <Box title="调度排程" hint="时点为 Asia/Shanghai 整点小时；改动保存后立即重排" pad>
        <div className="form-grid">{SCHED_FIELDS.map(renderField)}</div>
        <button className="btn primary" onClick={save}>保存配置</button>
      </Box>
    </>
  );
}
