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
  "ModelCooldown", "ModelCost", "ApiKey", "Provider",
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

// CloudBase PostgREST 的 timestamptz 返回无时区 ISO 串（库端会话时区=Asia/Shanghai，
// 返回的是上海墙钟）。JS 规范规定无时区串按本地时区解析——部署容器 TZ=UTC 时会
// 把上海墙钟当 UTC 再转回上海，面板时间整体晚 8 小时（11:50 → 19:50）。
// 修复：无时区后缀的 ISO 串显式补 +08:00，强制按 Asia/Shanghai 墙钟解释；
// 已带 Z / ±HH:MM 后缀的保持原样。
function parseDbDate(v: string): Date {
  return new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(v) ? v : v + "+08:00");
}
const BIGINT_COLS = new Set([
  "expiresAt", "credits", "creditsTotal", "total", "expiring", "earliestAt",
  "earliestRemain", "disabledAt", "degradeUntil", "cooldownUntil", "breakerUntil",
  "lastUsed", "usedSeq", "balanceAt", "lastKeepaliveAt", "until", "observedAt",
  "first", "consumed", "gained",
]);

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
      out[k] = parseDbDate(v);
    } else if (
      // BigInt 列：余额/积分/token 计数等。CloudBase PostgREST 对 int8
      // 在安全范围内返回 number（非字符串），两种形态都要转 BigInt。
      // 已知 BigInt 列名走精确匹配，避免把普通文本/数值误转。
      (typeof v === "number" && Number.isInteger(v) || typeof v === "string" && /^-?\d+$/.test(v)) &&
      BIGINT_COLS.has(k)
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
type Cond = { col?: string; op: string; value?: unknown; children?: Cond[]; logical?: "and" | "or" };

// PostgREST 的过滤值不是 URL 参数值：括号、逗号和引号属于逻辑树语法，反斜杠
// 用于字符串转义。先在逻辑树层构造，再一次性编码，杜绝 split("&") 破坏值。
function scalar(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (value === null) return "null";
  return String(value);
}

function quoteValue(value: unknown): string {
  return `"${scalar(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function filterValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") {
    return scalar(value);
  }
  const raw = scalar(value);
  // CloudBase PostgREST 会把 eq."..." 的引号当作值的一部分，导致 UUID
  // 等值查询查不到已有账号。普通标量保持裸值，仅对 PostgREST 逻辑树
  // 的保留字符、空白和空字符串使用双引号。
  return raw === "" || /[\s(),\"\\]/.test(raw) ? quoteValue(raw) : raw;
}

function likePattern(value: unknown, op: string): string {
  const raw = scalar(value).replace(/([\\%*])/g, "\\$1");
  if (op === "startsWith") return raw + "*";
  if (op === "endsWith") return "*" + raw;
  return "*" + raw + "*";
}

function expandWhere(where: Where | undefined): Where {
  if (!where) return {};
  const out: Where = {};
  for (const [key, value] of Object.entries(where)) {
    if (key === "uid_model" && value && typeof value === "object" && !(value instanceof Date)) {
      const compound = value as Record<string, unknown>;
      out.uid = compound.uid;
      out.model = compound.model;
    } else if (key === "AND" || key === "OR") {
      out[key] = Array.isArray(value) ? value.map((v) => expandWhere(v as Where)) : expandWhere(value as Where);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function fieldConds(col: string, input: unknown): Cond[] {
  if (!input || typeof input !== "object" || input instanceof Date || Array.isArray(input)) {
    return [{ col, op: "eq", value: input }];
  }
  const out: Cond[] = [];
  for (const [rawOp, rawValue] of Object.entries(input as Record<string, unknown>)) {
    if (rawOp === "mode") continue; // Prisma 的辅助修饰符，不是数据库字段或查询参数。
    if (rawOp === "not") {
      if (rawValue === null) {
        out.push({ col, op: "not.is", value: null });
      } else if (rawValue && typeof rawValue === "object" && !(rawValue instanceof Date) && !Array.isArray(rawValue)) {
        const insensitive = (rawValue as Record<string, unknown>).mode === "insensitive";
        for (const [innerOp, innerValue] of Object.entries(rawValue as Record<string, unknown>)) {
          if (innerOp === "mode") continue;
          if (["startsWith", "contains", "endsWith"].includes(innerOp)) {
            out.push({ col, op: `not.${insensitive ? "ilike" : "like"}`, value: likePattern(innerValue, innerOp) });
          } else {
            out.push({ col, op: `not.${innerOp}`, value: innerValue });
          }
        }
      } else {
        out.push({ col, op: "not.eq", value: rawValue });
      }
      continue;
    }
    if (["startsWith", "contains", "endsWith"].includes(rawOp)) {
      const insensitive = (input as Record<string, unknown>).mode === "insensitive";
      out.push({ col, op: insensitive ? "ilike" : "like", value: likePattern(rawValue, rawOp) });
    } else if (rawOp === "in" || rawOp === "notIn") {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      out.push({ col, op: rawOp === "in" ? "in" : "not.in", value: values });
    } else {
      out.push({ col, op: rawOp, value: rawValue });
    }
  }
  return out;
}

function whereTree(where: Where | undefined): Cond[] {
  const out: Cond[] = [];
  for (const [key, value] of Object.entries(expandWhere(where))) {
    if (key === "AND" || key === "OR") {
      const branches = (Array.isArray(value) ? value : [value]).map((v) => whereTree(v as Where));
      const children = key === "OR"
        ? branches.map((branch) => branch.length > 1
          ? { op: "and", logical: "and" as const, children: branch }
          : branch[0]).filter((branch): branch is Cond => !!branch)
        : branches.flat();
      if (children.length) out.push({ op: key === "AND" ? "and" : "or", logical: key === "AND" ? "and" : "or", children });
    } else {
      out.push(...fieldConds(key, value));
    }
  }
  return out;
}

function renderCond(cond: Cond): string {
  if (cond.children) {
    return `${cond.logical}(${cond.children.map(renderCond).join(",")})`;
  }
  const col = cond.col!;
  if (cond.op === "in" || cond.op.endsWith(".in")) {
    // in / not.in 都必须走列表分支，生成 in.("a","b")。
    // 漏掉裸 in 会生成 in."a,b"，解析器报 PGRST100 failed to parse filter。
    return `${col}.${cond.op}.(${(cond.value as unknown[]).map(quoteValue).join(",")})`;
  }
  // 标量类型保持 PostgREST 字面量语义：布尔值必须是不带引号的 true/false，
  // 否则 Postgres 收到的是字符串 '"false"'，对 boolean 列报 22P02。
  // null 只属于 is / not.is；比较操作符保留 PostgREST 原生 null 语义。
  const value = filterValue(cond.value);
  return `${col}.${cond.op}.${value}`;
}

function whereParams(where: Where | undefined): [string, string][] {
  return whereTree(where).map((cond) => {
    if (cond.children) return [cond.logical!, `(${cond.children.map(renderCond).join(",")})`];
    const rendered = renderCond(cond);
    const split = rendered.indexOf(".");
    return [rendered.slice(0, split), rendered.slice(split + 1)];
  });
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
): Promise<{ where: Where | undefined; shortCircuit: boolean }> {
  const defs = REL_FILTER[table];
  if (!where || !defs) return { where, shortCircuit: false };
  const out: Where = {};
  let shortCircuit = false;
  for (const [col, cond] of Object.entries(where)) {
    const def = defs[col];
    const wrapper = cond && typeof cond === "object" && !(cond instanceof Date)
      ? cond as Record<string, unknown> : undefined;
    const negated = wrapper?.isNot !== undefined;
    const inner = wrapper?.is ?? wrapper?.isNot;
    if (!def || inner === undefined || inner === null || typeof inner !== "object") {
      out[col] = cond;
      continue;
    }
    const { uids } = await fetchUidSet(def.table, inner as Record<string, unknown>);
    const matched = uids ?? new Set<string>();
    const existing = out[def.selfKey];
    const current = existing && typeof existing === "object" && !(existing instanceof Date) &&
      Array.isArray((existing as Record<string, unknown>).in)
      ? (existing as { in: unknown[] }).in.map(String)
      : typeof existing === "string" ? [existing] : null;

    if (negated) {
      // isNot：保留关系不满足子条件的父行；空匹配集不排除任何父行。
      // 已有 in 白名单时先移除匹配 uid，否则用 not.in 让数据库排除。
      if (current) {
        const kept = current.filter((uid) => !matched.has(uid));
        if (!kept.length) shortCircuit = true;
        out[def.selfKey] = { in: kept };
      } else if (matched.size) {
        out[def.selfKey] = { notIn: [...matched] };
      }
    } else {
      if (!matched.size) { shortCircuit = true; continue; }
      const kept = current ? current.filter((uid) => matched.has(uid)) : [...matched];
      if (!kept.length) shortCircuit = true;
      out[def.selfKey] = { in: kept };
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
  const search = new URLSearchParams();
  const sel = buildSelectWithInclude(args.select, args.include);
  if (sel) search.set("select", sel);
  for (const [key, value] of whereParams(args.where)) search.append(key, value);
  const ord = buildOrder(args.orderBy);
  if (ord) search.set("order", ord);
  if (typeof args.take === "number") search.set("limit", String(args.take));
  if (typeof args.skip === "number") search.set("offset", String(args.skip));
  const query = search.toString();
  return `${BASE_URL}/${encodeURIComponent(table)}${query ? "?" + query : ""}`;
}

const PAGE_SIZE = 1000;

async function dalFindMany<T>(table: string, args: FindArgs = {}): Promise<T[]> {
  assertSupported(table, args.select, args.include);
  const { where, shortCircuit } = await resolveRelFilters(table, args.where);
  if (shortCircuit) return [];
  const take = args.take;
  const skip = Math.max(0, args.skip ?? 0);
  const bounded = typeof take === "number";
  const wanted = bounded ? Math.max(0, take) : Number.POSITIVE_INFINITY;
  if (wanted === 0) return [];
  const out: T[] = [];
  let offset = skip;
  // 未显式分页时读完整结果，避免聚合/统计静默只算前 1000 行。
  // 显式 take/skip 仍保持 Prisma 的截断语义，仅按网关页大小内部翻页。
  for (;;) {
    const limit = Math.min(PAGE_SIZE, wanted - out.length);
    const rows = await http<Record<string, unknown>[]>("GET", buildFindUrl(table, {
      ...args, where, take: limit, skip: offset,
    }));
    const page = (rows ?? []).map((row) => decodeRow(row) as T);
    out.push(...page);
    if (page.length < limit || out.length >= wanted) break;
    offset += page.length;
  }
  return out;
}

async function dalFindFirst<T>(table: string, args: FindArgs = {}): Promise<T | null> {
  const rows = await dalFindMany<T>(table, { ...args, take: 1 });
  return rows[0] ?? null;
}

async function dalFindUnique<T>(table: string, args: { where: Where; select?: Record<string, boolean> }): Promise<T | null> {
  return dalFindFirst<T>(table, args);
}

function writeUrl(table: string, where?: Where, select?: Record<string, boolean>): string {
  const search = new URLSearchParams(whereParams(where));
  const projection = buildSelectWithInclude(select, undefined);
  if (projection) search.set("select", projection);
  const query = search.toString();
  return `${BASE_URL}/${encodeURIComponent(table)}${query ? "?" + query : ""}`;
}

async function dalCreate<T>(table: string, args: { data: Record<string, unknown>; select?: Record<string, boolean> }): Promise<T> {
  const rows = await http<Record<string, unknown>[]>("POST", writeUrl(table, undefined, args.select),
    [encodeRow(withDefaults(table, args.data))], { Prefer: "return=representation" });
  return decodeRow(rows[0]) as T;
}

async function dalCreateMany(table: string, args: { data: Record<string, unknown>[] }): Promise<{ count: number }> {
  const rows = args.data.map((d) => encodeRow(withDefaults(table, d)));
  await http("POST", `${BASE_URL}/${encodeURIComponent(table)}`, rows, { Prefer: "return=minimal" });
  return { count: rows.length };
}

async function dalUpdate<T>(table: string, args: { where: Where; data: Record<string, unknown>; select?: Record<string, boolean> }): Promise<T> {
  const url = writeUrl(table, args.where, args.select);
  const rows = await http<Record<string, unknown>[]>("PATCH", url, encodeRow(withUpdateDefaults(table, args.data)), { Prefer: "return=representation" });
  if (!rows.length) throw new Error(`dal update ${table}: 0 rows affected`);
  return decodeRow(rows[0]) as T;
}

async function dalUpdateMany(table: string, args: { where?: Where; data: Record<string, unknown> }): Promise<{ count: number }> {
  const url = writeUrl(table, args.where);
  const rows = await http<Record<string, unknown>[]>("PATCH", url, encodeRow(withUpdateDefaults(table, args.data)), { Prefer: "return=representation" });
  return { count: rows.length };
}

async function dalDelete<T>(table: string, args: { where: Where; select?: Record<string, boolean> }): Promise<T> {
  const url = writeUrl(table, args.where, args.select);
  const rows = await http<Record<string, unknown>[]>("DELETE", url, undefined, { Prefer: "return=representation" });
  if (!rows.length) throw new Error(`dal delete ${table}: 0 rows affected`);
  return decodeRow(rows[0]) as T;
}

async function dalDeleteMany(table: string, args: { where?: Where } = {}): Promise<{ count: number }> {
  const url = writeUrl(table, args.where);
  const rows = await http<Record<string, unknown>[]>("DELETE", url, undefined, { Prefer: "return=representation" });
  return { count: rows.length };
}

async function dalUpsert<T>(table: string, args: {
  where: Where;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  select?: Record<string, boolean>;
}): Promise<T> {
  // 先合并 create/update，再交给数据库单语句 UPSERT。现有调用方的 create 与 update
  // 冲突字段值一致；以 update 为准可保持 Prisma 对已有行的覆盖语义。
  // 数据库原子处理并发插入，彻底消除「查无此行 → 并发 INSERT → 409」窗口。
  const row = { ...args.create, ...args.update };
  const search = new URL(writeUrl(table, undefined, args.select));
  const conflictCols = Object.keys(expandWhere(args.where)).filter((key) => key !== "AND" && key !== "OR");
  if (conflictCols.length) search.searchParams.set("on_conflict", conflictCols.join(","));
  const rows = await http<Record<string, unknown>[]>("POST", search.toString(),
    [encodeRow(withDefaults(table, row))],
    { Prefer: "resolution=merge-duplicates,return=representation" });
  return decodeRow(rows[0]) as T;
}

async function dalCount(table: string, args: { where?: Where } = {}): Promise<number> {
  const pk = PK_COL[table] ?? "id";
  // 网关对 HEAD / count=exact 都返回 400，且单页上限 1000 行；
  // 分页拉主键列自数（实测全量 UsageEvent 28k 行 ≈ 29 次往返，秒级）。
  let offset = 0, total = 0;
  const PAGE = PAGE_SIZE;
  for (;;) {
    const url = buildFindUrl(table, { where: args.where, select: { [pk]: true }, take: PAGE, skip: offset });
    const rows = await http<Record<string, unknown>[]>("GET", url);
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


