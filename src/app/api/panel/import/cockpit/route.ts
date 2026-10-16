// POST /api/panel/import/cockpit — 从 cockpit tools 导出的 JSON 批量导入账号。
// 接受 multipart/form-data（file=<json>）或裸 JSON body（数组原文）。
// 返回 {ok, total, imported, skipped, errors}。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import * as pool from "@/lib/pool";
import { validUID } from "@/lib/login";
import { dailyCheckin, userResource } from "@/lib/upstream/client";

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

    // 顺带签到/余额（幂等；失败不阻断导入）。
    const shape = {
      uid, nickname, realm,
      accessToken: at, refreshToken: rt,
      expiresAt: expiresAtSec, domain: acc.domain ?? "",
      enterpriseId: "", deviceToken: "",
    };
    if (realm !== "global") {
      try {
        await dailyCheckin(cfg, shape);
        await pool.markCheckin(uid);
      } catch {
        // 已签到等业务错误静默。
      }
    }
    try {
      const r = await userResource(cfg, shape);
      await pool.setCreditsDetailed(uid, BigInt(r.remain), BigInt(r.total), 0n, 0n, 0n);
    } catch {
      // 余额失败不阻断。
    }
    imported++;
  }

  return ok({ total: accounts.length, imported, skipped, errors: errs });
}
