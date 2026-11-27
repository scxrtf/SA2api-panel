// GET /api/panel/request_logs — RequestLog 分页/过滤（limit 默认 50 上限 500）。
import { cbRpc, isCloudbaseRestEnabled } from "@/lib/cloudbase-rest";
import { ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import type { RequestLogSession } from "@/lib/request-log-sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 列表只取表格与展开摘要需要的字段。对话、错误原文、参数覆盖和尝试明细
// 可能很大，统一由 GET /api/panel/request_logs/[id] 按需读取。
const listSelect = {
  id: true,
  at: true,
  uid: true,
  model: true,
  realm: true,
  provider: true,
  status: true,
  errKind: true,
  errMsg: true,
  stream: true,
  durationMs: true,
  ttfbMs: true,
  attempts: true,
  promptTokens: true,
  completionTok: true,
  totalTokens: true,
  credit: true,
  hasCredit: true,
  cacheHitTok: true,
  cacheMissTok: true,
  clientIp: true,
  ua: true,
  keyName: true,
  slot: true,
  machineId: true,
  path: true,
} as const;

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  let limit = parseInt(q.get("limit") ?? "", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 500) limit = 500;
  if (q.get("view") === "sessions" || q.has("group")) return sessionPage(q, Math.min(100, limit));

  const where: Record<string, unknown> = {};
  const uid = q.get("account") ?? "";
  // 账号过滤是前缀输入，用 startsWith 走 [uid, at] 索引；contains 会退化成全表扫描。
  if (uid) where["uid"] = { startsWith: uid };
  const model = q.get("model") ?? "";
  // 模型名是前缀输入（gpt / claude / gemini …），startsWith 走 [model, at]；
  // contains 无法命中 btree，会把过滤退化成全表扫描并整行回传。
  if (model) where["model"] = { startsWith: model };
  const clientIp = q.get("client_ip") ?? "";
  if (clientIp) where["clientIp"] = { contains: clientIp };
  const ua = q.get("user_agent") ?? "";
  if (ua) where["ua"] = { contains: ua };
  const outcome = q.get("outcome") ?? "";
  // HTTP 200 开流后仍可能返回错误帧，结果不能只看响应头状态码。
  if (outcome === "ok") {
    where["status"] = { lt: 400 };
    where["errKind"] = "";
  } else if (outcome === "error") {
    where["OR"] = [{ status: { gte: 400 } }, { errKind: { not: "" } }];
  }
  const key = q.get("key") ?? "";
  // key 名同理按前缀匹配，走 [keyName, at]。
  if (key) where["keyName"] = { startsWith: key };
  // 报错内容过滤：按上游响应正文/网关报错片段检索（如 12153、rate limit、WAF）。
  const err = q.get("err") ?? "";
  if (err) where["errMsg"] = { contains: err, mode: "insensitive" };

  // since：增量轮询游标。合法时只回传该时刻之后的行（升序取满 limit），
  // 面板 60s 轮询在无过滤时不再整页重拉 50 行 × 27 字段。
  const since = parseTime(q.get("since"));
  const from = parseTime(q.get("from"));
  const to = parseTime(q.get("to"));
  // 列表页默认只看最近 7 天；无时间界时全表倒序会随日志增长线性放大扫描与回传。
  const at: Record<string, unknown> = {
    gte: since ?? from ?? new Date(Date.now() - 7 * 86400_000),
  };
  if (to) at["lte"] = to;
  where["at"] = at;

  const requestedPage = parseInt(q.get("page") ?? "", 10);
  if (q.has("page")) {
    const pageSize = limit;
    const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
    const [total, rows] = await Promise.all([
      prisma.requestLog.count({ where }),
      prisma.requestLog.findMany({
        where,
        select: listSelect,
        orderBy: [{ at: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const entries = rows.map(clipListEntry);
    return ok({ entries, total, page, pageSize, totalPages, limit, mode: "page" });
  }

  const rows = await prisma.requestLog.findMany({
    where,
    select: listSelect,
    orderBy: since ? [{ at: "asc" }, { id: "asc" }] : [{ at: "desc" }, { id: "desc" }],
    take: limit,
  });
  // 列表侧截断 errMsg：上游报错正文常带整段 JSON/HTML，单条可达数 KB。
  // 面板只用它做行内提示，完整原文在 GET /request_logs/[id] 的 errorDetail。
  const entries = rows.map(clipListEntry);
  return ok({ entries, limit, mode: since ? "delta" : "full" });
}

const LIST_ERR_MSG_MAX = 512;

function clipListEntry<T extends { errMsg: string }>(row: T) {
  return {
    ...row,
    errMsg: row.errMsg.length > LIST_ERR_MSG_MAX
      ? row.errMsg.slice(0, LIST_ERR_MSG_MAX) + "…（详情页看全文）"
      : row.errMsg,
  };
}

type SessionPageResult<T> = { total: number; entries: T[] };

async function sessionPage(q: URLSearchParams, pageSize: number) {
  const group = q.get("group");
  const singleRequest = group?.startsWith("r:") && group.length > 2 && group.length <= 514 && !group.includes("\0");
  if (group !== null && !singleRequest && !/^s:[0-9a-f]{32}$/.test(group)) {
    return fail(400, "会话标识无效");
  }
  const requestedPage = Number(q.get("page"));
  const page = Number.isSafeInteger(requestedPage) ? Math.max(1, Math.min(1_000_000, requestedPage)) : 1;
  const now = Date.now();
  const scope = {
    from: (parseTime(q.get("from")) ?? new Date(now - 7 * 86400_000)).toISOString(),
    to: (parseTime(q.get("to")) ?? new Date(now)).toISOString(),
  };
  const filters = Object.fromEntries(["account", "model", "client_ip", "user_agent", "key", "err", "outcome"]
    .map((name) => [name, (q.get(name) ?? "").replace(/\0/g, "")]));
  const offset = (page - 1) * pageSize;
  const read = async <T>(): Promise<SessionPageResult<T>> => {
    if (isCloudbaseRestEnabled()) {
      return cbRpc<SessionPageResult<T>>("wb2_request_log_session_page", {
        p_filters: filters, p_from: scope.from, p_to: scope.to, p_limit: pageSize, p_offset: offset, p_group: group,
        // See parseDbDate in dal.ts: CloudBase's timezone-less values represent Shanghai wall time.
        p_storage_zone: "Asia/Shanghai",
      });
    }
    const [{ result }] = await prisma.$queryRaw<{ result: SessionPageResult<T> }[]>`
      SELECT public.wb2_request_log_session_page(${JSON.stringify(filters)}::jsonb, ${scope.from}::timestamp,
        ${scope.to}::timestamp, ${pageSize}::integer, ${offset}::integer, ${group}::text, 'UTC'::text) AS result`;
    return result;
  };
  const pageInfo = (total: number) => ({ page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), scope });
  try {
    if (group === null) {
      const { total, entries } = await read<RequestLogSession>();
      return ok({ ...pageInfo(total), entries });
    }
    const { total, entries: ids } = await read<string>();
    const rows = ids.length === 0 ? [] : await prisma.requestLog.findMany({
      where: { id: { in: ids } }, select: listSelect, orderBy: [{ at: "desc" }, { id: "desc" }], take: pageSize,
    });
    return ok({ ...pageInfo(total), entries: rows.map(clipListEntry) });
  } catch {
    // Do not send raw SQL/service errors to the panel. The original request view is independent.
    return fail(503, "会话日志暂不可用，请重试或检查数据库会话迁移是否已应用。");
  }
}

// parseTime 兼容 unix 秒/毫秒 与 RFC3339；非法值不设界。
function parseTime(v: string | null): Date | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    const date = new Date(n > 1e12 ? n : n * 1000);
    return Number.isFinite(date.getTime()) ? date : null;
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}
