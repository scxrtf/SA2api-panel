// growth 域任务/旅行/Buddy/连击接口（移植 internal/upstream/tasks.go + travel.go）。
// 端点走 chatBase（不带 /v2 前缀）+ billingHeaders；信封 {code,msg,data}，code!=0 为业务错误。
// 签名对齐 client.ts：(cfg, a) 参数序，snake_case 配置。
import type { AppConfig } from "../config";
import {
  chatBase, billingHeaders, originReferer, isGlobal,
  type AuthShape,
} from "./client";

const GROWTH_TIMEOUT_MS = 30_000;

// doGrowthJSON：growth 域请求 + 解信封（独立实现，不复用 client 的私有 doJSON）。
async function doGrowthJSON(
  url: string,
  headers: Record<string, string>,
  method: string,
  body: unknown | null,
): Promise<unknown> {
  const resp = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(GROWTH_TIMEOUT_MS),
    cache: "no-store",
  });
  const raw = await resp.text();
  if (resp.status >= 400) {
    const err = new Error("http " + resp.status + ": " + raw.slice(0, 200)) as Error & { status?: number };
    err.status = resp.status;
    throw err;
  }
  let env: { code?: number; msg?: string; data?: unknown };
  try { env = JSON.parse(raw) as typeof env; }
  catch { throw new Error("parse failed: " + raw.slice(0, 120)); }
  if (env.code != null && env.code !== 0) {
    throw new Error("code=" + env.code + " msg=" + (env.msg ?? ""));
  }
  return env.data;
}

function growthJSON(cfg: AppConfig, a: AuthShape, method: string, path: string, body: unknown | null) {
  return doGrowthJSON(chatBase(a) + path, billingHeaders(cfg, a), method, body);
}

// mp 口径：小程序限定任务的 list/accept/claim 全链路要求 X-Client-Platform: miniprogram。
function growthJSONMP(cfg: AppConfig, a: AuthShape, method: string, path: string, body: unknown | null) {
  const h = billingHeaders(cfg, a);
  h["X-Client-Platform"] = "miniprogram";
  return doGrowthJSON(chatBase(a) + path, h, method, body);
}

// ─── 任务列表 / 接受 / 领奖 ────────────────────────────────────────────────

export interface GrowthTask {
  task_code: string;
  title?: string; description?: string; task_desc?: string;
  credit?: number; energy?: number;
  has_reward?: boolean; reward_buddy?: boolean;
  task_type?: string; tag?: string; jump_url?: string;
  locked?: boolean;
  target: number; current: number;
  accept_status?: string; status?: string;
  claimable?: boolean; claimed?: boolean;
}

interface RawTask {
  task_code: string; title?: string; description?: string; task_desc?: string;
  reward_credit?: number; reward_energy?: number; has_reward?: boolean;
  reward_buddy?: boolean; task_type?: string; tag?: string; jump_url?: string;
  locked?: boolean; accept_status?: string; status?: string;
  target?: number; current?: number; progress?: unknown;
}

// parseGrowthTasks 宽松解析：progress 可能是 {current,target} 对象或平铺字段。
function parseGrowthTasks(data: unknown): GrowthTask[] {
  const tasks = ((data as { tasks?: RawTask[] } | null)?.tasks ?? []) as RawTask[];
  return tasks.map((t) => {
    let cur = t.current ?? 0;
    let tgt = t.target ?? 0;
    const pr = t.progress as { current?: number; target?: number } | null | undefined;
    if (pr && ((pr.target ?? 0) > 0 || (pr.current ?? 0) > 0)) {
      cur = pr.current ?? 0;
      tgt = pr.target ?? 0;
    }
    const claimed = t.accept_status === "claimed";
    return {
      task_code: t.task_code,
      title: t.title, description: t.description, task_desc: t.task_desc,
      credit: t.reward_credit, energy: t.reward_energy,
      has_reward: t.has_reward, reward_buddy: t.reward_buddy,
      task_type: t.task_type, tag: t.tag, jump_url: t.jump_url,
      locked: t.locked,
      target: tgt, current: cur,
      accept_status: t.accept_status, status: t.status,
      claimable: !claimed && tgt > 0 && cur >= tgt,
      claimed,
    };
  });
}

export async function listTasks(cfg: AppConfig, a: AuthShape): Promise<GrowthTask[]> {
  return parseGrowthTasks(await growthJSON(cfg, a, "GET", "/v2/activity/growth/tasks", null));
}

export async function listTasksMP(cfg: AppConfig, a: AuthShape): Promise<GrowthTask[]> {
  return parseGrowthTasks(await growthJSONMP(cfg, a, "GET", "/v2/activity/growth/tasks", null));
}

export async function acceptTasks(cfg: AppConfig, a: AuthShape, codes: string[]): Promise<void> {
  await growthJSON(cfg, a, "POST", "/v2/activity/growth/tasks/accept", { task_codes: codes });
}

export async function acceptTasksMP(cfg: AppConfig, a: AuthShape, codes: string[]): Promise<void> {
  await growthJSONMP(cfg, a, "POST", "/v2/activity/growth/tasks/accept", { task_codes: codes });
}

// claimReward：Web 域领奖（任务码在路径里，无 body，x-client-platform: web）。
// 端点来源：浏览器成长中心实测；CLI 域的 /v2/.../reward/claim 不存在（此前领奖失败根因）。
export async function claimReward(
  cfg: AppConfig, a: AuthShape, taskCode: string,
): Promise<{ credit: number; energy: number }> {
  const origin = originReferer(a);
  const h: Record<string, string> = {
    Authorization: "Bearer " + a.accessToken,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
    Origin: origin,
    Referer: origin + "/profile/growth-center",
    "x-client-platform": "web",
  };
  if (cfg.user_agent) h["User-Agent"] = cfg.user_agent;
  if (a.uid) h["X-User-Id"] = a.uid;
  if (a.enterpriseId) { h["X-Enterprise-Id"] = a.enterpriseId; h["X-Tenant-Id"] = a.enterpriseId; }
  if (a.domain) h["X-Domain"] = a.domain;
  const webB = isGlobal(a) ? "https://www.workbuddy.ai" : "https://www.workbuddy.cn";
  const data = (await doGrowthJSON(
    webB + "/activity/growth/tasks/" + encodeURIComponent(taskCode) + "/claim",
    h, "POST", null,
  )) as { already_claimed?: boolean; credit?: number; energy?: number } | null;
  if (data?.already_claimed) return { credit: 0, energy: 0 };
  return { credit: data?.credit ?? 0, energy: data?.energy ?? 0 };
}

// claimRewardMP：chat 域 mp 口径领奖；chat 域 400 时降级 Web 域（实测可领）。
export async function claimRewardMP(
  cfg: AppConfig, a: AuthShape, taskCode: string,
): Promise<{ credit: number; energy: number }> {
  const h = billingHeaders(cfg, a);
  h["X-Client-Platform"] = "miniprogram";
  try {
    const data = (await doGrowthJSON(
      chatBase(a) + "/activity/growth/tasks/" + encodeURIComponent(taskCode) + "/claim",
      h, "POST", null,
    )) as { already_claimed?: boolean; credit?: number; energy?: number } | null;
    if (data?.already_claimed) return { credit: 0, energy: 0 };
    return { credit: data?.credit ?? 0, energy: data?.energy ?? 0 };
  } catch (e) {
    if ((e as { status?: number }).status === 400) return claimReward(cfg, a, taskCode);
    throw e;
  }
}

// ─── 猫猫旅行 / Buddy / 连击 ────────────────────────────────────────────────

export interface TravelState {
  state: string; // idle | traveling | arrived
  daily_limit_reached?: boolean;
  record_id?: number;
  reward_credit?: number;
}

export async function travelStatus(cfg: AppConfig, a: AuthShape): Promise<TravelState> {
  return (await growthJSON(cfg, a, "GET", "/activity/growth/buddy/travel/status", null)) as TravelState;
}
export async function travelDepart(cfg: AppConfig, a: AuthShape): Promise<unknown> {
  return growthJSON(cfg, a, "POST", "/activity/growth/buddy/travel/depart", {});
}
export async function travelClaim(cfg: AppConfig, a: AuthShape, recordId: number): Promise<unknown> {
  return growthJSON(cfg, a, "POST", "/activity/growth/buddy/travel/claim", { record_id: recordId });
}
export async function buddyInfo(cfg: AppConfig, a: AuthShape): Promise<{ id: number; name: string } | null> {
  const d = (await growthJSON(cfg, a, "GET", "/activity/growth/buddy/info", null)) as
    { buddy?: { id: number; name: string } | null } | null;
  return d?.buddy ?? null;
}
export async function buddyFirst(cfg: AppConfig, a: AuthShape): Promise<unknown> {
  return growthJSON(cfg, a, "POST", "/activity/growth/buddy/first", {});
}
export async function buddyAgreement(cfg: AppConfig, a: AuthShape): Promise<unknown> {
  return growthJSON(cfg, a, "POST", "/activity/growth/buddy/agreement", {});
}
export async function streakReport(cfg: AppConfig, a: AuthShape): Promise<unknown> {
  return growthJSON(cfg, a, "POST", "/activity/growth/streak", {});
}

// ─── 开学季券码（school.go；活动期只读查询）───────────────────────────────────

export interface SchoolVoucher {
  grant_id: number;
  draw_uuid?: string;
  sku_code?: string;   // kfc_ice_cream / voucher_luckin / voucher_kugou …
  prize_name?: string; // 肯德基冰淇淋
  code: string;        // 券码本体（复制给店员核销）
  valid_from?: string;
  valid_to?: string;   // "2026-10-24"
  granted_at?: string; // RFC3339
}

// schoolVouchers 查询账号的开学季券码列表（billing 同域 /portal/activity/school/vouchers）。
export async function schoolVouchers(cfg: AppConfig, a: AuthShape): Promise<SchoolVoucher[]> {
  const { billingBase } = await import("./client");
  const data = (await doGrowthJSON(
    billingBase(a) + "/portal/activity/school/vouchers",
    billingHeaders(cfg, a), "GET", null,
  )) as { items?: SchoolVoucher[] } | null;
  return data?.items ?? [];
}
