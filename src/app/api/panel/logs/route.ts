// GET /api/panel/logs — 进程内运行日志（Next 版暂以最近 RequestLog 充当运行日志视图）。
import { panelAuth, ok } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const rows = await prisma.requestLog.findMany({
    orderBy: { id: "desc" },
    take: 200,
  });
  const entries = rows.reverse().map((r) => ({
    ts: r.at,
    channel: "chat",
    line:
      (r.status < 400 ? "OK " : "ERR") +
      " " + r.status + " " + (r.model || "-") +
      " uid=" + (r.uid || "-") +
      (r.errKind ? " kind=" + r.errKind : "") +
      " " + r.durationMs + "ms",
  }));
  return ok({ entries });
}
