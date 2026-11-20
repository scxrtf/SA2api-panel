// GET /api/panel/login/poll — 轮询登录态；完成后凭证落库 + revive + 顺带签到/余额刷新。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import * as pool from "@/lib/pool";
import { loginEndpoints, loginDoJSON, validUID, LoginUpstreamError, LOGIN_TOKEN_PENDING_CODE, LOGIN_ACCOUNT_PENDING_CODE } from "@/lib/login";
import { claimTrial, dailyCheckin, userResource, expiringSoonMs } from "@/lib/upstream/client";
import { globalCompleteRegistration } from "@/lib/upstream/global_register";
import { runlogAccount } from "@/lib/runlog";
import { label } from "@/lib/logfmt";
import { authorizeMachineForAccount, getOrCreateMachineId } from "@/lib/machine-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const state = new URL(req.url).searchParams.get("state") ?? "";
  if (!state) return fail(400, "missing state");
  const sess = await prisma.loginSession.findUnique({ where: { state } });
  if (!sess) return fail(404, "登录会话不存在或已过期（请重新发起添加账号）");
  const expires = Number(sess.expiresAt) || (sess.createdAt ? new Date(sess.createdAt).getTime() + 15 * 60_000 : 0);
  if (expires > 0 && expires <= Date.now()) return fail(404, "登录会话已过期（请重新发起添加账号）");
  const ep = loginEndpoints(sess.realm);
  const cfg = await getConfig();

  // auth/token 是权威登录状态端点：pending 时业务 code 非 0（"login ing"）。
  let tokRaw: unknown;
  try {
    tokRaw = await loginDoJSON("GET", ep.token + encodeURIComponent(state), "", null, ep.origin, cfg, { signal: req.signal });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof LoginUpstreamError && e.code === LOGIN_TOKEN_PENDING_CODE) return ok({ done: false, message });
    return fail(502, "auth token: " + message);
  }
  const tok = tokRaw as {
    accessToken?: string; refreshToken?: string; expiresIn?: number; expiresAt?: number; domain?: string;
  };
  if (typeof tok?.accessToken !== "string" || !tok.accessToken.trim()) return fail(502, "auth token: missing usable accessToken");

  // AccountScoped 登录以 Bearer 从 /account 读取当前账号；12151 表示尚未准备完成。
  let acct: { uid?: string; enterpriseId?: string; nickname?: string } = {};
  try {
    acct = (await loginDoJSON(
      "GET", ep.account, tok.accessToken, null, ep.origin, cfg,
      { domain: typeof tok.domain === "string" ? tok.domain : undefined, signal: req.signal },
    )) as typeof acct;
  } catch (e) {
    if (e instanceof LoginUpstreamError && e.code === LOGIN_ACCOUNT_PENDING_CODE) {
      return ok({ done: false, message: "waiting for account" });
    }
    return fail(502, "account: " + (e instanceof Error ? e.message : String(e)));
  }
  if (typeof acct?.uid !== "string" || !acct.uid) {
    runlogAccount("添加账号失败", "realm=" + sess.realm + ": login done but no uid");
    return fail(502, "login done but no uid（token 已发但账号信息获取失败，请重试）");
  }
  const uid = acct.uid;
  if (!validUID(uid)) {
    runlogAccount("添加账号失败", "realm=" + sess.realm + ": 上游返回的 uid 含非法字符");
    return fail(502, "上游返回的 uid 含非法字符，拒绝落库");
  }
  acct = {
    uid,
    nickname: typeof acct.nickname === "string" ? acct.nickname : "",
    enterpriseId: typeof acct.enterpriseId === "string" ? acct.enterpriseId : "",
  };
  const refreshToken = typeof tok.refreshToken === "string" ? tok.refreshToken : "";
  const domain = typeof tok.domain === "string" ? tok.domain : "";

  const expiresAtSec = typeof tok.expiresAt === "number" && Number.isSafeInteger(tok.expiresAt) && tok.expiresAt > 0
    ? Math.floor(tok.expiresAt / 1000)
    : typeof tok.expiresIn === "number" && Number.isFinite(tok.expiresIn) && tok.expiresIn > 0 && tok.expiresIn < 10 * 365 * 24 * 3600
      ? Math.floor(Date.now() / 1000) + Math.floor(tok.expiresIn) : 0;
  await prisma.account.upsert({
    where: { uid },
    create: {
      uid,
      nickname: acct.nickname ?? "",
      realm: sess.realm,
      enterpriseId: acct.enterpriseId ?? "",
      accessToken: tok.accessToken,
      refreshToken,
      expiresAt: BigInt(expiresAtSec),
      domain,
    },
    update: {
      nickname: acct.nickname ?? "",
      realm: sess.realm,
      enterpriseId: acct.enterpriseId ?? "",
      accessToken: tok.accessToken,
      refreshToken,
      expiresAt: BigInt(expiresAtSec),
      domain,
    },
  });
  // 全新登录 = 人工恢复口径：清掉旧号遗留的禁用/冷却/熔断。
  await pool.revive(uid);
  // 账号已成功落库即视为有效添加；后续签到/余额失败不影响机器授权。
  const machine = await getOrCreateMachineId();
  await authorizeMachineForAccount(machine.id, uid);
  const who = label(uid, acct.nickname ?? "");
  runlogAccount(
    "添加账号",
    who + " realm=" + sess.realm + " 企业=" + (acct.enterpriseId ? "yes" : "no"),
  );

  // 顺带签到 + 余额刷新（幂等；失败不影响登录结果，只体现在返回字段里）。
  const shape = {
    uid, nickname: acct.nickname ?? "", realm: sess.realm,
    accessToken: tok.accessToken, refreshToken,
    expiresAt: expiresAtSec, domain,
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
      const msg = e instanceof Error ? e.message : String(e);
      checkinMsg = joinMsg(checkinMsg, "注册激活失败: " + msg);
      runlogAccount("添加账号", who + " 注册激活失败: " + msg);
    }
    try {
      await claimTrial(cfg, shape);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      checkinMsg = joinMsg(checkinMsg, "trial 领取失败: " + msg);
      runlogAccount("添加账号", who + " trial 领取失败: " + msg);
    }
  } else if (!shape.enterpriseId) {
    try {
      await dailyCheckin(cfg, shape);
      await pool.markCheckin(uid);
      runlogAccount("添加账号", who + " 签到成功");
    } catch (e) {
      checkinMsg = e instanceof Error ? e.message : String(e);
      runlogAccount("添加账号", who + " 签到: " + checkinMsg);
    }
  }
  try {
    const r = await userResource(cfg, shape, expiringSoonMs(cfg.expiring_soon_hours));
    remain = r.remain;
    total = r.total;
    await pool.setCreditsDetailed(
      uid, BigInt(r.remain), BigInt(r.total),
      BigInt(r.expiring), BigInt(r.earliestAt), BigInt(r.earliestRemain),
    );
    runlogAccount("添加账号", who + " 余额 " + r.remain + "/" + r.total);
  } catch (e) {
    // 余额失败不阻塞登录，但要留一行便于排查。
    runlogAccount("添加账号", who + " 余额刷新失败: " + (e instanceof Error ? e.message : String(e)));
  }
  await prisma.loginSession.update({
    where: { state },
    data: { status: "done", uid },
  }).catch(() => undefined);
  await prisma.loginSession.delete({ where: { state } }).catch(() => undefined);
  return ok({
    done: true,
    uid,
    nickname: acct.nickname ?? "",
    realm: sess.realm,
    credits: remain,
    credits_total: total,
    checkin_message: checkinMsg,
  });
}
