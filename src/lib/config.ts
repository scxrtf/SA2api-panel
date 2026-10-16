// 面板配置：持久化在 Setting 表（key="config"），环境变量 WB2A_API_KEY 可覆盖主密钥。
// 等价 Go 的 cmd/server Config：读入合并默认值，面板保存即热生效（5s 内存缓存）。

export interface AppConfig {
  api_key: string; // 主密钥（空 = 不启用鉴权）
  max_rotate: number; // 单请求最大轮换次数
  refresh_skew_sec: number; // token 提前刷新窗口（秒）
  soft_cooldown_ms: number; // 软限流冷却基数
  soft_rate_max_ms: number; // 软限流冷却封顶（默认 2h）
  hard_cooldown_ms: number; // 硬冷却（未用次日 04:00 语义的兜底）
  breaker_threshold: number; // 熔断连败阈值
  breaker_cooldown_ms: number;
  breaker_cooldown_max_ms: number;
  max_in_flight: number; // 单账号最大在途（0=不限）
  max_in_flight_global: number; // global 域账号在途上限（0=用 max_in_flight）
  idle_weight_per_hour: number; // 闲置补偿权重（每小时）
  idle_weight_max: number; // 闲置补偿上限
  prefer_expiring: boolean; // 快过期积分优先
  credit_floor: number; // 积分保底（余额低于此值不接收费模型）
  cost_explore_interval_ms: number; // 成本探索窗口（0=关）
  session_sticky: boolean; // 会话粘性开关
  passthrough_ip: boolean; // 客户端 IP 透传
  client_name: string; // 用量归属名（默认 WorkBuddy；SaaS 还原旧行为）
  client_version: string; // 出站客户端版本段（空=内置默认 5.5.4）
  cli_version: string; // 出站 CLI 版本段（空=内置默认 2.137.1）
  user_agent: string; // 显式 UA 覆盖（空=官方桌面端默认形态）
  device_token: string; // 全局 X-Device-Token（空=按账号）
  prompt_mode: string; // passthrough | custom | append
  prompt_text: string;
  header_timeout_ms: number; // 上游响应头超时
  stream_idle_ms: number; // 流空闲看门狗（0=关）
  // ─── schedule（对齐 Go config.schedule，扁平化进顶层）────────────────────
  // 时点均为 Asia/Shanghai 本地整点小时（0-23）。
  schedule_checkin_hours: number[]; // 默认 [9,21]
  schedule_travel_hours: number[]; // 默认 [9,21]
  schedule_activity_hours: number[]; // 默认 [10]
  schedule_keepalive_hours: number[]; // 默认 [22]
  schedule_blackcat_hours: number[]; // 默认 [23]（夜猫子 23:00–08:00 计数窗口）
  schedule_growth_hours: number[]; // 默认 [1]（成长队列每日零点解锁后 01:00 扫执行）
  // 开关用「禁用」命名：零值（false）即启用，对齐 Go 的 *_enabled 缺省 true。
  schedule_checkin_disabled: boolean;
  schedule_travel_disabled: boolean;
  schedule_activity_disabled: boolean;
  schedule_keepalive_disabled: boolean;
  schedule_blackcat_disabled: boolean;
  schedule_growth_disabled: boolean;
  // 保号类四任务（签到/活跃/保活/余额）对已禁用账号也执行（禁用只关选号，不停保号）。
  schedule_include_disabled_in_tasks: boolean;
  // 余额刷新：false=关停循环；分钟 <=0 回落 5。
  schedule_balance_refresh_enabled: boolean;
  schedule_balance_refresh_minutes: number;
  // 快过期积分窗口（小时）：签到/余额刷新时把到期 ≤ now+window 的批次标记为快过期。
  // <=0 = 禁用路由门槛（展示仍用完整逐包数据）。
  expiring_soon_hours: number;
  // 积分构成页每账号展开的明细包数量（0=全部展开），对齐 Go package_detail_limit。
  package_detail_limit: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  api_key: "",
  max_rotate: 8,
  refresh_skew_sec: 300,
  soft_cooldown_ms: 60_000,
  soft_rate_max_ms: 2 * 3600_000,
  hard_cooldown_ms: 3600_000,
  breaker_threshold: 3,
  breaker_cooldown_ms: 30_000,
  breaker_cooldown_max_ms: 10 * 60_000,
  max_in_flight: 2,
  max_in_flight_global: 0,
  idle_weight_per_hour: 0.1,
  idle_weight_max: 0.5,
  prefer_expiring: true,
  credit_floor: 0,
  cost_explore_interval_ms: 0,
  session_sticky: true,
  passthrough_ip: false,
  client_name: "",
  client_version: "",
  cli_version: "",
  user_agent: "",
  device_token: "",
  prompt_mode: "passthrough",
  prompt_text: "",
  header_timeout_ms: 600_000,
  stream_idle_ms: 120_000,
  schedule_checkin_hours: [9, 21],
  schedule_travel_hours: [9, 21],
  schedule_activity_hours: [10],
  schedule_keepalive_hours: [22],
  schedule_blackcat_hours: [23],
  schedule_growth_hours: [1],
  schedule_checkin_disabled: false,
  schedule_travel_disabled: false,
  schedule_activity_disabled: false,
  schedule_keepalive_disabled: false,
  schedule_blackcat_disabled: false,
  schedule_growth_disabled: false,
  schedule_include_disabled_in_tasks: false,
  schedule_balance_refresh_enabled: true,
  schedule_balance_refresh_minutes: 5,
  expiring_soon_hours: 168, // 默认 7 天：官方活动奖励积分多在两周内过期
  package_detail_limit: 5,
};

import { prisma } from "./db";

let cache: { cfg: AppConfig; at: number } | null = null;
const CACHE_TTL_MS = 5_000;

export async function getConfig(force = false): Promise<AppConfig> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.cfg;
  }
  let stored: Partial<AppConfig> = {};
  try {
    const row = await prisma.setting.findUnique({ where: { key: "config" } });
    if (row?.value) stored = JSON.parse(row.value) as Partial<AppConfig>;
  } catch {
    // DB 未就绪/表未建：回落默认值（部署迁移前的引导窗口）。
  }
  const cfg: AppConfig = { ...DEFAULT_CONFIG, ...stored };
  // 环境变量覆盖主密钥（Railway 部署首选方式；面板里的密钥仍走 Setting）。
  if (process.env.WB2A_API_KEY) cfg.api_key = process.env.WB2A_API_KEY;
  cache = { cfg, at: Date.now() };
  return cfg;
}

// saveConfig 校验并落盘；返回生效配置。未知字段丢弃，数值字段做下限钳制。
export async function saveConfig(raw: unknown): Promise<AppConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("配置必须是 JSON 对象");
  }
  const src = raw as Record<string, unknown>;
  const next: AppConfig = { ...(await getConfig(true)) };
  for (const k of Object.keys(DEFAULT_CONFIG) as (keyof AppConfig)[]) {
    if (!(k in src)) continue;
    const v = src[k];
    const def = DEFAULT_CONFIG[k];
    if (Array.isArray(def)) {
      // 整点小时数组：必须全为 0-23 整数（对齐 validateScheduleHours fail-fast）。
      if (!Array.isArray(v) || v.some((h) => typeof h !== "number" || !Number.isInteger(h) || h < 0 || h > 23)) {
        throw new Error(`字段 ${k} 必须是 0-23 的整数小时数组；如要关闭该任务请设对应的 *_disabled=true`);
      }
      (next as unknown as Record<string, unknown>)[k] = v.slice();
    } else if (typeof def === "number") {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`字段 ${k} 必须是非负数字`);
      }
      (next as unknown as Record<string, unknown>)[k] = v;
    } else if (typeof def === "boolean") {
      if (typeof v !== "boolean") throw new Error(`字段 ${k} 必须是布尔值`);
      (next as unknown as Record<string, unknown>)[k] = v;
    } else {
      if (typeof v !== "string") throw new Error(`字段 ${k} 必须是字符串`);
      (next as unknown as Record<string, unknown>)[k] = v;
    }
  }
  if (next.max_rotate < 1) throw new Error("max_rotate 至少为 1");
  // 空 hours 回落默认（对齐 Go normalize：len==0 时用缺省时点）。
  for (const k of [
    "schedule_checkin_hours", "schedule_travel_hours", "schedule_activity_hours",
    "schedule_keepalive_hours", "schedule_blackcat_hours", "schedule_growth_hours",
  ] as const) {
    if (next[k].length === 0) (next as unknown as Record<string, unknown>)[k] = [...DEFAULT_CONFIG[k]];
  }
  if (next.schedule_balance_refresh_enabled && next.schedule_balance_refresh_minutes <= 0) {
    next.schedule_balance_refresh_minutes = 5;
  }
  await prisma.setting.upsert({
    where: { key: "config" },
    create: { key: "config", value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  cache = { cfg: next, at: Date.now() };
  return next;
}
