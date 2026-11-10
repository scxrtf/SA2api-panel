// 数据访问层（DAL）：Prisma 形态的薄垫片，底层走 CloudBase PostgREST。
//
// 为什么存在：CloudBase 个人版共享 PG 不开 TCP 直连，唯一通道是 PostgREST。
// 本模块把 prisma.<model>.<method>(args) 翻译成等价的 PostgREST HTTP 调用，
// 让既有 90+ 处调用点零改动切流；聚合（count/groupBy/aggregate）走应用层
// 拉行自算（已实测窗口行数：UsageEvent 7d≈5.4k、RequestLog 共 3k，可行）。
//
// 边界：本模块只覆盖「单表 CRUD + 计数/聚合」；跨表事务、复杂 $queryRaw
// （usage-query 的 17 路 UNION、database 监控的 pg_catalog）不在翻译范围内，
// 由各自调用方保留 Prisma 通道或改用专门的聚合函数。
//
// 灰度开关：USE_CLOUDBASE_REST=1 时 db.ts 把 prisma 转发到本模块。

const BASE_URL = process.env.CLOUDBASE_POSTGREST_URL ?? "";
const API_KEY = process.env.CLOUDBASE_API_KEY ?? "";

// cuid() 是 Prisma 客户端生成（库内无默认值）；DAL 生成兼容形态。
// cuid v1: "c" + base36(timestamp) + base36(counter) + fingerprint + random。
// 这里用 "c" + 时间基 + 随机段，保证唯一与可读长度；上游只当不透明主键。
let _cuidCounter = Math.floor(Math.random() * 36 ** 4);
function newCuid(): string {
  _cuidCounter = (_cuidCounter + 1) % 36 ** 4;
  const t = Date.now().toString(36);
  const c = _cuidCounter.toString(36).padStart(4, "0");
  const r1 = Math.random().toString(36).slice(2, 10);
  const r2 = Math.random().toString(36).slice(2, 10);
  return `c${t}${c}${r1}${r2}`;
}

// 各表的客户端默认值：Prisma @default 里由客户端承担的部分。
// createdAt/updatedAt/at 库内有 DEFAULT now()，但 PostgREST 不显式传则库端生效——
// 与 Prisma 行为一致（Prisma 也不传，靠库默认），故不强制注入；只补 cuid 主键。
const CUID_PK_TABLES = new Set([
  "ModelCooldown", "ModelCost", "ApiKey", "MachineKeyAuthorization",
  "UsageEvent", "RequestLog", "TaskQueueItem", "ModelHealthCheck", "BalanceSample",
]);

// 各表主键列（PostgREST count 的 select 目标用任一真实列即可，统一用主键）。
const PK_COL: Record<string, string> = {
  Account: "uid", AccountState: "uid", ModelCooldown: "id", ModelCost: "id",
  ApiKey: "id", MachineKeyAuthorization: "machineId", Provider: "id",
  Setting: "key", UsageEvent: "id", RequestLog: "id", StickySession: "key",
  LoginSession: "id", TaskQueueItem: "id", ModelProbe: "key",
  ModelHealthCheck: "id", BalanceSample: "id",
};

// @updatedAt 是 Prisma 客户端语义（库端无 DEFAULT/触发器）：写入时注入当前时间。
const UPDATED_AT_TABLES = new Set([
  "Account", "AccountState", "MachineKeyAuthorization", "Setting",
  "StickySession", "TaskQueueItem", "ModelProbe",
]);

function withDefaults(table: string, data: Record<string, unknown>): Record<string, unknown> {
  let out = data;
  if (CUID_PK_TABLES.has(table) && out.id === undefined) {
    out = { ...out, id: newCuid() };
  }
  if (UPDATED_AT_TABLES.has(table) && out.updatedAt === undefined) {
    out = { ...out, updatedAt: new Date() };
  }
  return out;
}

// update/updateMany 专用：@updatedAt 在每次更新时刷新（Prisma 语义），
// 但绝不生成 cuid 主键。
function withUpdateDefaults(table: string, data: Record<string, unknown>): Record<string, unknown> {
  if (UPDATED_AT_TABLES.has(table) && data.updatedAt === undefined) {
    return { ...data, updatedAt: new Date() };
  }
  return data;
}

// ─── 行值编解码 ─────────────────────────────────────────────────────────
// PostgREST 把 timestamptz 返回为 ISO 字符串、bigint/numeric 返回为字符串/数字。
// Prisma 侧对应 Date 与 BigInt。DAL 按「值形态 + 字段名约定」做无损互转，
// 不依赖 schema 反射（17 张表、列名稳定）。

const DATE_COLS = new Set(["createdAt", "updatedAt", "at", "testedAt", "checkedAt"]);

function decodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)) {
      // 嵌入的单对象关系（state）
      out[k] = decodeRow(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      // 嵌入的数组关系（modelCooldowns/modelCosts）
      out[k] = v.map((item) =>
        item && typeof item === "object" ? decodeRow(item as Record<string, unknown>) : item,
      );
    } else if (typeof v === "string" && DATE_COLS.has(k) && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      out[k] = new Date(v);
    } else if (
      // BigInt 列：余额/积分/token 计数等。CloudBase PostgREST 对 int8
      // 在安全范围内返回 number（非字符串），两种形态都要转 BigInt。
      // 已知 BigInt 列名走精确匹配，避免把普通文本/数值误转。
      (typeof v === "number" && Number.isInteger(v) || typeof v === "string" && /^-?\d+$/.test(v)) &&
      ["credits", "total", "expiring", "expiresAt", "creditsTotal", "first", "consumed", "gained"].includes(k)
    ) {
      out[k] = BigInt(v as string | number);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else if (typeof v === "bigint") out[k] = v.toString();
    else out[k] = v;
  }
  return out;
}

// ─── 请求封装 ───────────────────────────────────────────────────────────

const H = {
  apikey: API_KEY,
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function http<T>(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: { ...H, ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`dal ${method} ${url.slice(url.indexOf("/rest/"))} ${r.status}: ${t.slice(0, 300)}`);
  }
  if (r.status === 204) return undefined as T;
  const text = await r.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ─── where → PostgREST 过滤串 ───────────────────────────────────────────

type Where = Record<string, unknown>;

function pushCond(parts: string[], col: string, cond: Record<string, unknown>): void {
  for (const [op, val] of Object.entries(cond)) {
    if (val instanceof Date) {
      parts.push(`${col}=${op}.${val.toISOString()}`);
    } else if (Array.isArray(val)) {
      // in: [a,b,c] → col=in.(a,b,c)
      const list = val.map((x) => (x instanceof Date ? x.toISOString() : typeof x === "bigint" ? x.toString() : String(x))).join(",");
      parts.push(`${col}=${op}.(${list})`);
    } else if (typeof val === "string" && op === "not" && val === "") {
      // { not: "" } → col=neq.  （Prisma 的 not:"" 等价 PostgREST neq.""）
      parts.push(`${col}=neq.`);
    } else if (op === "not") {
      if (val === null) {
        // Prisma { not: null } → PostgREST not.is.null
        parts.push(`${col}=not.is.null`);
        continue;
      }
      // not 也可能是嵌套对象 { not: { lt: x } } 或标量
      if (val && typeof val === "object" && !(val instanceof Date)) {
        for (const [innerOp, innerVal] of Object.entries(val as Record<string, unknown>)) {
          const v = innerVal instanceof Date ? innerVal.toISOString() : String(innerVal);
          parts.push(`${col}=not.${innerOp}.${v}`);
        }
      } else {
        parts.push(`${col}=neq.${val instanceof Date ? val.toISOString() : String(val)}`);
      }
    } else {
      parts.push(`${col}=${op}.${val instanceof Date ? val.toISOString() : typeof val === "bigint" ? val.toString() : String(val)}`);
    }
  }
}

function whereToQuery(where: Where | undefined): string {
  if (!where || Object.keys(where).length === 0) return "";
  const parts: string[] = [];
  for (const [col, cond] of Object.entries(where)) {
    if (col === "AND" && Array.isArray(cond)) {
      for (const sub of cond) {
        const s = whereToQuery(sub as Where);
        if (s) parts.push(s);
      }
    } else if (col === "OR" && Array.isArray(cond)) {
      // PostgREST: or=(col.op.val,col.op.val)；子条件本身是 col=op.val 形态，
      // 直接把 = 换成 . 是不行的（逻辑树语法不同）。这里把每个子 where 的
      // "col=op.val" 转成 "col.op.val"，多条件子句用 and(...) 包裹。
      const subs = (cond as Where[]).map((sub) => {
        const s = whereToQuery(sub);
        const parts = s.split("&").filter(Boolean).map((p) => {
          // "col=op.val" → "col.op.val"；已是 or=/and( 形式则原样保留
          if (p.includes("(")) return p;
          const i = p.indexOf("=");
          return i < 0 ? p : `${p.slice(0, i)}.${p.slice(i + 1)}`;
        });
        return parts.length > 1 ? `and(${parts.join(",")})` : parts[0];
      });
      parts.push(`or=(${subs.join(",")})`);
    } else if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      pushCond(parts, col, cond as Record<string, unknown>);
    } else {
      // 标量等值
      parts.push(`${col}=eq.${cond instanceof Date ? cond.toISOString() : typeof cond === "bigint" ? cond.toString() : String(cond)}`);
    }
  }
  return parts.join("&");
}

function buildSelect(select: Record<string, boolean> | undefined): string | null {
  if (!select) return null;
  return Object.keys(select).filter((k) => select[k]).join(",");
}

function buildOrder(orderBy: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[] | undefined): string | null {
  if (!orderBy) return null;
  const arr = Array.isArray(orderBy) ? orderBy : [orderBy];
  return arr.map((o) => Object.entries(o).map(([c, d]) => (d === "desc" ? `${c}.desc` : c)).join(",")).join(",");
}

// ─── 模型操作实现 ───────────────────────────────────────────────────────

// DAL 不支持的关系键清单（仅真正的 Prisma 关系名，勿把同名的标量列加进来）：
// 命中时在 select/include 阶段抛错（fail-fast），避免发出 PostgREST 必 400 的查询。
// 注意 ApiKey.providers / RequestLog.provider 是 TEXT 标量列，不在此列。
const UNSUPPORTED_REL = new Set(["account", "accounts"]);

type FindArgs = {
  where?: Where;
  select?: Record<string, boolean>;
  orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[];
  take?: number;
  skip?: number;
  include?: Record<string, boolean>;
};

function assertSupported(table: string, select?: Record<string, boolean>, include?: Record<string, boolean>): void {
  for (const k of Object.keys(select ?? {})) {
    if (UNSUPPORTED_REL.has(k)) throw new Error(`dal ${table}: select 含未支持的关系列 ${k}（PostgREST schema cache 无此 FK）`);
  }
  for (const k of Object.keys(include ?? {})) {
    if (UNSUPPORTED_REL.has(k)) throw new Error(`dal ${table}: include 含未支持的关系 ${k}（PostgREST schema cache 无此 FK）`);
  }
}

// ─── 关系过滤（Prisma { state: { is: {...} } }）─────────────────────────
// PostgREST schema cache 里 Account→AccountState 无 FK，内联嵌入过滤
// （state.disabled=eq.false）不可用。统一翻译成两步查询：
//   1. 查 AccountState 拿符合子条件的 uid 集（空集短路，直接返回 "");
//   2. 主查询拼 uid=in.(...)，调用方 select 未嵌入 state 时按 uid 就地
//      过滤已取回的行。
const REL_FILTER: Record<string, Record<string, { table: string; selfKey: string }>> = {
  Account: { state: { table: "AccountState", selfKey: "uid" } },
};

async function fetchUidSet(
  table: string,
  cols: Record<string, unknown>,
): Promise<{ uids: Set<string> | null; incomplete: boolean }> {
  const uids = new Set<string>();
  const PAGE = 1000;
  let offset = 0;
  for (;;) {
    const rows = await dalFindMany<{ uid: string }>(table, {
      where: cols as Where,
      select: { uid: true },
      take: PAGE,
      skip: offset,
    });
    for (const r of rows) uids.add(String(r.uid));
    if (rows.length < PAGE) return { uids, incomplete: false };
    offset += PAGE;
  }
}

async function resolveRelFilters(
  table: string,
  where: Where | undefined,
  postFilterUids: Set<string>[],
): Promise<{ where: Where | undefined; shortCircuit: boolean }> {
  const defs = REL_FILTER[table];
  if (!where || !defs) return { where, shortCircuit: false };
  const out: Where = {};
  let shortCircuit = false;
  for (const [col, cond] of Object.entries(where)) {
    const def = defs[col];
    const inner = cond && typeof cond === "object" && !(cond instanceof Date)
      ? (cond as Record<string, unknown>).is ?? (cond as Record<string, unknown>).isNot
      : undefined;
    if (!def || inner === undefined || inner === null || typeof inner !== "object") {
      out[col] = cond;
      continue;
    }
    const { uids } = await fetchUidSet(def.table, inner as Record<string, unknown>);
    if (!uids || uids.size === 0) { shortCircuit = true; continue; }
    postFilterUids.push(uids);
    const existing = out[def.selfKey];
    if (existing && typeof existing === "object" && !(existing instanceof Date) &&
        Array.isArray((existing as Record<string, unknown>).in)) {
      const prev = (existing as { in: unknown[] }).in;
      (existing as { in: unknown[] }).in = prev.filter((x) => uids.has(String(x)));
      if ((existing as { in: unknown[] }).in.length === 0) shortCircuit = true;
    } else if (typeof existing === "string") {
      if (!uids.has(existing)) shortCircuit = true;
    } else {
      out[def.selfKey] = { in: [...uids] };
    }
  }
  return { where: out, shortCircuit };
}

// Prisma include 的关系键 → PostgREST 嵌入资源（表名与关系名不同名时需映射）。
// Account 的三组关系（state/cooldowns/costs）是仅有的 include 用点。
const INCLUDE_TABLE: Record<string, string> = {
  state: "AccountState",
  modelCooldowns: "ModelCooldown",
  modelCosts: "ModelCost",
};

function buildSelectWithInclude(
  select: Record<string, boolean> | undefined,
  include: Record<string, boolean> | undefined,
): string | null {
  // select 里混两类：标量列（true）与关系嵌套（{ select: {...} }）。
  // 关系键走嵌入资源语法 rel:Table(cols)，标量列进 base。
  const embeds: string[] = [];
  let baseCols: string[] = [];
  if (select) {
    for (const [k, v] of Object.entries(select)) {
      if (v === true) {
        baseCols.push(k);
      } else if (v && typeof v === "object") {
        const sub = (v as { select?: Record<string, boolean> }).select;
        const cols = sub ? Object.keys(sub).filter((c) => sub[c]).join(",") : "*";
        embeds.push(`${k}:${INCLUDE_TABLE[k] ?? k}(${cols || "*"})`);
      }
    }
  } else {
    baseCols = ["*"];
  }
  if (include) {
    for (const k of Object.keys(include).filter((x) => include[x])) {
      embeds.push(`${k}:${INCLUDE_TABLE[k] ?? k}(*)`);
    }
  }
  const base = baseCols.join(",");
  if (!embeds.length) return select ? base : null;
  return [base, ...embeds].filter(Boolean).join(",");
}

function buildFindUrl(table: string, args: FindArgs = {}): string {
  const q: string[] = [];
  const sel = buildSelectWithInclude(args.select, args.include);
  if (sel) q.push(`select=${sel}`);
  const w = whereToQuery(args.where);
  if (w) q.push(w);
  const ord = buildOrder(args.orderBy);
  if (ord) q.push(`order=${ord}`);
  if (typeof args.take === "number") q.push(`limit=${args.take}`);
  if (typeof args.skip === "number") q.push(`offset=${args.skip}`);
  return `${BASE_URL}/${encodeURIComponent(table)}${q.length ? "?" + q.join("&") : ""}`;
}

async function dalFindMany<T>(table: string, args: FindArgs = {}): Promise<T[]> {
  assertSupported(table, args.select, args.include);
  const postFilterUids: Set<string>[] = [];
  const { where, shortCircuit } = await resolveRelFilters(table, args.where, postFilterUids);
  if (shortCircuit) return [];
  const rows = await http<Record<string, unknown>[]>("GET", buildFindUrl(table, { ...args, where }));
  let out = (rows ?? []).map((r) => decodeRow(r)) as T[];
  if (postFilterUids.length && !hasEmbed(table, args)) {
    const key = PK_COL[table] ?? "id";
    for (const set of postFilterUids) {
      out = out.filter((r) => set.has(String((r as Record<string, unknown>)[key])));
    }
  }
  return out;
}

function hasEmbed(table: string, args: FindArgs): boolean {
  // select/include 显式嵌入了被过滤关系时，PostgREST 返回的父行已按
  // 子表存在性裁剪（inner join 语义由 embed 决定），不再做 uid 就地过滤；
  // 但当前调用点均未嵌入，故默认走过滤。此处只判 include，简单可靠。
  const defs = REL_FILTER[table];
  if (!defs) return false;
  for (const rel of Object.keys(defs)) {
    if (args.include?.[rel]) return true;
    const sel = args.select?.[rel];
    if (sel && typeof sel === "object") return true;
  }
  return false;
}

async function dalFindFirst<T>(table: string, args: FindArgs = {}): Promise<T | null> {
  // 关系过滤 + take:1 时不能先截断再过滤（可能过滤掉唯一匹配行）：
  // 有过滤谓词时退化为拉全量再取首行（Account 表 3k 行内，成本可接受）。
  const hasRel = !!args.where && !!REL_FILTER[table] &&
    Object.keys(args.where).some((k) => REL_FILTER[table]?.[k]);
  if (hasRel) {
    const rows = await dalFindMany<T>(table, { ...args, take: undefined });
    return rows[0] ?? null;
  }
  const rows = await dalFindMany<T>(table, { ...args, take: 1 });
  return rows[0] ?? null;
}

async function dalFindUnique<T>(table: string, args: { where: Where; select?: Record<string, boolean> }): Promise<T | null> {
  return dalFindFirst<T>(table, args);
}

async function dalCreate<T>(table: string, args: { data: Record<string, unknown>; select?: Record<string, boolean> }): Promise<T> {
  const rows = await http<Record<string, unknown>[]>("POST", `${BASE_URL}/${encodeURIComponent(table)}`,
    [encodeRow(withDefaults(table, args.data))], { Prefer: "return=representation" });
  return decodeRow(rows[0]) as T;
}

async function dalCreateMany(table: string, args: { data: Record<string, unknown>[] }): Promise<{ count: number }> {
  const rows = args.data.map((d) => encodeRow(withDefaults(table, d)));
  await http("POST", `${BASE_URL}/${encodeURIComponent(table)}`, rows, { Prefer: "return=minimal" });
  return { count: rows.length };
}

async function dalUpdate<T>(table: string, args: { where: Where; data: Record<string, unknown>; select?: Record<string, boolean> }): Promise<T> {
  const url = `${BASE_URL}/${encodeURIComponent(table)}?${whereToQuery(args.where)}`;
  const rows = await http<Record<string, unknown>[]>("PATCH", url, encodeRow(withUpdateDefaults(table, args.data)), { Prefer: "return=representation" });
  if (!rows.length) throw new Error(`dal update ${table}: 0 rows affected`);
  return decodeRow(rows[0]) as T;
}

async function dalUpdateMany(table: string, args: { where?: Where; data: Record<string, unknown> }): Promise<{ count: number }> {
  const w = whereToQuery(args.where);
  const url = `${BASE_URL}/${encodeURIComponent(table)}${w ? "?" + w : ""}`;
  const rows = await http<Record<string, unknown>[]>("PATCH", url, encodeRow(withUpdateDefaults(table, args.data)), { Prefer: "return=representation" });
  return { count: rows.length };
}

async function dalDelete<T>(table: string, args: { where: Where; select?: Record<string, boolean> }): Promise<T> {
  const url = `${BASE_URL}/${encodeURIComponent(table)}?${whereToQuery(args.where)}`;
  const rows = await http<Record<string, unknown>[]>("DELETE", url, undefined, { Prefer: "return=representation" });
  if (!rows.length) throw new Error(`dal delete ${table}: 0 rows affected`);
  return decodeRow(rows[0]) as T;
}

async function dalDeleteMany(table: string, args: { where?: Where } = {}): Promise<{ count: number }> {
  const w = whereToQuery(args.where);
  const url = `${BASE_URL}/${encodeURIComponent(table)}${w ? "?" + w : ""}`;
  const rows = await http<Record<string, unknown>[]>("DELETE", url, undefined, { Prefer: "return=representation" });
  return { count: rows.length };
}

async function dalUpsert<T>(table: string, args: {
  where: Where;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  select?: Record<string, boolean>;
}): Promise<T> {
  // 先探测冲突列：where 里第一个标量等值键。
  const conflictCol = Object.keys(args.where)[0];
  const row = { ...encodeRow(withDefaults(table, args.create)), ...encodeRow(args.where as Record<string, unknown>) };
  const url = `${BASE_URL}/${encodeURIComponent(table)}?on_conflict=${encodeURIComponent(conflictCol)}`;
  const rows = await http<Record<string, unknown>[]>("POST", url, [row],
    { Prefer: "resolution=merge-duplicates,return=representation" });
  return decodeRow(rows[0]) as T;
}

async function dalCount(table: string, args: { where?: Where } = {}): Promise<number> {
  const w = whereToQuery(args.where);
  const pk = PK_COL[table] ?? "id";
  // 网关对 HEAD / count=exact 都返回 400，且单页上限 1000 行；
  // 分页拉主键列自数（实测全量 UsageEvent 28k 行 ≈ 29 次往返，秒级）。
  const qs = w ? `&${w}` : "";
  let offset = 0, total = 0;
  const PAGE = 1000;
  for (;;) {
    const rows = await http<Record<string, unknown>[]>("GET",
      `${BASE_URL}/${encodeURIComponent(table)}?select=${pk}&limit=${PAGE}&offset=${offset}${qs}`);
    total += rows?.length ?? 0;
    if (!rows || rows.length < PAGE) break;
    offset += PAGE;
  }
  return total;
}

// ─── 聚合（应用层拉行自算）──────────────────────────────────────────────

type UsageEventRow = {
  uid: string; ok: boolean; totalTokens: number; latencyMs: number; tps: number;
  at: Date;
};

async function dalGroupByUsageEvent(args: {
  by: string[];
  where?: Where;
  _count?: { _all: boolean };
  _sum?: Record<string, boolean>;
  _max?: Record<string, boolean>;
  _avg?: Record<string, boolean>;
}): Promise<Record<string, unknown>[]> {
  const rows = await dalFindMany<UsageEventRow>("UsageEvent", {
    where: args.where,
    select: { uid: true, ok: true, totalTokens: true, latencyMs: true, tps: true, at: true },
  });
  const groups = new Map<string, { key: string[]; n: number; sumTok: number; sumLat: number; sumTps: number; maxAt: Date | null }>();
  for (const r of rows) {
    const key = args.by.map((c) => String((r as Record<string, unknown>)[c])).join("");
    let g = groups.get(key);
    if (!g) { g = { key: args.by.map((c) => String((r as Record<string, unknown>)[c])), n: 0, sumTok: 0, sumLat: 0, sumTps: 0, maxAt: null }; groups.set(key, g); }
    g.n++;
    g.sumTok += Number(r.totalTokens) || 0;
    g.sumLat += Number(r.latencyMs) || 0;
    g.sumTps += Number(r.tps) || 0;
    if (!g.maxAt || r.at > g.maxAt) g.maxAt = r.at;
  }
  return [...groups.values()].map((g) => ({
    uid: g.key[0],
    ok: g.key[1] === "true",
    _count: { _all: g.n },
    _sum: { totalTokens: g.sumTok, latencyMs: g.sumLat },
    _max: { at: g.maxAt },
    _avg: { tps: g.n > 0 ? g.sumTps / g.n : 0 },
  }));
}

async function dalAggregateRequestLog(args: {
  _avg?: Record<string, boolean>;
  where?: Where;
}): Promise<{ _avg: Record<string, number | null> }> {
  const rows = await dalFindMany<{ durationMs: number }>("RequestLog", {
    where: args.where,
    select: { durationMs: true },
  });
  const avg: Record<string, number | null> = {};
  if (args._avg?.durationMs) {
    avg.durationMs = rows.length ? rows.reduce((s, r) => s + (Number(r.durationMs) || 0), 0) / rows.length : null;
  }
  return { _avg: avg };
}

// ─── 表级门面（camelCase 名 → 实际表名）────────────────────────────────

const MODEL_TABLE: Record<string, string> = {
  account: "Account",
  accountState: "AccountState",
  modelCooldown: "ModelCooldown",
  modelCost: "ModelCost",
  apiKey: "ApiKey",
  machineKeyAuthorization: "MachineKeyAuthorization",
  provider: "Provider",
  setting: "Setting",
  usageEvent: "UsageEvent",
  requestLog: "RequestLog",
  stickySession: "StickySession",
  loginSession: "LoginSession",
  taskQueueItem: "TaskQueueItem",
  modelProbe: "ModelProbe",
  modelHealthCheck: "ModelHealthCheck",
  balanceSample: "BalanceSample",
};

function makeDelegate(model: string) {
  const table = MODEL_TABLE[model];
  if (!table) throw new Error(`dal: unknown model ${model}`);
  return {
    findMany: (args?: FindArgs) => dalFindMany(table, args),
    findFirst: (args?: FindArgs) => dalFindFirst(table, args),
    findUnique: (args: { where: Where; select?: Record<string, boolean> }) => dalFindUnique(table, args),
    findUniqueOrThrow: async (args: { where: Where; select?: Record<string, boolean> }) => {
      const r = await dalFindUnique(table, args);
      if (!r) throw new Error(`dal ${model}.findUniqueOrThrow: not found`);
      return r;
    },
    create: (args: { data: Record<string, unknown>; select?: Record<string, boolean> }) => dalCreate(table, args),
    createMany: (args: { data: Record<string, unknown>[] }) => dalCreateMany(table, args),
    update: (args: { where: Where; data: Record<string, unknown>; select?: Record<string, boolean> }) => dalUpdate(table, args),
    updateMany: (args: { where?: Where; data: Record<string, unknown> }) => dalUpdateMany(table, args),
    delete: (args: { where: Where; select?: Record<string, boolean> }) => dalDelete(table, args),
    deleteMany: (args?: { where?: Where }) => dalDeleteMany(table, args),
    upsert: (args: { where: Where; create: Record<string, unknown>; update: Record<string, unknown>; select?: Record<string, boolean> }) => dalUpsert(table, args),
    count: (args?: { where?: Where }) => dalCount(table, args),
    ...(model === "usageEvent" ? { groupBy: dalGroupByUsageEvent } : {}),
    ...(model === "requestLog" ? { aggregate: dalAggregateRequestLog } : {}),
  };
}

// ─── 顶层门面 ───────────────────────────────────────────────────────────

const delegates = new Map<string, ReturnType<typeof makeDelegate>>();

export const dal = new Proxy({} as Record<string, ReturnType<typeof makeDelegate>>, {
  get(_t, prop: string) {
    if (prop === "$queryRaw") {
      throw new Error("dal: $queryRaw 不在 PostgREST 翻译范围（usage-query / database 监控保留 Prisma 通道）");
    }
    let d = delegates.get(prop);
    if (!d) { d = makeDelegate(prop); delegates.set(prop, d); }
    return d;
  },
});

export type Dal = typeof dal;
