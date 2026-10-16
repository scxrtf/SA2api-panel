// cron 任务公共逻辑（供 /api/cron/* 与面板手动触发复用）。
// 外部调度（cron-job.org / Railway Cron 插件）打 HTTP 触发；Bearer 校验在路由层。
import { prisma } from "./db";
import { getConfig } from "./config";
import * as pool from "./pool";
import {
  dailyCheckin,
  refreshToken,
  needsRefresh,
  userResource,
  type AuthShape,
} from "./upstream/client";
import { isAlreadyCheckin } from "./upstream/errors";

function shapeOf(a: {
  uid: string; nickname: string; realm: string; accessToken: string;
  refreshToken: string; expiresAt: bigint; domain: string; enterpriseId: string;
  deviceToken: string;
}): AuthShape {
  return {
    uid: a.uid, nickname: a.nickname, realm: a.realm,
    accessToken: a.accessToken, refreshToken: a.refreshToken,
    expiresAt: Number(a.expiresAt), domain: a.domain,
    enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
  };
}

// runCheckin 全量签到：仅 CN 非企业号；已签到幂等。09:00/21:00（Asia/Shanghai）由外部调度。
export async function runCheckin(): Promise<{ done: number; already: number; failed: number }> {
  const cfg = await getConfig();
  const accounts = await prisma.account.findMany({ include: { state: true } });
  let done = 0, already = 0, failed = 0;
  for (const a of accounts) {
    if (a.state?.disabled || a.realm === "global" || a.enterpriseId !== "") continue;
    try {
      await dailyCheckin(cfg, shapeOf(a));
      await pool.markCheckin(a.uid);
      done++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isAlreadyCheckin(msg)) {
        await pool.markCheckin(a.uid);
        already++;
      } else {
        failed++;
      }
    }
  }
  return { done, already, failed };
}

// runKeepalive 全量 token 保活：临近过期窗口内走 refreshToken（失败冷却记连败）。
export async function runKeepalive(): Promise<{ refreshed: number; skipped: number; failed: number }> {
  const cfg = await getConfig();
  const accounts = await prisma.account.findMany({ include: { state: true } });
  let refreshed = 0, skipped = 0, failed = 0;
  for (const a of accounts) {
    if (a.state?.disabled || !a.refreshToken) continue;
    const shape = shapeOf(a);
    if (!needsRefresh(shape, cfg.refresh_skew_sec * 12)) {
      skipped++;
      continue;
    }
    try {
      const patch = await refreshToken(cfg, shape);
      await prisma.account.update({
        where: { uid: a.uid },
        data: {
          accessToken: patch.accessToken ?? a.accessToken,
          refreshToken: patch.refreshToken ?? a.refreshToken,
          expiresAt: BigInt(patch.expiresAt ?? 0 > 0 ? patch.expiresAt! : Number(a.expiresAt)),
          domain: patch.domain ?? a.domain,
        },
      });
      refreshed++;
    } catch {
      await pool.noteError(cfg, a.uid);
      failed++;
    }
  }
  return { refreshed, skipped, failed };
}

// runBalanceRefresh 全量余额刷新（写回 credits 快照，含解冻语义）。
export async function runBalanceRefresh(): Promise<{ updated: number; failed: number }> {
  const cfg = await getConfig();
  const accounts = await prisma.account.findMany({ include: { state: true } });
  let updated = 0, failed = 0;
  for (const a of accounts) {
    if (a.state?.disabled || !a.accessToken) continue;
    try {
      const r = await userResource(cfg, shapeOf(a));
      await pool.setCreditsDetailed(a.uid, BigInt(r.remain), BigInt(r.total), 0n, 0n, 0n);
      updated++;
    } catch {
      failed++;
    }
  }
  return { updated, failed };
}
