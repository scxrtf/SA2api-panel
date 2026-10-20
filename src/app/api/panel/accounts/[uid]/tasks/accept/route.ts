import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { authShapeOf } from "@/lib/login";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ uid: string }> };
// loadAuth 取账号凭证；不存在时写 404 并返回 null（对齐 accountByUID）。
async function loadAuth(uid: string) {
  const row = await prisma.account.findUnique({ where: { uid } });
  if (!row) return null;
  return authShapeOf(row);
}

import { acceptTasks } from "@/lib/upstream/tasks";
import { runlogAccount } from "@/lib/runlog";
import { label } from "@/lib/logfmt";

// POST 接受任务（报名；幂等）。body: {task_codes: [...]}。
export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  let body: { task_codes?: string[] };
  try { body = await req.json(); } catch { return fail(400, "task_codes required"); }
  if (!body.task_codes || body.task_codes.length === 0) return fail(400, "task_codes required");
  try {
    await acceptTasks(await getConfig(), a, body.task_codes);
    runlogAccount("接受任务", label(a.uid, a.nickname) + ": " + body.task_codes.join(","));
    return ok();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    runlogAccount("接受任务失败", label(a.uid, a.nickname) + ": " + msg);
    return fail(502, "accept: " + msg);
  }
}
