import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { startGrowthQueue } from "@/lib/taskcenter";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST 启动执行队列：{concurrency:1-4, growth:bool}（对齐 tasksRunQueue）。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let body: { concurrency?: number; growth?: boolean } = {};
  try { body = await req.json(); } catch { /* 空 body 用默认 */ }
  const growth = body.growth ?? true;
  const r = await startGrowthQueue(body.concurrency ?? 1, growth);
  if (r.seq === -1) return fail(409, r.msg);
  if (!r.started) return ok({ started: false, message: r.msg });
  return ok({ started: true, total: r.total, seq: r.seq });
}
