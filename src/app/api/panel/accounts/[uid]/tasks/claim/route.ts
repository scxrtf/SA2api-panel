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

import { claimTaskReward } from "@/lib/taskcenter";
import { runlogAccount } from "@/lib/runlog";
import { label } from "@/lib/logfmt";

// POST 领取任务奖励（未达标时上游业务错误原样透出；mp 码走 mp 口径）。
export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  let body: { task_code?: string };
  try { body = await req.json(); } catch { return fail(400, "task_code required"); }
  if (!body.task_code) return fail(400, "task_code required");
  try {
    const r = await claimTaskReward(await getConfig(), a, body.task_code);
    if (r.credit === 0 && r.energy === 0) {
      runlogAccount("领取奖励", label(a.uid, a.nickname) + " " + body.task_code + ": 此前已领取");
      return ok({ already_claimed: true, message: "该奖励此前已领取" });
    }
    runlogAccount(
      "领取奖励",
      label(a.uid, a.nickname) + " " + body.task_code + ": +" + r.credit + " 分 +" + r.energy + " 能",
    );
    return ok({ credit: r.credit, energy: r.energy });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    runlogAccount("领取奖励失败", label(a.uid, a.nickname) + " " + body.task_code + ": " + msg);
    return fail(502, "claim: " + msg);
  }
}
