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

import { runAutoAll } from "@/lib/autotask";
import { tryLockAccount, unlockAccount } from "@/lib/taskcenter";
import { runlogAccount } from "@/lib/runlog";
import { label } from "@/lib/logfmt";

// POST 一键完成该账号全部可自动任务（逐项执行，单项失败不阻塞）。
export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  if (!tryLockAccount(uid)) {
    return fail(409, "该账号有任务动作正在执行中，请等本轮结束后再试");
  }
  try {
    const results = await runAutoAll(await getConfig(), a);
    const done = results.filter((r) => r.status === "done").length;
    const failed = results.filter((r) => r.status === "error").length;
    runlogAccount(
      "自动全部任务",
      label(a.uid, a.nickname) + " done=" + done + " error=" + failed,
    );
    return ok({ results });
  } finally {
    unlockAccount(uid);
  }
}
