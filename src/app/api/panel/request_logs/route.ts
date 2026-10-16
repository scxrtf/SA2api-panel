// GET /api/panel/request_logs — RequestLog 分页/过滤（limit 默认 200 上限 1000）。
import { panelAuth, ok } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const q = new URL(req.url).searchParams;
  let limit = parseInt(q.get("limit") ?? "", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  if (limit > 1000) limit = 1000;

  const where: Record<string, unknown> = {};
  const uid = q.get("account") ?? "";
  if (uid) where["uid"] = { contains: uid };
  const model = q.get("model") ?? "";
  if (model) where["model"] = { contains: model };
  const clientIp = q.get("client_ip") ?? "";
  if (clientIp) where["clientIp"] = { contains: clientIp };
  const ua = q.get("user_agent") ?? "";
  if (ua) where["ua"] = { contains: ua };
  const outcome = q.get("outcome") ?? "";
  if (outcome === "ok") where["status"] = { lt: 400 };
  else if (outcome === "error") where["status"] = { gte: 400 };

  const from = parseTime(q.get("from"));
  const to = parseTime(q.get("to"));
  if (from || to) {
    where["at"] = {};
    if (from) (where["at"] as Record<string, unknown>)["gte"] = from;
    if (to) (where["at"] as Record<string, unknown>)["lte"] = to;
  }

  const rows = await prisma.requestLog.findMany({
    where,
    orderBy: { id: "desc" },
    take: limit,
  });
  return ok({ entries: rows, limit });
}

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
