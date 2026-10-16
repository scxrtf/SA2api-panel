// GET /api/panel/logs — 进程内运行日志环形缓冲（对齐 Go /panel/api/logs）。
import { panelAuth, ok } from "@/lib/panel-auth";
import { runlogSnapshot } from "@/lib/runlog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  return ok({ entries: runlogSnapshot() });
}
