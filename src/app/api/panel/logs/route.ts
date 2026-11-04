// GET /api/panel/logs — 运行日志：进程内任务/系统日志 + 持久化调用/探测状态日志。
import { panelAuth, ok } from "@/lib/panel-auth";
import { listStatusLog } from "@/lib/status-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const q = new URL(req.url).searchParams;
  let limit = parseInt(q.get("limit") ?? "", 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = 200;
  if (limit > 500) limit = 500;
  // since：增量轮询游标（unix 毫秒 / RFC3339）。合法时只回传该时刻之后的行，
  // 面板 60s 轮询不再整页重拉；非法值按全量处理。
  const since = parseSince(q.get("since"));
  return ok({
    entries: await listStatusLog(limit, since ?? undefined),
    limit,
    mode: since ? "delta" : "full",
  });
}

function parseSince(v: string | null): Date | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n > 1e12 ? n : n * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}
