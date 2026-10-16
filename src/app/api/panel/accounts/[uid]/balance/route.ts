// POST .../balance — 单号余额刷新（更新余额快照，不触碰冷却状态）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import * as pool from "@/lib/pool";
import { userResource } from "@/lib/upstream/client";
import { authShapeOf } from "@/lib/login";

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
  try {
    const r = await userResource(cfg, authShapeOf(row));
    await pool.setCreditsDetailed(uid, BigInt(r.remain), BigInt(r.total), 0n, 0n, 0n);
    return ok({ credits: r.remain, credits_total: r.total });
  } catch (e) {
    return fail(502, "user resource: " + (e instanceof Error ? e.message : String(e)));
  }
}
