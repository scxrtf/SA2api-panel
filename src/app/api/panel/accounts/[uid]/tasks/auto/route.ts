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

import {
  autoActionFor, isMPTaskCode, taskByCode, taskByCodeMP, taskByCodeWaiting, taskProgressText,
} from "@/lib/autotask";
import { tryLockAccount, unlockAccount, claimTaskReward } from "@/lib/taskcenter";

// POST 一键完成单个任务：执行动作 → 回读 → 达标自动领奖（对齐 accountTaskAuto）。
export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { uid } = await ctx.params;
  const a = await loadAuth(uid);
  if (!a) return fail(404, "account not found");
  let body: { task_code?: string };
  try { body = await req.json(); } catch { return fail(400, "task_code required"); }
  if (!body.task_code) return fail(400, "task_code required");
  const act = autoActionFor(body.task_code);
  if (!act) {
    return fail(501, "该任务需要客户端内交互（无对应接口），无法自动完成；请按任务说明在官方客户端操作");
  }
  // per-account 互斥：同账号任务动作在跑时 409。
  if (!tryLockAccount(uid)) {
    return fail(409, "该账号有任务动作正在执行中，请等本轮结束后再试");
  }
  try {
    const cfg = await getConfig();
    const before = await taskByCode(cfg, a, act.taskCode);
    if (before == null) return fail(404, "该账号没有此任务");
    if (before.claimed) {
      return ok({ skipped: true, message: "该任务已领取过奖励" });
    }
    const mp = isMPTaskCode(act.taskCode);
    let msg: string;
    try {
      msg = await act.run(cfg, a);
    } catch (e) {
      return fail(502, "执行失败: " + (e instanceof Error ? e.message : String(e)));
    }
    const after = mp ? await taskByCodeMP(cfg, a, act.taskCode).catch(() => null)
      : await taskByCodeWaiting(cfg, a, act.taskCode).catch(() => null);
    const resp: Record<string, unknown> = {
      message: msg,
      progress_before: taskProgressText(before),
      progress_after: after ? taskProgressText(after) : "",
      claimable: after?.claimable ?? false,
      attempt: act.attempt,
      verify_supported: true,
    };
    if (after?.claimable) {
      try {
        const r = await claimTaskReward(cfg, a, act.taskCode);
        resp["claimed"] = true;
        resp["credit"] = r.credit;
        resp["energy"] = r.energy;
        resp["message"] = (r.credit > 0 || r.energy > 0)
          ? msg + "；已自动领奖 +" + r.credit + " 分 +" + r.energy + " 能"
          : msg + "；奖励此前已领取";
      } catch (e) {
        resp["claim_error"] = e instanceof Error ? e.message : String(e);
        resp["message"] = msg + "；达标但领奖失败，可在任务列表手动点「领取」重试";
      }
    }
    return ok(resp);
  } finally {
    unlockAccount(uid);
  }
}
