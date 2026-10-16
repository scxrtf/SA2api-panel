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
    if (typeof def === "number") {
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
  await prisma.setting.upsert({
    where: { key: "config" },
    create: { key: "config", value: JSON.stringify(next) },
    update: { value: JSON.stringify(next) },
  });
  cache = { cfg: next, at: Date.now() };
  return next;
}
