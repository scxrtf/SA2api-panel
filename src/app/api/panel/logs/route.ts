// GET /api/panel/logs — 运行日志：进程内任务/系统日志 + 持久化调用/探测状态日志。
import { panelAuth, ok } from "@/lib/panel-auth";
import { listStatusLog } from "@/lib/status-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let limit = parseInt(new URL(req.url).searchParams.get("limit") ?? "", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 500;
  if (limit > 1000) limit = 1000;
  return ok({ entries: await listStatusLog(limit), limit });
}
