// GET /api/panel/login/poll — 轮询登录态；完成后凭证落库 + revive + 顺带签到/余额刷新。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import * as pool from "@/lib/pool";
import { loginEndpoints, loginDoJSON, validUID } from "@/lib/login";
import { claimTrial, dailyCheckin, userResource, expiringSoonMs } from "@/lib/upstream/client";
import { globalCompleteRegistration } from "@/lib/upstream/global_register";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const state = new URL(req.url).searchParams.get("state") ?? "";
  if (!state) return fail(400, "missing state");
  const sess = await prisma.loginSession.findUnique({ where: { state } });
  if (!sess) return fail(404, "unknown or expired state（请重新发起添加账号）");
  const ep = loginEndpoints(sess.realm);

  // auth/token 是权威登录状态端点：pending 时业务 code 非 0（"login ing"）。
  let tokRaw: unknown;
  try {
    tokRaw = await loginDoJSON("GET", ep.token + state, "", null, ep.origin);
  } catch (e) {
    return ok({ done: false, message: e instanceof Error ? e.message : String(e) });
  }
  const tok = tokRaw as {
    accessToken?: string; refreshToken?: string; expiresIn?: number; domain?: string;
  };
  if (!tok?.accessToken) return ok({ done: false, message: "waiting for login" });

  // 完成：取 uid/nickname（失败不阻塞，仅缺展示名）。
  let acct: { uid?: string; enterpriseId?: string; nickname?: string } = {};
  try {
    acct = (await loginDoJSON(
      "GET", ep.account + state, tok.accessToken, null, ep.origin,
    )) as typeof acct;
  } catch {
    // 忽略：仅缺展示名。
  }
  if (!acct.uid) {
    return fail(502, "login done but no uid（token 已发但账号信息获取失败，请重试）");
  }
  if (!validUID(acct.uid)) {
    return fail(502, "上游返回的 uid 含非法字符，拒绝落库");
  }

  const expiresAtSec = Math.floor(Date.now() / 1000) + (tok.expiresIn ?? 0);
  await prisma.account.upsert({
    where: { uid: acct.uid },
    create: {
      uid: acct.uid,
      nickname: acct.nickname ?? "",
      realm: sess.realm,
      enterpriseId: acct.enterpriseId ?? "",
      accessToken: tok.accessToken,
      refreshToken: tok.refreshToken ?? "",
      expiresAt: BigInt(expiresAtSec),
      domain: tok.domain ?? "",
    },
    update: {
      nickname: acct.nickname ?? "",
      realm: sess.realm,
      enterpriseId: acct.enterpriseId ?? "",
      accessToken: tok.accessToken,
      refreshToken: tok.refreshToken ?? "",
      expiresAt: BigInt(expiresAtSec),
      domain: tok.domain ?? "",
    },
  });
  // 全新登录 = 人工恢复口径：清掉旧号遗留的禁用/冷却/熔断。
  await pool.revive(acct.uid);

  // 顺带签到 + 余额刷新（幂等；失败不影响登录结果，只体现在返回字段里）。
  const cfg = await getConfig();
  const shape = {
    uid: acct.uid, nickname: acct.nickname ?? "", realm: sess.realm,
    accessToken: tok.accessToken, refreshToken: tok.refreshToken ?? "",
    expiresAt: expiresAtSec, domain: tok.domain ?? "",
    enterpriseId: acct.enterpriseId ?? "", deviceToken: "",
  };
  let checkinMsg = "";
  let remain = -1;
  let total = 0;
  if (sess.realm === "global") {
    // global 无签到：改注册激活（幂等，region required 时自动补 HK 后重新激活）
    // + trial 加油包（幂等码 14051=已领过）。失败不阻断登录，只体现在消息里。
    const joinMsg = (cur: string, add: string) => (cur ? cur + "; " + add : add);
    try {
      await globalCompleteRegistration(shape);
    } catch (e) {
      checkinMsg = joinMsg(checkinMsg, "注册激活失败: " + (e instanceof Error ? e.message : String(e)));
    }
    try {
      await claimTrial(cfg, shape);
    } catch (e) {
      checkinMsg = joinMsg(checkinMsg, "trial 领取失败: " + (e instanceof Error ? e.message : String(e)));
    }
  } else if (!shape.enterpriseId) {
    try {
      await dailyCheckin(cfg, shape);
      await pool.markCheckin(acct.uid);
    } catch (e) {
      checkinMsg = e instanceof Error ? e.message : String(e);
    }
  }
  try {
    const r = await userResource(cfg, shape, expiringSoonMs(cfg.expiring_soon_hours));
    remain = r.remain;
    total = r.total;
    await pool.setCreditsDetailed(
      acct.uid, BigInt(r.remain), BigInt(r.total),
      BigInt(r.expiring), BigInt(r.earliestAt), BigInt(r.earliestRemain),
    );
  } catch {
    // 余额失败不阻塞登录。
  }
  await prisma.loginSession.update({
    where: { state },
    data: { status: "done", uid: acct.uid },
  }).catch(() => undefined);
  await prisma.loginSession.delete({ where: { state } }).catch(() => undefined);
  return ok({
    done: true,
    uid: acct.uid,
    nickname: acct.nickname ?? "",
    realm: sess.realm,
    credits: remain,
    credits_total: total,
    checkin_message: checkinMsg,
  });
}
