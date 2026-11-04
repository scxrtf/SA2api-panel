// GET /api/panel/request_logs — RequestLog 分页/过滤（limit 默认 50 上限 500）。
import { panelAuth, ok } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";

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
  const auth = await panelAuth(req);
  if (auth) return auth;
  const q = new URL(req.url).searchParams;
  let limit = parseInt(q.get("limit") ?? "", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 50;
  if (limit > 500) limit = 500;

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

  const rows = await prisma.requestLog.findMany({
    where,
    select: listSelect,
    orderBy: since ? [{ at: "asc" }, { id: "asc" }] : [{ at: "desc" }, { id: "desc" }],
    take: limit,
  });
  // 列表侧截断 errMsg：上游报错正文常带整段 JSON/HTML，单条可达数 KB。
  // 面板只用它做行内提示，完整原文在 GET /request_logs/[id] 的 errorDetail。
  const entries = rows.map((row) => ({
    ...row,
    errMsg: row.errMsg.length > LIST_ERR_MSG_MAX
      ? row.errMsg.slice(0, LIST_ERR_MSG_MAX) + "…（详情页看全文）"
      : row.errMsg,
  }));
  return ok({ entries, limit, mode: since ? "delta" : "full" });
}

const LIST_ERR_MSG_MAX = 512;

// parseTime 兼容 unix 秒/毫秒 与 RFC3339；非法值不设界。
function parseTime(v: string | null): Date | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) {
    return new Date(n > 1e12 ? n : n * 1000);
  }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}
