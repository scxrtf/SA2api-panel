"use client";
// 配置视图（对齐 Go view-config）：分组（服务/定时任务/账号池与流量治理/上游与高级），
// 开关 + 描述 + 热生效保存。字段集对齐 Go CFG_MAP；Next 版部分字段为平铺命名。
import React, { useEffect, useState } from "react";
import { req } from "../lib";
import { Box, type Flash } from "../components/ui";

type Config = Record<string, string | number | boolean | number[]>;

interface Field {
  key: string; label: string;
  type: "number" | "text" | "password" | "bool" | "select" | "hours";
  options?: string[];
  hint?: string;
  /** 秒/ms 输入（存 ms 数字，界面按秒展示 ms 数字换算）*/
}

const SERVICE: Field[] = [
  { key: "api_key", label: "API 密钥", type: "password", hint: "留空 = 不鉴权（立即生效，含面板自身）" },
  { key: "package_detail_limit", label: "单账号明细默认展示条数", type: "number", hint: "积分构成页按最早到期展示，其余未用完包聚合" },
];

const SCHEDULE: Field[] = [
  { key: "schedule_checkin_hours", label: "签到时点（小时，逗号分隔）", type: "hours", hint: "" },
  { key: "schedule_checkin_disabled", label: "关闭自动签到", type: "bool", hint: "" },
  { key: "schedule_travel_hours", label: "旅行时点（小时，逗号分隔）", type: "hours", hint: "一趟派出 + 一趟领奖闭环" },
  { key: "schedule_travel_disabled", label: "关闭猫猫旅行", type: "bool", hint: "" },
  { key: "schedule_activity_hours", label: "上报时点（小时，逗号分隔）", type: "hours", hint: "点亮连登 + 解锁领养前置" },
  { key: "schedule_activity_disabled", label: "关闭活跃上报", type: "bool", hint: "" },
  { key: "schedule_keepalive_hours", label: "保活时点（小时，逗号分隔）", type: "hours", hint: "" },
  { key: "schedule_keepalive_disabled", label: "关闭 Token 保活", type: "bool", hint: "" },
  { key: "schedule_growth_hours", label: "成长任务执行时点（小时）", type: "hours", hint: "每日到点自动扫描 + 执行全部待办；建议零点后" },
  { key: "schedule_growth_disabled", label: "关闭成长任务自动执行", type: "bool", hint: "" },
  { key: "schedule_balance_refresh_enabled", label: "后台刷新余额", type: "bool", hint: "" },
  { key: "schedule_balance_refresh_minutes", label: "余额刷新间隔（分钟）", type: "number", hint: "" },
  { key: "schedule_include_disabled_in_tasks", label: "保号任务覆盖已禁用账号", type: "bool",
    hint: "禁用只关选号：打开后已禁用账号仍会签到/活跃上报/保活/刷新余额（依旧不参与选号）。若只想让单个账号临时退出选号但保留保号，用账号行的暂停选号按钮。" },
];

const POOL: Field[] = [
  { key: "max_in_flight", label: "单账号最大在途", type: "number", hint: "0 = 不限制" },
  { key: "max_in_flight_global", label: "国际版在途上限", type: "number", hint: "global 域风控更紧，默认 2（0=同上）" },
  { key: "breaker_threshold", label: "连续失败熔断阈值", type: "number", hint: "" },
  { key: "breaker_cooldown_ms", label: "熔断基础时长（秒）", type: "number", hint: "连败 N 次临时出池" },
  { key: "breaker_cooldown_max_ms", label: "熔断退避上限（秒）", type: "number", hint: "" },
  { key: "idle_weight_per_hour", label: "闲置补偿 / 小时", type: "number", hint: "" },
  { key: "idle_weight_max", label: "闲置补偿上限", type: "number", hint: "" },
  { key: "cost_explore_interval_ms", label: "成本探索窗口（秒，0=关停）", type: "number", hint: "免费层垄断时定期搭车探索未知号" },
  { key: "credit_floor", label: "积分保底", type: "number", hint: "余额低于此值不再接收费模型（0 关闭）" },
  { key: "expiring_soon_hours", label: "快过期路由窗口（小时，0=关）", type: "number", hint: "窗口内有快过期批次的账号选号权重提升" },
  { key: "prefer_expiring", label: "快过期积分优先", type: "bool", hint: "" },
  { key: "session_sticky", label: "会话粘性路由", type: "bool", hint: "同一会话尽量落在同一账号" },
];

const UPSTREAM: Field[] = [
  { key: "client_name", label: "用量归属名（空=默认）", type: "text", hint: "影响官网积分记录归属展示" },
  { key: "user_agent", label: "出站 User-Agent（空=默认）", type: "text", hint: "影响官网积分记录使用端显示" },
  { key: "device_token", label: "全局 X-Device-Token（空=按账号）", type: "text", hint: "" },
  { key: "prompt_mode", label: "系统提示词模式", type: "select", options: ["passthrough", "append", "custom"],
    hint: "passthrough=透传客户端 system；append=客户端 system 后插网关提示词；custom=网关自有提示词" },
  { key: "prompt_text", label: "提示词内容（custom 模式生效）", type: "text", hint: "" },
  { key: "header_timeout_ms", label: "聊天首字节超时（秒）", type: "number", hint: "上游响应头超时" },
  { key: "stream_idle_ms", label: "流空闲超时（秒，0=关）", type: "number", hint: "流空闲看门狗" },
  { key: "refresh_skew_sec", label: "token 提前刷新窗口（秒）", type: "number", hint: "" },
  { key: "soft_cooldown_ms", label: "软限流冷却基数（秒）", type: "number", hint: "" },
  { key: "soft_rate_max_ms", label: "软冷却退避上限（秒）", type: "number", hint: "" },
  { key: "passthrough_ip", label: "客户端 IP 透传", type: "bool", hint: "关闭时上游看到的是服务器 IP" },
];

const MS_FIELDS = new Set([
  "breaker_cooldown_ms", "breaker_cooldown_max_ms", "cost_explore_interval_ms",
  "header_timeout_ms", "stream_idle_ms", "soft_cooldown_ms", "soft_rate_max_ms",
]);

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
      flash("ok", "配置已保存并立即生效（调度时点已重排）");
    } catch (e) {
      flash("err", "保存失败：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  const renderField = (f: Field) => {
    const raw = cfg[f.key];
    return (
      <div key={f.key} className="cfg-fld">
        <label className="form-label">{f.label}</label>
        {f.type === "bool" ? (
          <span className={"switch" + (raw === true ? " on" : "")}
            onClick={() => set(f.key, !(raw === true))}
            role="switch" aria-checked={raw === true} tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set(f.key, !(raw === true)); } }}>
            <i></i>
          </span>
        ) : f.type === "select" ? (
          <select className="select" value={String(raw ?? "")}
            onChange={(e) => set(f.key, e.target.value)}>
            {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        ) : f.type === "hours" ? (
          <input className="input" value={Array.isArray(raw) ? (raw as number[]).join(",") : ""}
            placeholder="如 9,21（0-23 整点）"
            onChange={(e) => {
              const arr = e.target.value.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n));
              set(f.key, arr);
            }} />
        ) : f.type === "password" ? (
          <input className="input" type="password" value={String(raw ?? "")} placeholder="留空 = 不鉴权"
            onChange={(e) => set(f.key, e.target.value)} />
        ) : (
          <input className="input" type={f.type === "number" ? "number" : "text"}
            value={String(MS_FIELDS.has(f.key) ? Number(raw ?? 0) / 1000 : (raw ?? ""))}
            onChange={(e) => set(f.key, MS_FIELDS.has(f.key)
              ? Math.max(0, Number(e.target.value) * 1000)
              : f.type === "number" ? Number(e.target.value) : e.target.value)} />
        )}
        {f.hint && <div className="form-hint">{f.hint}</div>}
      </div>
    );
  };

  return (
    <>
      <Box title="服务" pad>
        <div className="form-grid">{SERVICE.map(renderField)}</div>
      </Box>
      <Box title="定时任务" hint="时点为 Asia/Shanghai 整点小时（0-23）" pad>
        <div className="form-grid">{SCHEDULE.map(renderField)}</div>
      </Box>
      <Box title="账号池与流量治理" pad>
        <div className="form-grid">{POOL.map(renderField)}</div>
      </Box>
      <Box title="上游与高级" pad>
        <div className="form-grid">{UPSTREAM.map(renderField)}</div>
      </Box>
      <div className="savebar">
        <span className="grow"></span>
        <button className="btn" onClick={() => req<{ config: Config }>("config").then((r) => setCfg(r.config)).catch(() => null)}>放弃修改</button>
        <button className="btn primary" onClick={save}>保存配置</button>
      </div>
    </>
  );
}
