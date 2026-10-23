// GET /api/panel/request_logs/[id] — 按需读取单条请求日志的大字段详情。
import { fail, ok, panelAuth } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await panelAuth(req);
  if (auth) return auth;

  const { id } = await ctx.params;
  if (!id) return fail(404, "request_log_not_found");

  const entry = await prisma.requestLog.findUnique({ where: { id } });
  if (!entry) return fail(404, "request_log_not_found");
  return ok({ entry });
}
