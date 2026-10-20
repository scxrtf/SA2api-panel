// POST .../balance — 单号余额刷新（更新余额快照，不触碰冷却状态）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import * as pool from "@/lib/pool";
import { userResource, expiringSoonMs } from "@/lib/upstream/client";
import { authShapeOf } from "@/lib/login";
import { runlogAccount } from "@/lib/runlog";
import { label } from "@/lib/logfmt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ uid: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const row = await prisma.account.findUnique({ where: { uid } });
  if (!row) return fail(404, "account not found");
  const cfg = await getConfig();
  const who = label(row.uid, row.nickname);
  try {
    const r = await userResource(cfg, authShapeOf(row), expiringSoonMs(cfg.expiring_soon_hours));
    await pool.setCreditsDetailed(
      uid, BigInt(r.remain), BigInt(r.total),
      BigInt(r.expiring), BigInt(r.earliestAt), BigInt(r.earliestRemain),
    );
    runlogAccount("余额刷新", who + ": " + r.remain + "/" + r.total);
    return ok({ credits: r.remain, credits_total: r.total });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    runlogAccount("余额刷新失败", who + ": " + msg);
    return fail(502, "user resource: " + msg);
  }
}
