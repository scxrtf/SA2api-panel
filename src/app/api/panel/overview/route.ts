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
  // 只统计 30min TTL 窗口内仍活跃的绑定（与 session.ts STICKY_TTL_MS 一致），
  // 避免历史累计的过期行把面板数字吹大。过期行由 keepalive cron 末尾的
  // gcSticky 实际删除。
  const sticky = await prisma.stickySession
    .count({ where: { updatedAt: { gte: new Date(Date.now() - 30 * 60_000) } } })
    .catch(() => 0);
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
    // model_fallback 降级路由表（上游 f1eca4a）：面板据此把「限流中」标注成
    // 「已路由至等价模型」——否则运维只看到限流，会误判为服务不可用。
    model_fallback: cfg.model_fallback ?? {},
    gateway: { enabled: providerCount > 0, providers: providerCount, keys: keyCount },
  });
}
