// 账号池（移植 internal/pool/*）：选号、冷却/熔断/降权、粘性健康校验、余额台账。
//
// 与 Go 版的架构差异：Go 是全内存 + state.json 落盘 + 全局互斥锁；本实现是
// 无状态函数 + DB 为权威状态，lastUsed/usedSeq/inFlight 等运行态放模块级 Map
//（单实例语义：Railway 单容器部署下与 Go 等价；多副本时 inFlight 会分裂，
// 由部署约束保证单实例，同 Go 单机部署口径）。
//
// 每次 pick 把候选行读入内存后纯计算（权重/分层/抽签），写回只落持久字段。
import { prisma } from "./db";
import { modelLockViewPure, type ModelLockRow, type LockViewEntry } from "./modelview";
import type { AppConfig } from "./config";
import type { Account, AccountState, ModelCooldown, ModelCost } from "@prisma/client";
import {
  ErrKind,
  MODEL_BLOCK_REASON,
  isModelRateLimit,
  parseRateReset,
} from "./upstream/errors";

export interface PoolEntry {
  account: Account;
  state: AccountState;
  cooldowns: ModelCooldown[];
  costs: ModelCost[];
}

export type PickOpts = {
  tried?: Set<string>;
  model?: string;
  realm?: string; // 空 = 不过滤
};

// ─── 运行态（进程内，不持久化，语义同 Go 的运行态字段） ───────────────────

const MIN_PICK_GAP_MS = 100; // 防并发撞号窗口（Go minPickGap）
const inFlight = new Map<string, number>();
const lastUsedMap = new Map<string, number>();
const usedSeqMap = new Map<string, number>();
let pickSeq = 0;
// costTier 条件探索台账（issue #136）：键 realm + "\x1f" + model。
const exploreLast = new Map<string, number>();
let costExploreEvents = 0;

// modelCostTTL 成本观测有效期 6h（夜间免费这类时段性优惠不跨时段生效）。
export const MODEL_COST_TTL_MS = 6 * 3600_000;

// 11102 负缓存退避常量（Go modelBlock*）。
const MODEL_BLOCK_BASE_TTL_MS = 6 * 3600_000;
const MODEL_BLOCK_SHIFT_MAX = 4;
const MODEL_BLOCK_MAX_TTL_MS = 24 * 3600_000;

export const inFlightCount = (uid: string) => inFlight.get(uid) ?? 0;

function inFlightLimit(state: AccountState, account: Account, cfg: AppConfig): number {
  if (cfg.max_in_flight_global > 0 && account.realm === "global") {
    return cfg.max_in_flight_global;
  }
  return cfg.max_in_flight;
}

function inFlightFull(e: PoolEntry, cfg: AppConfig): boolean {
  const limit = inFlightLimit(e.state, e.account, cfg);
  if (limit <= 0) return false;
  return inFlightCount(e.account.uid) >= limit;
}

// Acquire 占一个在途名额（CAS 语义的单线程等价：检查+自增在事件循环内原子）。
export function acquire(e: PoolEntry, cfg: AppConfig): boolean {
  const limit = inFlightLimit(e.state, e.account, cfg);
  const cur = inFlightCount(e.account.uid);
  if (limit > 0 && cur >= limit) return false;
  inFlight.set(e.account.uid, cur + 1);
  return true;
}

// Release 释放一个在途名额（幂等减到 0 为止）。
export function release(uid: string): void {
  const cur = inFlight.get(uid) ?? 0;
  if (cur <= 1) inFlight.delete(uid);
  else inFlight.set(uid, cur - 1);
}

function markUsed(uid: string): void {
  lastUsedMap.set(uid, Date.now());
  usedSeqMap.set(uid, ++pickSeq);
}

// ─── 健康判定（与 Go entry.healthy / healthyForModel 同语义） ─────────────

function isHealthy(e: PoolEntry, now: number): boolean {
  const s = e.state;
  if (s.disabled || s.paused) return false;
  if (s.cooldownUntil > now) return false;
  if (s.breakerUntil > now) return false;
  if (s.degradeUntil > now) return false;
  return true;
}

// 模型级冷却中（6004 限流 / 11102 负缓存未到期）。
function modelCooled(e: PoolEntry, now: number, model: string): boolean {
  if (!model) return false;
  const mc = e.cooldowns.find((c) => c.model === model);
  if (!mc) return false;
  return Number(mc.until) > now;
}

function healthyForModel(e: PoolEntry, now: number, model: string): boolean {
  if (e.state.disabled || e.state.paused) return false;
  if (modelCooled(e, now, model)) return false;
  return isHealthy(e, now);
}

// 有效成本观测（TTL 内）；无观测/过期 → null（tier 1）。
function modelCostOf(e: PoolEntry, now: number, model: string): ModelCost | null {
  if (!model) return null;
  const mc = e.costs.find((c) => c.model === model);
  if (!mc) return null;
  if (Number(mc.observedAt) <= 0 || now - Number(mc.observedAt) > MODEL_COST_TTL_MS) return null;
  if (Number(mc.expiresAt) > 0 && Number(mc.expiresAt) <= now) return null;
  return mc;
}

// ─── 积分保底（floorBlockedForRealmModel 同语义） ─────────────────────────

export type ModelRateOf = (realm: string, model: string) => string;

function floorBlocked(
  e: PoolEntry,
  model: string,
  realm: string,
  cfg: AppConfig,
  now: number,
  modelRateOf?: ModelRateOf,
): boolean {
  if (cfg.credit_floor <= 0 || !model || Number(e.state.credits) >= cfg.credit_floor) {
    return false;
  }
  // 1) 本地实测台账：最权威（真实扣费证据）。
  const mc = modelCostOf(e, now, model);
  if (mc) return mc.costPer1k > 0;
  // 2) 上游目录倍率兜底：无观测时用牌价判收费；未知放行（有意的保守选择）。
  const rate = modelRateOf?.(realm, model) ?? "";
  if (!rate) return false;
  const v = Number.parseFloat(rate);
  if (Number.isNaN(v)) return false;
  return v > 0;
}

// ─── 权重与挑选（pick.go 同语义） ─────────────────────────────────────────

function weightOf(e: PoolEntry, maxCredits: number, cfg: AppConfig, now: number): number {
  let w = 1.0;
  const credits = Number(e.state.credits);
  if (maxCredits > 0) w += (credits / maxCredits) * 10;
  const lastUsed = lastUsedMap.get(e.account.uid) ?? 0;
  if (lastUsed <= 0) {
    w += cfg.idle_weight_max; // 从未使用 → 满分
  } else {
    const hours = (now - lastUsed) / 3600_000;
    let idleW = hours * cfg.idle_weight_per_hour;
    if (idleW > cfg.idle_weight_max) idleW = cfg.idle_weight_max;
    if (idleW < 0) idleW = 0; // 时钟回拨钳 0
    w += idleW;
  }
  return w;
}

const EXPIRING_VIRTUAL_SLOTS = 3; // Go expiringVirtualSlots

function routingWeightOf(e: PoolEntry, maxCredits: number, cfg: AppConfig, now: number): number {
  const w = weightOf(e, maxCredits, cfg, now);
  const s = e.state;
  const expiringNow =
    Number(s.expiring) > 0 &&
    Number(s.earliestRemain) > 0 &&
    Number(s.earliestAt) > now;
  if (cfg.prefer_expiring && expiringNow) return w * EXPIRING_VIRTUAL_SLOTS;
  return w;
}

// pickWeighted 加权随机（定点抽签的浮点等价）。
function pickWeighted(ws: { e: PoolEntry; w: number }[]): PoolEntry {
  let total = 0;
  for (const c of ws) total += c.w;
  if (total <= 0) return ws[Math.floor(Math.random() * ws.length)].e;
  let r = Math.random() * total;
  for (const c of ws) {
    r -= c.w;
    if (r < 0) return c.e;
  }
  return ws[ws.length - 1].e;
}

async function loadEntries(): Promise<PoolEntry[]> {
  const accounts = await prisma.account.findMany({
    include: { state: true, modelCooldowns: true, modelCosts: true },
  });
  const out: PoolEntry[] = [];
  for (const account of accounts) {
    out.push({
      account,
      state: account.state ?? defaultState(account.uid),
      cooldowns: account.modelCooldowns,
      costs: account.modelCosts,
    });
  }
  return out;
}

function defaultState(uid: string): AccountState {
  return {
    uid,
    credits: 0n,
    total: 0n,
    expiring: 0n,
    earliestAt: 0n,
    earliestRemain: 0n,
    paused: false,
    disabled: false,
    disableReason: "",
    disabledAt: 0n,
    sessionDead: false,
    sessionStrikes: 0,
    cooldownUntil: 0n,
    cooldownReason: "",
    breakerFails: 0,
    breakerUntil: 0n,
    lastUsed: 0n,
    usedSeq: 0n,
    lastCheckinDay: "",
    balanceAt: 0n,
    softStreak: 0,
    degradeUntil: 0n,
    updatedAt: new Date(0),
  } as AccountState;
}

// pick 在 healthy 候选集中按权重选出账号（Go pick 全语义：成本分层硬过滤 +
// 条件探索 + top5 截断 + 加权随机 + minPickGap 防撞号 + LRU 兜底 + 全冷却兜底）。
export async function pick(
  cfg: AppConfig,
  opts: PickOpts = {},
  modelRateOf?: ModelRateOf,
): Promise<PoolEntry | null> {
  const now = Date.now();
  const { tried, model = "", realm = "" } = opts;
  const all = await loadEntries();
  const skipped = (e: PoolEntry) => tried?.has(e.account.uid) ?? false;
  const realmOK = (e: PoolEntry) => realm === "" || e.account.realm === realm;

  let cands: PoolEntry[] = [];
  for (const e of all) {
    if (skipped(e) || !realmOK(e)) continue;
    if (!healthyForModel(e, now, model)) continue;
    if (floorBlocked(e, model, realm, cfg, now, modelRateOf)) continue;
    if (inFlightFull(e, cfg)) continue;
    cands.push(e);
  }
  if (cands.length === 0) {
    return pickEarliestExpiry(all, tried, now, realm, model, cfg, modelRateOf);
  }

  // maxCredits 统一用全集口径（tier 过滤前）。
  let maxCredits = 0;
  for (const e of cands) {
    const c = Number(e.state.credits);
    if (c > maxCredits) maxCredits = c;
  }

  // 成本分层：0 实测免费 / 1 无观测 / 2 实测收费；硬过滤只留最优层。
  const costTier = (e: PoolEntry): { tier: number; cost1k: number } => {
    const mc = modelCostOf(e, now, model);
    if (!mc) return { tier: 1, cost1k: 0 };
    if (mc.costPer1k <= 0) return { tier: 0, cost1k: 0 };
    return { tier: 2, cost1k: mc.costPer1k };
  };
  let bestTier = 2;
  for (const e of cands) {
    const t = costTier(e).tier;
    if (t < bestTier) bestTier = t;
  }
  // 条件探索：tier 0 垄断 + tier 1 存在 + 窗口到期 → 本次切 tier 1-only。
  if (cfg.cost_explore_interval_ms > 0 && bestTier === 0 && model !== "") {
    const hasTier1 = cands.some((e) => costTier(e).tier === 1);
    const key = realm + "\x1f" + model;
    const last = exploreLast.get(key) ?? 0;
    if (hasTier1 && now - last >= cfg.cost_explore_interval_ms) {
      exploreLast.set(key, now);
      costExploreEvents++;
      bestTier = 1;
    }
  }

  let ws = cands
    .map((e) => {
      const t = costTier(e);
      return { e, w: routingWeightOf(e, maxCredits, cfg, now), tier: t.tier, cost1k: t.cost1k };
    })
    .filter((x) => x.tier === bestTier);

  // 等权重洗牌：存在权重相等且候选超 top5 时 Fisher-Yates 洗牌，避免字典序饿死。
  if (ws.length > 5 && ws.some((x) => x.w === ws[0].w)) {
    for (let i = ws.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ws[i], ws[j]] = [ws[j], ws[i]];
    }
  }
  ws.sort((a, b) => {
    if (a.cost1k !== b.cost1k) return a.cost1k - b.cost1k;
    if (a.w !== b.w) return b.w - a.w;
    return a.e.account.uid < b.e.account.uid ? -1 : 1;
  });

  const candsAll = ws.map((x) => x.e);
  const top5 = ws.slice(0, 5);

  let chosen: PoolEntry;
  const eligible = top5.filter(
    (x) => now - (lastUsedMap.get(x.e.account.uid) ?? 0) >= MIN_PICK_GAP_MS,
  );
  if (eligible.length === 0) {
    // LRU 兜底：全候选里 usedSeq 最小者（与墙钟精度无关的严格全序）。
    chosen = candsAll[0];
    for (const c of candsAll) {
      if ((usedSeqMap.get(c.account.uid) ?? 0) < (usedSeqMap.get(chosen.account.uid) ?? 0)) {
        chosen = c;
      }
    }
  } else {
    chosen = pickWeighted(eligible);
  }
  markUsed(chosen.account.uid);
  return chosen;
}

// pickEarliestExpiry 全冷却兜底：非禁用/非暂停的软冷却/熔断账号中选截止最早者。
// CoolHard（等签到的号）排除——调了必 402；积分保底同判据生效。
function pickEarliestExpiry(
  all: PoolEntry[],
  tried: Set<string> | undefined,
  now: number,
  realm: string,
  model: string,
  cfg: AppConfig,
  modelRateOf?: ModelRateOf,
): PoolEntry | null {
  let best: PoolEntry | null = null;
  let bestExp = 0;
  for (const e of all) {
    if (tried?.has(e.account.uid)) continue;
    if (realm !== "" && e.account.realm !== realm) continue;
    const s = e.state;
    if (s.disabled || s.paused) continue;
    if (s.cooldownReason === "hard_credit" && s.cooldownUntil > now) continue;
    if (floorBlocked(e, model, realm, cfg, now, modelRateOf)) continue;
    if (inFlightFull(e, cfg)) continue;
    const exp = Math.max(Number(s.cooldownUntil), Number(s.breakerUntil));
    if (exp <= 0) continue;
    if (!best || exp < bestExp) {
      best = e;
      bestExp = exp;
    }
  }
  if (best) markUsed(best.account.uid);
  return best;
}

// PickByUIDForModel 粘性路径：绑定号在当前模型健康且未占满才返回，否则 null
//（调用方解绑走普通轮换）。积分保底与 pick 同判据。
export async function pickByUIDForModel(
  cfg: AppConfig,
  uid: string,
  model: string,
  modelRateOf?: ModelRateOf,
): Promise<PoolEntry | null> {
  const now = Date.now();
  const account = await prisma.account.findUnique({
    where: { uid },
    include: { state: true, modelCooldowns: true, modelCosts: true },
  });
  if (!account) return null;
  const e: PoolEntry = {
    account,
    state: account.state ?? defaultState(uid),
    cooldowns: account.modelCooldowns,
    costs: account.modelCosts,
  };
  if (!healthyForModel(e, now, model)) return null;
  if (floorBlocked(e, model, account.realm, cfg, now, modelRateOf)) return null;
  if (inFlightFull(e, cfg)) return null;
  markUsed(uid);
  return e;
}

// availableUIDsForModel 粘性路由的可用集（healthy 且未占满，按 uid 排序）。
export async function availableUIDsForModel(model: string): Promise<string[]> {
  const now = Date.now();
  const all = await loadEntries();
  const out: string[] = [];
  for (const e of all) {
    if (!healthyForModel(e, now, model)) continue;
    out.push(e.account.uid);
  }
  out.sort();
  return out;
}

// ─── 冷却/熔断/状态迁移（cooldown.go + transition.go 同语义） ─────────────

async function getState(uid: string): Promise<AccountState | null> {
  return prisma.accountState.findUnique({ where: { uid } });
}

async function patchState(uid: string, data: Record<string, unknown>): Promise<void> {
  await prisma.accountState.upsert({
    where: { uid },
    create: { uid, ...(data as object) },
    update: data as object,
  });
}

// cappedSoftUntil 把上游重置墙钟截断到 softRateMax。
function cappedSoftUntil(cfg: AppConfig, now: number, resetAt: number): number {
  const cap = now + cfg.soft_rate_max_ms;
  if (resetAt > cap) return cap;
  if (resetAt > now) return resetAt;
  return now + 1; // 已过期（时钟偏移/文案过期）：立即恢复
}

// softDuration 按连续软冷却次数指数放大基数：base << (streak-1)，封顶 softRateMax。
function softDuration(cfg: AppConfig, base: number, streak: number): number {
  if (streak <= 1) return base;
  const shift = Math.min(streak - 1, 8);
  let d = base * 2 ** shift;
  if (d > cfg.soft_rate_max_ms || d <= 0) d = cfg.soft_rate_max_ms;
  return d;
}

// cooldownSoftRate 账号级软冷却（429/限流文案）：
//   resetAt>0 → until=min(resetAt, now+softRateMax)，不指数堆加；
//   resetAt=0 且不在软冷却中 → 有界退避（softStreak++ 翻倍封顶）；
//   resetAt=0 且仍在软冷却中 → 不推进不延长（兜底探测不得越堆越厚）。
// 账号级语义：清路由豁免的模型级冷却（保留 11102 之外无 AuditOnly 之分——
// 本实现模型冷却全部参与路由，账号级冷却时全清，与 Go clearRoutingModelCooldownsLocked
// 在非 AuditOnly 条目的行为一致；审计条目在本实现不单独建模）。
export async function cooldownSoftRate(
  cfg: AppConfig,
  uid: string,
  resetAt: number,
  reason: string,
): Promise<void> {
  const now = Date.now();
  const s = await getState(uid);
  if (!s) return;
  let until = Number(s.cooldownUntil);
  let streak = s.softStreak;
  if (resetAt > 0) {
    until = cappedSoftUntil(cfg, now, resetAt);
  } else if (s.cooldownReason !== "soft_rate" || until <= now) {
    const d = softDuration(cfg, cfg.soft_cooldown_ms, streak + 1);
    streak++;
    until = now + d;
  }
  await patchState(uid, {
    cooldownUntil: BigInt(until),
    cooldownReason: reason || "soft_rate",
    softStreak: streak,
  });
  await prisma.modelCooldown.deleteMany({
    where: { uid, reason: { not: { startsWith: "11102" } } },
  });
}

// cooldownSoftForModel 6004 模型级软冷却（issue #31）：
//   resetAt>0 → (账号,模型) 级冷却截止 min(resetAt, now+softRateMax)；切模型可用。
//   resetAt=0 → 回落账号级有界退避（同 cooldownSoftRate 无解析分支），并记审计行。
export async function cooldownSoftForModel(
  cfg: AppConfig,
  uid: string,
  resetAt: number,
  model: string,
  reason: string,
): Promise<void> {
  const now = Date.now();
  if (resetAt > 0) {
    const until = cappedSoftUntil(cfg, now, resetAt);
    await prisma.modelCooldown.upsert({
      where: { uid_model: { uid, model } },
      create: { uid, model, until: BigInt(until), reason },
      update: { until: BigInt(until), reason },
    });
    return;
  }
  // 无解析时间：账号级有界退避（与 CooldownSoftForModel 无解析分支一致）。
  const s = await getState(uid);
  if (!s) return;
  let until = Number(s.cooldownUntil);
  let streak = s.softStreak;
  if (s.cooldownReason !== "soft_rate" || until <= now) {
    const d = softDuration(cfg, cfg.soft_cooldown_ms, streak + 1);
    streak++;
    until = now + d;
  }
  await patchState(uid, {
    cooldownUntil: BigInt(until),
    cooldownReason: reason || "soft_rate",
    softStreak: streak,
  });
  await prisma.modelCooldown.deleteMany({
    where: { uid, reason: { not: { startsWith: "11102" } } },
  });
}

// cooldownHardCredit 余额耗尽 → 冷却到下一个 04:00（Asia/Shanghai，等签到恢复）。
export async function cooldownHardCredit(uid: string, reason: string): Promise<void> {
  const now = new Date();
  // 下一个 04:00（本地时区）：hour<4 → 当天 4 点，否则次日 4 点。
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const hour = Number(get("hour"));
  let dayOffset = hour < 4 ? 0 : 1;
  const base = new Date(`${get("year")}-${get("month")}-${get("day")}T04:00:00+08:00`);
  const until = base.getTime() + dayOffset * 24 * 3600_000;
  await patchState(uid, {
    cooldownUntil: BigInt(until),
    cooldownReason: reason || "hard_credit",
  });
  await prisma.modelCooldown.deleteMany({
    where: { uid, reason: { not: { startsWith: "11102" } } },
  });
}

// blockModelBackoff 11102 负缓存：首次 6h，TTL = base × 2^min(hits-1, 4)，封顶 24h。
export async function blockModelBackoff(uid: string, model: string, reason: string): Promise<void> {
  if (!uid || !model) return;
  const now = Date.now();
  const prev = await prisma.modelCooldown.findUnique({ where: { uid_model: { uid, model } } });
  // hits 复用 id 之外的持久载体：用 reason 前缀计数不可行，这里单独读 hits 无字段——
  // 本实现把 hits 编码进 audit 维度不可行，改为在内存 Map 记命中数（单实例语义）。
  const hits = (modelBlockHits.get(uid + "\x1f" + model) ?? 0) + 1;
  modelBlockHits.set(uid + "\x1f" + model, hits);
  let ttl = MODEL_BLOCK_BASE_TTL_MS;
  const shift = Math.min(hits - 1, MODEL_BLOCK_SHIFT_MAX);
  const d = ttl * 2 ** shift;
  ttl = d < MODEL_BLOCK_MAX_TTL_MS ? d : MODEL_BLOCK_MAX_TTL_MS;
  const r = reason.startsWith("11102") ? reason : MODEL_BLOCK_REASON;
  await prisma.modelCooldown.upsert({
    where: { uid_model: { uid, model } },
    create: { uid, model, until: BigInt(now + ttl), reason: r },
    update: { until: BigInt(now + ttl), reason: r },
  });
}

const modelBlockHits = new Map<string, number>();

// blockModelClear 该 (账号,模型) 实测成功 → 清 11102 负缓存（6004 不清）。
export async function blockModelClear(uid: string, model: string): Promise<void> {
  if (!uid || !model) return;
  modelBlockHits.delete(uid + "\x1f" + model);
  await prisma.modelCooldown.deleteMany({
    where: { uid, model, reason: { startsWith: "11102" } },
  });
}

// ModelBlockStatus 全池模型级阻塞快照（Go ModelBlocked 同语义）。
export interface ModelBlockStatus {
  blocked: boolean;
  reason: string;
  until: number; // 最早解封 unix 毫秒，0 = 未知
  count: number;
}

export async function modelBlocked(model: string): Promise<ModelBlockStatus> {
  const empty: ModelBlockStatus = { blocked: false, reason: "", until: 0, count: 0 };
  if (!model) return empty;
  const now = Date.now();
  const all = await loadEntries();
  const st: ModelBlockStatus = { ...empty };
  for (const e of all) {
    if (e.state.disabled || e.state.paused) continue;
    if (!modelCooled(e, now, model)) return empty; // 还有号能服务 → 非全池阻塞
    st.count++;
    const mc = e.cooldowns.find((c) => c.model === model);
    if (mc) {
      if (!st.reason) st.reason = mc.reason;
      const u = Number(mc.until);
      if (u > 0 && (st.until === 0 || u < st.until)) st.until = u;
    }
  }
  if (st.count === 0) return empty;
  st.blocked = true;
  return st;
}

// noteBreakerFailure 累计一次熔断失败；达阈值按指数退避熔断（retryCount 为指数）。
async function noteBreakerFailure(cfg: AppConfig, uid: string): Promise<void> {
  const s = await getState(uid);
  if (!s) return;
  let fails = s.breakerFails + 1;
  if (fails < cfg.breaker_threshold) {
    await patchState(uid, { breakerFails: fails });
    return;
  }
  // retryCount 无独立字段：复用 sessionStrikes？不行——那是 12153 专用。
  // Go 的 retryCount 是运行态（不持久化），这里同样放内存。
  const retryCount = breakerRetryCount.get(uid) ?? 0;
  let d = cfg.breaker_cooldown_ms;
  for (let i = 0; i < retryCount; i++) {
    d *= 2;
    if (d >= cfg.breaker_cooldown_max_ms) {
      d = cfg.breaker_cooldown_max_ms;
      break;
    }
  }
  breakerRetryCount.set(uid, retryCount + 1);
  await patchState(uid, {
    breakerFails: 0,
    breakerUntil: BigInt(Date.now() + d),
  });
}

const breakerRetryCount = new Map<string, number>();

// noteFailures 连败降权兜底（issue #114）：传输层/未知 4xx 这类 applyErrorPolicy
// 不罚号的形态喂连败计数，连续 N 次临时出池（degradeUntil）。
// 参数与熔断共用一组（breaker_*），与 Go SetDegrade 默认对齐 SetBreaker 的口径。
export async function noteFailures(cfg: AppConfig, uid: string): Promise<void> {
  const s = await getState(uid);
  if (!s) return;
  const fails = consecutiveFails.get(uid) ?? 0;
  const next = fails + 1;
  consecutiveFails.set(uid, next);
  if (next < cfg.breaker_threshold) return;
  let d = cfg.breaker_cooldown_ms;
  const rc = degradeRetryCount.get(uid) ?? 0;
  for (let i = 0; i < rc; i++) {
    d *= 2;
    if (d >= cfg.breaker_cooldown_max_ms) {
      d = cfg.breaker_cooldown_max_ms;
      break;
    }
  }
  degradeRetryCount.set(uid, rc + 1);
  consecutiveFails.set(uid, 0);
  await patchState(uid, {
    degradeUntil: BigInt(Date.now() + d),
    cooldownReason: "consecutive failures",
  });
}

const consecutiveFails = new Map<string, number>();
const degradeRetryCount = new Map<string, number>();

// noteError 5xx/服务端反复失败 → 熔断计数（Go NoteError 同语义）。
export async function noteError(cfg: AppConfig, uid: string): Promise<void> {
  await noteBreakerFailure(cfg, uid);
}

// noteSessionDead 12153 连续计数，达 3 次禁用（Go NoteSessionDead 阈值）。
const SESSION_DEAD_THRESHOLD = 3;

export async function noteSessionDead(uid: string): Promise<boolean> {
  const s = await getState(uid);
  if (!s) return false;
  const strikes = s.sessionStrikes + 1;
  if (strikes >= SESSION_DEAD_THRESHOLD) {
    await disable(uid, "session dead (12153 x" + strikes + ")");
    return true;
  }
  await patchState(uid, { sessionStrikes: strikes, sessionDead: false });
  return false;
}

// noteSuccess 成功迁移：清 fails/retryCount/breakerUntil/softStreak/sessionStrikes/
// degrade，**不清 modelCooldowns**（6004 各自独立计时；11102 由 blockModelClear 显式清）。
export async function noteSuccess(uid: string): Promise<void> {
  breakerRetryCount.delete(uid);
  consecutiveFails.delete(uid);
  degradeRetryCount.delete(uid);
  await patchState(uid, {
    breakerFails: 0,
    breakerUntil: 0n,
    softStreak: 0,
    sessionStrikes: 0,
    sessionDead: false,
    degradeUntil: 0n,
  });
}

// noteModelCost 实测扣费台账（EMA α=0.3）+ 同步扣减本地插值余额。
export async function noteModelCost(
  uid: string,
  model: string,
  credit: number,
  tokens: number,
): Promise<void> {
  if (!uid || !model || tokens <= 0) return;
  let per1k = (credit / tokens) * 1000;
  if (per1k < 0) per1k = 0;
  const now = Date.now();

  if (credit > 0) {
    const s = await getState(uid);
    if (s) {
      let d = BigInt(Math.floor(credit + 0.5));
      let credits = s.credits;
      if (d > credits) d = credits; // 钳 0：扣穿不产生负余额
      credits -= d;
      let expiring = s.expiring;
      if (expiring > 0n) expiring = d > expiring ? 0n : expiring - d;
      let earliestRemain = s.earliestRemain;
      let earliestAt = s.earliestAt;
      if (earliestRemain > 0n) {
        if (d >= earliestRemain) {
          earliestRemain = 0n;
          earliestAt = 0n;
        } else {
          earliestRemain -= d;
        }
      }
      await patchState(uid, { credits, expiring, earliestRemain, earliestAt });
    }
  }

  const prev = await prisma.modelCost.findUnique({ where: { uid_model: { uid, model } } });
  const ALPHA = 0.3;
  if (!prev) {
    await prisma.modelCost.create({
      data: {
        uid, model, costPer1k: per1k, tokens,
        observedAt: BigInt(now), expiresAt: BigInt(now + MODEL_COST_TTL_MS),
      },
    });
  } else {
    await prisma.modelCost.update({
      where: { uid_model: { uid, model } },
      data: {
        costPer1k: prev.costPer1k * (1 - ALPHA) + per1k * ALPHA,
        tokens: prev.tokens + tokens,
        observedAt: BigInt(now),
        expiresAt: BigInt(now + MODEL_COST_TTL_MS),
      },
    });
  }
}

// ─── 管理操作（面板用） ───────────────────────────────────────────────────

// disable 禁用迁移：清冷却域（until/softStreak/模型级冷却）+ 置 disabled；
// 熔断器保留（禁用是授权终态，不覆盖熔断观测）。
export async function disable(uid: string, reason: string): Promise<void> {
  await patchState(uid, {
    disabled: true,
    paused: false,
    disableReason: reason,
    disabledAt: BigInt(Date.now()),
    cooldownUntil: 0n,
    cooldownReason: "",
    softStreak: 0,
  });
  await prisma.modelCooldown.deleteMany({ where: { uid } });
}

// reviveDisabled 人工复活：清禁用与冷却域，重学窗口开始。
export async function revive(uid: string): Promise<void> {
  await patchState(uid, {
    disabled: false,
    disableReason: "",
    disabledAt: 0n,
    sessionDead: false,
    sessionStrikes: 0,
    cooldownUntil: 0n,
    cooldownReason: "",
    softStreak: 0,
    breakerFails: 0,
    breakerUntil: 0n,
    degradeUntil: 0n,
  });
  breakerRetryCount.delete(uid);
  consecutiveFails.delete(uid);
  degradeRetryCount.delete(uid);
  await prisma.modelCooldown.deleteMany({ where: { uid } });
}

export async function pause(uid: string): Promise<void> {
  await patchState(uid, { paused: true });
}

export async function resume(uid: string): Promise<void> {
  await patchState(uid, { paused: false });
}

// setCreditsDetailed 签到/余额刷新后的权威回写（Go SetCreditsDetailed 钳制语义）。
export async function setCreditsDetailed(
  uid: string,
  credits: bigint,
  total: bigint,
  expiring: bigint,
  earliestAt: bigint,
  earliestRemain: bigint,
): Promise<void> {
  if (credits < 0n) credits = 0n;
  if (expiring < 0n) expiring = 0n;
  if (expiring > credits) expiring = credits;
  if (earliestRemain < 0n) earliestRemain = 0n;
  if (earliestRemain > credits) earliestRemain = credits;
  const now = BigInt(Date.now());
  if (earliestAt <= 0n || earliestAt <= now || earliestRemain === 0n) {
    earliestAt = 0n;
    earliestRemain = 0n;
  }
  // ReenableIfCredits：余额恢复只解冻 CoolHard；软限流/模型级台账各有自身恢复时刻。
  const s = await getState(uid);
  const data: Record<string, unknown> = {
    credits, total, expiring, earliestAt, earliestRemain,
    balanceAt: now,
  };
  if (s && s.cooldownReason === "hard_credit" && credits > 0n) {
    data.cooldownUntil = 0n;
    data.cooldownReason = "";
  }
  await patchState(uid, data);
}

// markCheckin 标记今日已签到（Asia/Shanghai 日期，跨零点自然过期）。
export async function markCheckin(uid: string): Promise<void> {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  await patchState(uid, { lastCheckinDay: day });
}

export const todayShanghai = (): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());

// ─── 状态快照（面板 /status 用） ──────────────────────────────────────────

export interface StatusRow {
  uid: string;
  nickname: string;
  realm: string;
  enterprise: boolean;
  credits: number;
  credits_total: number;
  credits_expiring: number;
  credits_earliest_expiry: number;
  credits_earliest_remaining: number;
  cooling: boolean;
  cool_kind: string;
  cool_remaining_sec: number;
  reason: string;
  disabled: boolean;
  disabled_reason: string;
  paused: boolean;
  checkin_done: boolean;
  soft_streak: number;
  in_flight: number;
  breaker_fails: number;
  breaker_until: number;
  degrade_until: number;
  rate_limited_models: { model: string; kind: string; until: number; reason: string }[];
  model_costs: { model: string; cost_per_1k: number; last_seen: number }[];
}

export async function statusList(): Promise<StatusRow[]> {
  const now = Date.now();
  const all = await loadEntries();
  const today = todayShanghai();
  const rows: StatusRow[] = all.map((e) => {
    const s = e.state;
    const cooling = Number(s.cooldownUntil) > now || Number(s.breakerUntil) > now;
    let coolKind = s.cooldownReason;
    let remaining = 0;
    if (Number(s.cooldownUntil) > now) {
      remaining = Math.max(remaining, Math.ceil((Number(s.cooldownUntil) - now) / 1000));
    }
    if (Number(s.breakerUntil) > now) {
      const r = Math.ceil((Number(s.breakerUntil) - now) / 1000);
      if (r > remaining) {
        remaining = r;
        coolKind = "breaker";
      }
    }
    const rateLimited = e.cooldowns
      .filter((c) => Number(c.until) > now)
      .map((c) => ({
        model: c.model,
        kind: c.reason.startsWith("11102") ? "model_unavailable" : "rate_limit",
        until: Number(c.until),
        reason: c.reason,
      }))
      .sort((a, b) => (a.model < b.model ? -1 : 1));
    const modelCosts = e.costs
      .filter((c) => {
        const obs = Number(c.observedAt);
        if (obs <= 0 || now - obs > MODEL_COST_TTL_MS) return false;
        return !(Number(c.expiresAt) > 0 && Number(c.expiresAt) <= now);
      })
      .map((c) => ({ model: c.model, cost_per_1k: c.costPer1k, last_seen: Number(c.observedAt) }))
      .sort((a, b) => (a.model < b.model ? -1 : 1));
    return {
      uid: e.account.uid,
      nickname: e.account.nickname,
      realm: e.account.realm,
      enterprise: e.account.enterpriseId !== "",
      credits: Number(s.credits),
      credits_total: Number(s.total),
      credits_expiring: Number(s.expiring),
      credits_earliest_expiry: Number(s.earliestAt),
      credits_earliest_remaining: Number(s.earliestRemain),
      cooling,
      cool_kind: cooling ? coolKind : "",
      cool_remaining_sec: remaining,
      reason: s.cooldownReason,
      disabled: s.disabled,
      disabled_reason: s.disabled ? s.disableReason : "",
      paused: s.paused,
      checkin_done: s.lastCheckinDay === today,
      soft_streak: s.softStreak,
      in_flight: inFlightCount(e.account.uid),
      breaker_fails: s.breakerFails,
      breaker_until: Number(s.breakerUntil),
      degrade_until: Number(s.degradeUntil),
      rate_limited_models: rateLimited,
      model_costs: modelCosts,
    };
  });
  rows.sort((a, b) => (a.uid < b.uid ? -1 : 1));
  return rows;
}

// ─── 模型锁池视图（移植 Go pool/modelview.go ModelLockView） ─────────────

// modelLockView 汇总当前所有「有未过期模型级冷却」的 (域, 模型)（Go ModelLockView
// 同口径）。聚合核心在 modelview.ts（纯函数可离线单测），这里只做 ORM 行适配。
// 无锁时返回 null（前端按空态渲染）。
export type { ModelLockRow } from "./modelview";

export async function modelLockView(cfg: AppConfig): Promise<ModelLockRow[] | null> {
  const now = Date.now();
  const all = await loadEntries();
  const entries: LockViewEntry[] = all.map((e) => ({
    uid: e.account.uid,
    realm: e.account.realm,
    disabled: e.state.disabled,
    paused: e.state.paused,
    accountUnavailableUntil: Math.max(
      Number(e.state.cooldownUntil), Number(e.state.breakerUntil), Number(e.state.degradeUntil),
    ),
    modelCooldowns: e.cooldowns.map((c) => ({
      model: c.model, until: Number(c.until), reason: c.reason,
    })),
  }));
  return modelLockViewPure(entries, now, (uid) => {
    const e = all.find((x) => x.account.uid === uid);
    return e ? inFlightFull(e, cfg) : false;
  });
}
// Counts 池计数（面板概况）。
export async function counts(): Promise<{
  total: number; healthy: number; cooling: number; disabled: number; paused: number;
}> {
  const now = Date.now();
  const all = await loadEntries();
  let healthy = 0, cooling = 0, disabled = 0, paused = 0;
  for (const e of all) {
    const s = e.state;
    if (s.disabled) disabled++;
    else if (s.paused) paused++;
    else if (!isHealthy(e, now)) cooling++;
    else healthy++;
  }
  return { total: all.length, healthy, cooling, disabled, paused };
}

// countsDetailed 对齐 Go Pool.CountsDetailed：在 counts 之上附 in_flight_full
//（在途打满上限的账号数，含域上限口径），供 /status 与面板 overview。
export async function countsDetailed(cfg: AppConfig): Promise<{
  total: number; healthy: number; cooling: number; disabled: number; paused: number;
  in_flight_full: number;
}> {
  const base = await counts();
  const all = await loadEntries();
  let inFlightFullN = 0;
  for (const e of all) {
    if (e.state.disabled || e.state.paused) continue;
    if (inFlightFull(e, cfg)) inFlightFullN++;
  }
  return { ...base, in_flight_full: inFlightFullN };
}

export function costExploreStatus(): { events: number; last: Record<string, number> } {
  const last: Record<string, number> = {};
  for (const [k, v] of exploreLast) last[k.replace("\x1f", "|")] = v;
  return { events: costExploreEvents, last };
}

// applyErrorKind 按错误类别落账号处置（Go applyErrorPolicy 同语义）。
// 返回 true 表示该类别属于「不罚号不轮转」的请求级错误（调用方直接透传 400）。
export async function applyErrorKind(
  cfg: AppConfig,
  uid: string,
  kind: ErrKind,
  body: string,
  model: string,
  retryAfterMs: number,
): Promise<void> {
  switch (kind) {
    case "hard_credit":
      await cooldownHardCredit(uid, "hard_credit: " + body.slice(0, 120));
      return;
    case "soft_rate": {
      const resetAt = parseRateReset(body) || (retryAfterMs > 0 ? Date.now() + retryAfterMs : 0);
      if (model && isModelRateLimit(body)) {
        await cooldownSoftForModel(cfg, uid, resetAt, model, "6004 " + body.slice(0, 110));
      } else {
        await cooldownSoftRate(cfg, uid, resetAt, "soft_rate: " + body.slice(0, 110));
      }
      return;
    }
    case "session_dead":
      await noteSessionDead(uid);
      return;
    case "account_fault":
      await cooldownSoftRate(cfg, uid, 0, "account_fault: " + body.slice(0, 110));
      return;
    case "model_blocked":
      if (model) await blockModelBackoff(uid, model, MODEL_BLOCK_REASON);
      return;
    case "waf_block":
      await cooldownSoftRate(cfg, uid, 0, "waf_block: " + body.slice(0, 110));
      return;
    case "server":
    case "not_found":
      await noteError(cfg, uid);
      return;
    case "content_blocked":
    case "prompt_too_long":
    case "image_invalid":
    case "bad_params":
    case "client":
    case "none":
      // 请求级/未知错误：不罚号（client 由调用方决定是否喂连败）。
      return;
  }
}
