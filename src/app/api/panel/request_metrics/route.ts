// GET /api/panel/request_metrics — 请求指标快照（基于 RequestLog 的轻量聚合）。
import { panelAuth, ok } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const since = new Date(Date.now() - 24 * 3600_000);
  const [total, errors, avg] = await Promise.all([
    prisma.requestLog.count({ where: { at: { gte: since } } }),
    prisma.requestLog.count({ where: { at: { gte: since }, status: { gte: 400 } } }),
    prisma.requestLog.aggregate({
      _avg: { durationMs: true },
      where: { at: { gte: since } },
    }),
  ]);
  return ok({
    window_hours: 24,
    total,
    errors,
    ok_count: total - errors,
    avg_duration_ms: Math.round(avg?._avg?.durationMs ?? 0),
  });
}
