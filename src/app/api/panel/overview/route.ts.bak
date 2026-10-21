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
  const c = await pool.countsDetailed(cfg);
  const accounts = await pool.statusList();
  const sticky = await prisma.stickySession.count().catch(() => 0);
  const providerCount = await prisma.provider.count().catch(() => 0);
  const keyCount = await prisma.apiKey.count().catch(() => 0);
  // model_locks 模型级限流全清单（Go ModelLockView 同口径：哪些模型不能用、
  // 锁了几个号、还要锁多久），与 accounts 账号池视图互补。无锁时为 null。
  const modelLocks = await pool.modelLockView(cfg);
  return ok({
    version: "next-0.1",
    uptime_sec: Math.floor((Date.now() - started) / 1000),
    auth_required: cfg.api_key !== "",
    redis_mode: "noop",
    sticky_sessions: sticky,
    ...c,
    accounts,
    model_locks: modelLocks,
    gateway: { enabled: providerCount > 0, providers: providerCount, keys: keyCount },
  });
}
