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

import { taskAcceptAll } from "@/lib/taskcenter";
import { runlogAccount } from "@/lib/runlog";
import { label } from "@/lib/logfmt";

// POST 接受该账号全部尚未接受的任务（分片 20/批节流；mp 码单独 mp 口径）。
export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  try {
    const r = await taskAcceptAll(await getConfig(), a);
    const who = label(a.uid, a.nickname);
    runlogAccount("接受全部任务", who + " accepted=" + r.accepted + " failed=" + r.failed.length);
    const resp: Record<string, unknown> = { accepted: r.accepted, failed: r.failed };
    if (r.accepted === 0 && r.failed.length === 0) {
      return ok({ accepted: 0, message: "所有任务均已接受" });
    }
    if (r.failed.length > 0) resp["message"] = "部分任务接受失败（上游拒绝），可重试";
    return ok(resp);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    runlogAccount("接受全部任务失败", label(a.uid, a.nickname) + ": " + msg);
    return fail(502, "list tasks: " + msg);
  }
}
