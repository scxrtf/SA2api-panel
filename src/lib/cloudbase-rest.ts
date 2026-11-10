// CloudBase PostgREST 客户端
//
// 为什么存在：CloudBase 个人版共享 PG 不开 TCP 直连（5432 实测不可达），
// 唯一可用的数据通道是 PostgREST HTTP 网关。本模块封装 fetch 调用，
// 鉴权用 service_role API Key（CLOUDBASE_API_KEY）。
//
// 双通道：默认走手写 fetch（无依赖、行为可预期）；
// 置 CLOUDBASE_SDK=1 时切换到 @cloudbase/js-sdk v3 的 rdb() 通道
// （官方 SDK，自动处理鉴权刷新与关联查询语法糖）。两者返回同样的行数组。
//
// 边界：本模块只做"读"路径的高频表（Account / ApiKey / BalanceSample）。
// 写路径、复杂事务、调度核心（pool.ts）仍走 Prisma 直连源库（db.prisma.io），
// 由 USE_CLOUDBASE_REST 环境变量灰度切换，保留快速回滚能力。

const BASE_URL = process.env.CLOUDBASE_POSTGREST_URL ?? "";
const API_KEY = process.env.CLOUDBASE_API_KEY ?? "";

if (!BASE_URL || !API_KEY) {
  // 不在模块加载时抛错：Next build 的 page data 收集会 import 到本模块，
  // 构建机上不要求 CloudBase 变量；真正的校验推迟到首次查询。
}

type Filter = { col: string; op: string; val: string | number | boolean };

type QueryOpts = {
  select?: string;                     // e.g. "uid,nickname,realm" or "*,rel(*)"
  filters?: Filter[];                  // 等值/比较/模式过滤
  order?: { col: string; desc?: boolean }[];
  limit?: number;
  offset?: number;
};

function buildUrl(table: string, opts: QueryOpts = {}): string {
  const url = new URL(`${BASE_URL}/${encodeURIComponent(table)}`);
  if (opts.select) url.searchParams.set("select", opts.select);
  for (const f of opts.filters ?? []) {
    url.searchParams.append(f.col, `${f.op}.${String(f.val)}`);
  }
  if (opts.order && opts.order.length) {
    const o = opts.order.map((x) => (x.desc ? `${x.col}.desc` : x.col)).join(",");
    url.searchParams.set("order", o);
  }
  if (typeof opts.limit === "number") url.searchParams.set("limit", String(opts.limit));
  if (typeof opts.offset === "number") url.searchParams.set("offset", String(opts.offset));
  return url.toString();
}

async function req<T>(table: string, opts: QueryOpts = {}): Promise<T> {
  if (isCloudbaseSdkEnabled()) return reqViaSdk<T>(table, opts);
  const url = buildUrl(table, opts);
  const r = await fetch(url, {
    method: "GET",
    headers: {
      apikey: API_KEY,
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`cloudbase-rest ${table} ${r.status}: ${body.slice(0, 300)}`);
  }
  return (await r.json()) as T;
}

// 通用读取入口（监控/运维脚本用）：行大小采样、时间跨度、增量窗口等
// 不适合走 dal 的 Prisma 语义，直接暴露 PostgREST 查询原语。
export async function cbSelect<T>(table: string, opts: QueryOpts = {}): Promise<T> {
  return req<T>(table, opts);
}

// ─── 写操作（fetch 通道）────────────────────────────────────────────────
// PostgREST 标准写语义：POST 插入 / PATCH 更新（必须带 WHERE）/ DELETE（必须带 WHERE）。
// Prefer: return=representation 让网关回写受影响行，便于调用方校验。

type WriteFilter = { col: string; op: string; val: string | number | boolean };

function writeUrl(table: string, filters: WriteFilter[]): string {
  const url = new URL(`${BASE_URL}/${encodeURIComponent(table)}`);
  for (const f of filters) url.searchParams.append(f.col, `${f.op}.${String(f.val)}`);
  return url.toString();
}

const WRITE_HEADERS = {
  apikey: API_KEY,
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
  Prefer: "return=representation",
};

export async function cbInsert<T>(table: string, rows: Record<string, unknown>[]): Promise<T[]> {
  const r = await fetch(`${BASE_URL}/${encodeURIComponent(table)}`, {
    method: "POST",
    headers: WRITE_HEADERS,
    body: JSON.stringify(rows),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`cloudbase-rest insert ${table} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return (text ? JSON.parse(text) : []) as T[];
}

export async function cbUpdate<T>(
  table: string,
  filters: WriteFilter[],
  patch: Record<string, unknown>,
): Promise<T[]> {
  const r = await fetch(writeUrl(table, filters), {
    method: "PATCH",
    headers: WRITE_HEADERS,
    body: JSON.stringify(patch),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`cloudbase-rest update ${table} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return (text ? JSON.parse(text) : []) as T[];
}

export async function cbDelete(table: string, filters: WriteFilter[]): Promise<void> {
  const r = await fetch(writeUrl(table, filters), {
    method: "DELETE",
    headers: { ...WRITE_HEADERS, Prefer: "return=minimal" },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`cloudbase-rest delete ${table} ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

// ─── RPC（fetch 通道）───────────────────────────────────────────────────
// 调用 PG 函数：POST /v1/rdb/rest/rpc/:fn。多步写（如 rollup）可在库里
// 包成一个函数，天然同事务，等价于 Prisma $transaction。
export async function cbRpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${BASE_URL}/rpc/${encodeURIComponent(fn)}`, {
    method: "POST",
    headers: WRITE_HEADERS,
    body: JSON.stringify(args),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`cloudbase-rest rpc ${fn} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const text = await r.text();
  return (text ? JSON.parse(text) : null) as T;
}

// ─── js-sdk 通道（CLOUDBASE_SDK=1 时启用）────────────────────────────────
// @cloudbase/js-sdk v3 在 Node 端提供与 node-sdk 相同的 rdb() 接口；
// accessKey 即 service_role API Key，SDK 内部走同一 PostgREST 网关。
// 懒加载 + 缓存 init 结果，避免每个请求都重建实例。

type RdbQuery = {
  select: (cols?: string, o?: { count?: string; head?: boolean }) => RdbQuery;
  eq: (col: string, val: unknown) => RdbQuery;
  gte: (col: string, val: unknown) => RdbQuery;
  lte: (col: string, val: unknown) => RdbQuery;
  like: (col: string, val: string) => RdbQuery;
  order: (col: string, o: { ascending: boolean }) => RdbQuery;
  limit: (n: number) => RdbQuery;
  range: (from: number, to: number) => RdbQuery;
  then: PromiseLike<{ data: unknown; error: { message?: string; code?: string } | null }>["then"];
};

let _sdkDb: { from: (t: string) => RdbQuery } | null = null;

function sdkDb(): { from: (t: string) => RdbQuery } {
  if (_sdkDb) return _sdkDb;
  const envId = process.env.CLOUDBASE_ENV_ID ?? "";
  if (!envId || !API_KEY) {
    throw new Error("cloudbase-sdk: CLOUDBASE_ENV_ID / CLOUDBASE_API_KEY 未配置");
  }
  // require 延迟到首次使用，避免构建期拉起整个 SDK。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cloudbase = require("@cloudbase/js-sdk") as {
    init: (o: { env: string; accessKey: string }) => { rdb: () => { from: (t: string) => RdbQuery } };
  };
  _sdkDb = cloudbase.init({ env: envId, accessKey: API_KEY }).rdb();
  return _sdkDb;
}

async function reqViaSdk<T>(table: string, opts: QueryOpts = {}): Promise<T> {
  let q = sdkDb().from(table).select(opts.select ?? "*") as unknown as RdbQuery;
  for (const f of opts.filters ?? []) {
    if (f.op === "eq") q = q.eq(f.col, f.val);
    else if (f.op === "gte") q = q.gte(f.col, f.val);
    else if (f.op === "lte") q = q.lte(f.col, f.val);
    else if (f.op === "like") q = q.like(f.col, String(f.val));
    else throw new Error(`cloudbase-sdk: 未实现的过滤操作 ${f.op}`);
  }
  for (const o of opts.order ?? []) {
    q = q.order(o.col, { ascending: !o.desc });
  }
  if (typeof opts.limit === "number") q = q.limit(opts.limit);
  if (typeof opts.offset === "number") q = q.range(opts.offset, opts.offset + (opts.limit ?? 1000) - 1);
  const { data, error } = await q;
  if (error) {
    throw new Error(`cloudbase-sdk ${table}: ${error.code ?? ""} ${error.message ?? ""}`.slice(0, 300));
  }
  return data as T;
}

export function isCloudbaseSdkEnabled(): boolean {
  const v = (process.env.CLOUDBASE_SDK ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

// ─── Account ──────────────────────────────────────────────────────────────
export type CbAccount = {
  uid: string;
  nickname: string | null;
  realm: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  domain: string | null;
  enterpriseId: string | null;
  deviceToken: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export async function cbAccountList(fields?: string[]): Promise<CbAccount[]> {
  return req<CbAccount[]>("Account", {
    select: fields?.join(",") ?? "*",
    order: [{ col: "createdAt", desc: false }],
  });
}

export async function cbAccountByUid(uid: string): Promise<CbAccount | null> {
  const rows = await req<CbAccount[]>("Account", {
    filters: [{ col: "uid", op: "eq", val: uid }],
    limit: 1,
  });
  return rows[0] ?? null;
}

export async function cbAccountNames(): Promise<{ uid: string; nickname: string | null; realm: string | null }[]> {
  return req("Account", { select: "uid,nickname,realm" });
}

// ─── ApiKey ───────────────────────────────────────────────────────────────
export type CbApiKey = {
  name: string;
  key: string;
  disabled: boolean | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export async function cbApiKeyList(): Promise<CbApiKey[]> {
  return req<CbApiKey[]>("ApiKey", { order: [{ col: "createdAt", desc: false }] });
}

export async function cbApiKeyByName(name: string): Promise<CbApiKey | null> {
  const rows = await req<CbApiKey[]>("ApiKey", {
    filters: [{ col: "name", op: "eq", val: name }],
    limit: 1,
  });
  return rows[0] ?? null;
}

// ─── BalanceSample ────────────────────────────────────────────────────────
export type CbBalanceSample = {
  id: number;
  uid: string;
  at: string;             // timestamptz ISO
  credits: string;        // numeric / bigint
  creditsTotal: string;
};

export async function cbBalanceSamples(opts: {
  sinceMs?: number;
  uid?: string;
  limit?: number;
  order?: "asc" | "desc";
} = {}): Promise<CbBalanceSample[]> {
  const filters: Filter[] = [];
  if (typeof opts.sinceMs === "number") {
    filters.push({ col: "at", op: "gte", val: new Date(opts.sinceMs).toISOString() });
  }
  if (opts.uid) filters.push({ col: "uid", op: "eq", val: opts.uid });
  return req<CbBalanceSample[]>("BalanceSample", {
    filters,
    order: [{ col: "at", desc: opts.order !== "asc" }],
    limit: opts.limit ?? 1000,
  });
}

// ─── 灰度开关 ────────────────────────────────────────────────────────────
// true 时调用方应优先走本模块；false 时回退到 prisma。
export function useCloudbaseRest(): boolean {
  const v = (process.env.USE_CLOUDBASE_REST ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
