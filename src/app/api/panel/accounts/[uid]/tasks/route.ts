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

import { mergedTaskList } from "@/lib/taskcenter";

// GET 查询单账号全量任务（默认口径 + mp 口径合并去重）。
export async function GET(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  try {
    const tasks = await mergedTaskList(await getConfig(), a);
    return ok({ tasks });
  } catch (e) {
    return fail(502, "list tasks: " + (e instanceof Error ? e.message : String(e)));
  }
}
