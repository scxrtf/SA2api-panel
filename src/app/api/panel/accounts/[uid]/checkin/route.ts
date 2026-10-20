// POST .../checkin — 单号签到 + 余额刷新（企业号跳过签到仅刷额度；已签幂等）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import * as pool from "@/lib/pool";
import { dailyCheckin, userResource, expiringSoonMs } from "@/lib/upstream/client";
import { isAlreadyCheckin } from "@/lib/upstream/errors";
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
  const a = authShapeOf(row);
  const who = label(row.uid, row.nickname);

  let checkinMsg = "";
  let checkinDone = false;
  const enterprise = row.enterpriseId !== "";
  if (enterprise || row.realm === "global") {
    // 企业号无签到体系；global 无 CN 签到（注册激活/trial 在登录时已处理）。
    checkinMsg = enterprise ? "企业账号无签到体系（已跳过签到，仅刷新额度）" : "global 域无签到（仅刷新额度）";
    runlogAccount("签到", who + ": " + checkinMsg);
  } else {
    try {
      await dailyCheckin(cfg, a);
      await pool.markCheckin(uid);
      checkinDone = true;
      runlogAccount("签到", who + ": 成功");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      checkinMsg = msg; // "今天已签到"等业务错误照常查余额
      if (isAlreadyCheckin(msg)) {
        await pool.markCheckin(uid);
        checkinDone = true;
        runlogAccount("签到", who + ": 今天已签到");
      } else {
        runlogAccount("签到", who + ": 失败 " + msg);
      }
    }
  }

  const resp: Record<string, unknown> = { checkin_done: checkinDone };
  if (enterprise) resp["enterprise"] = true;
  if (checkinMsg) resp["checkin_message"] = checkinMsg;
  try {
    const r = await userResource(cfg, a, expiringSoonMs(cfg.expiring_soon_hours));
    await pool.setCreditsDetailed(
      uid, BigInt(r.remain), BigInt(r.total),
      BigInt(r.expiring), BigInt(r.earliestAt), BigInt(r.earliestRemain),
    );
    resp["credits"] = r.remain;
    resp["credits_total"] = r.total;
    runlogAccount("余额刷新", who + ": " + r.remain + "/" + r.total);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    resp["balance_error"] = msg;
    runlogAccount("余额刷新失败", who + ": " + msg);
  }
  return ok(resp);
}
