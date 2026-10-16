// POST .../checkin — 单号签到 + 余额刷新（企业号跳过签到仅刷额度；已签幂等）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import * as pool from "@/lib/pool";
import { dailyCheckin, userResource } from "@/lib/upstream/client";
import { isAlreadyCheckin } from "@/lib/upstream/errors";
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
  const a = authShapeOf(row);

  let checkinMsg = "";
  let checkinDone = false;
  const enterprise = row.enterpriseId !== "";
  if (enterprise || row.realm === "global") {
    // 企业号无签到体系；global 无 CN 签到（注册激活/trial 在登录时已处理）。
    checkinMsg = enterprise ? "企业账号无签到体系（已跳过签到，仅刷新额度）" : "global 域无签到（仅刷新额度）";
  } else {
    try {
      await dailyCheckin(cfg, a);
      await pool.markCheckin(uid);
      checkinDone = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      checkinMsg = msg; // "今天已签到"等业务错误照常查余额
      if (isAlreadyCheckin(msg)) {
        await pool.markCheckin(uid);
        checkinDone = true;
      }
    }
  }

  const resp: Record<string, unknown> = { checkin_done: checkinDone };
  if (enterprise) resp["enterprise"] = true;
  if (checkinMsg) resp["checkin_message"] = checkinMsg;
  try {
    const r = await userResource(cfg, a);
    await pool.setCreditsDetailed(uid, BigInt(r.remain), BigInt(r.total), 0n, 0n, 0n);
    resp["credits"] = r.remain;
    resp["credits_total"] = r.total;
  } catch (e) {
    resp["balance_error"] = e instanceof Error ? e.message : String(e);
  }
  return ok(resp);
}
