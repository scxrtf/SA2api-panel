// POST /api/panel/import/cockpit — 从 cockpit tools 导出的 JSON 批量导入账号。
// 接受 multipart/form-data（file=<json>）或裸 JSON body（数组原文）。
// 返回 {ok, total, imported, skipped, errors}。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import * as pool from "@/lib/pool";
import { validUID } from "@/lib/login";
import { claimTrial, dailyCheckin, userResource, expiringSoonMs } from "@/lib/upstream/client";
import { globalCompleteRegistration } from "@/lib/upstream/global_register";
import { runlogAccount } from "@/lib/runlog";
import { label } from "@/lib/logfmt";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface CockpitAccount {
  id?: string;
  email?: string;
  uid?: string;
  nickname?: string;
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  domain?: string;
}

function realmOf(domain: string): string {
  return /workbuddy\.ai/i.test(domain ?? "") ? "global" : "cn";
}

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;

  let accounts: CockpitAccount[];
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("multipart/form-data")) {
      const form = await req.formData();
      const f = form.get("file");
      if (!f || typeof f === "string") return fail(400, "missing file field");
      accounts = JSON.parse(await f.text()) as CockpitAccount[];
    } else {
      accounts = (await req.json()) as CockpitAccount[];
    }
  } catch (e) {
    return fail(400, "invalid json: " + (e instanceof Error ? e.message : String(e)));
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return fail(400, "empty accounts array");
  }

  const cfg = await getConfig();
  let imported = 0;
  let skipped = 0;
  const errs: string[] = [];
  runlogAccount("导入开始", "total=" + accounts.length);

  for (const acc of accounts) {
    const uid = (acc.uid ?? "").trim();
    const at = (acc.access_token ?? "").trim();
    const rt = (acc.refresh_token ?? "").trim();
    if (!uid || !at || !rt) {
      skipped++;
      errs.push("missing required fields (id=" + (acc.id ?? "") + ")");
      continue;
    }
    if (!validUID(uid)) {
      skipped++;
      errs.push("invalid uid (id=" + (acc.id ?? "") + ")");
      continue;
    }
    const realm = realmOf(acc.domain ?? "");
    // cockpit 的 expires_at 为毫秒时间戳，转秒；缺失给一年兜底。
    let expiresAtSec = Math.floor((acc.expires_at ?? 0) / 1000);
    if (expiresAtSec <= 0) expiresAtSec = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    const nickname = (acc.nickname ?? "").trim() || (acc.email ?? "");

    await prisma.account.upsert({
      where: { uid },
      create: {
        uid, nickname, realm,
        accessToken: at, refreshToken: rt,
        expiresAt: BigInt(expiresAtSec), domain: acc.domain ?? "",
      },
      update: {
        nickname, realm,
        accessToken: at, refreshToken: rt,
        expiresAt: BigInt(expiresAtSec), domain: acc.domain ?? "",
      },
    });
    await pool.revive(uid);

    // 顺带签到/激活/余额（幂等；失败不阻断导入，对齐 Go import.go）。
    const shape = {
      uid, nickname, realm,
      accessToken: at, refreshToken: rt,
      expiresAt: expiresAtSec, domain: acc.domain ?? "",
      enterpriseId: "", deviceToken: "",
    };
    if (realm === "global") {
      try {
        await globalCompleteRegistration(shape);
      } catch (e) {
        // 注册激活失败不阻断导入，但记一行便于排查。
        runlogAccount("导入账号", label(uid, nickname) + " 激活失败: " + (e instanceof Error ? e.message : String(e)));
      }
      try {
        await claimTrial(cfg, shape);
      } catch (e) {
        runlogAccount("导入账号", label(uid, nickname) + " trial 领取失败: " + (e instanceof Error ? e.message : String(e)));
      }
    } else {
      try {
        await dailyCheckin(cfg, shape);
        await pool.markCheckin(uid);
      } catch (e) {
        // 已签到等业务错误不阻断导入。
        runlogAccount("导入账号", label(uid, nickname) + " 签到: " + (e instanceof Error ? e.message : String(e)));
      }
    }
    try {
      const r = await userResource(cfg, shape, expiringSoonMs(cfg.expiring_soon_hours));
      await pool.setCreditsDetailed(
        uid, BigInt(r.remain), BigInt(r.total),
        BigInt(r.expiring), BigInt(r.earliestAt), BigInt(r.earliestRemain),
      );
    } catch (e) {
      runlogAccount("导入账号", label(uid, nickname) + " 余额刷新失败: " + (e instanceof Error ? e.message : String(e)));
    }
    runlogAccount("导入账号", label(uid, nickname) + " realm=" + realm);
    imported++;
  }

  runlogAccount("导入完成", "total=" + accounts.length + " imported=" + imported + " skipped=" + skipped);
  if (errs.length > 0) {
    // 跳过原因只摘前 3 条，避免一次导入刷满环形缓冲。
    runlogAccount("导入跳过", errs.slice(0, 3).join(" | "));
  }
  return ok({ total: accounts.length, imported, skipped, errors: errs });
}
