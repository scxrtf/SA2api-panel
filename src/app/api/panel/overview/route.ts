// GET /api/panel/overview — 池计数 + 账号状态 + 面板元信息（Go overview 同口径）。
import { panelAuth, ok } from "@/lib/panel-auth";
import * as pool from "@/lib/pool";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const started = Date.now();

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const cfg = await getConfig();
  const c = await pool.counts();
  const accounts = await pool.statusList();
  const sticky = await prisma.stickySession.count().catch(() => 0);
  const providerCount = await prisma.provider.count().catch(() => 0);
  const keyCount = await prisma.apiKey.count().catch(() => 0);
  return ok({
    version: "next-0.1",
    uptime_sec: Math.floor((Date.now() - started) / 1000),
    auth_required: cfg.api_key !== "",
    redis_mode: "noop",
    sticky_sessions: sticky,
    ...c,
    in_flight_full: 0,
    accounts,
    gateway: { enabled: providerCount > 0, providers: providerCount, keys: keyCount },
  });
}
