import { panelAuth, ok } from "@/lib/panel-auth";
import { queueStatus } from "@/lib/taskcenter";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET 队列状态（轮询用；对齐 tasksQueueStatus）。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const s = queueStatus();
  return ok({
    running: s.running,
    total: s.total,
    conc: s.conc,
    started: s.started,
    started_at: s.started_at,
    seq: s.seq,
    items: s.items,
  });
}
