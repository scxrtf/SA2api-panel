// GET /api/panel/overview — 池计数 + 账号状态 + 面板元信息（Go overview 同口径）。
import { panelAuth, ok } from "@/lib/panel-auth";
import * as pool from "@/lib/pool";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const started = Date.now();

// 这三个 count 变化极慢，且每次都是独立 round-trip；60s 进程内缓存足够。
type MetaCounts = { at: number; sticky: number; provider: number; keys: number };
const metaGlobals = globalThis as unknown as { __wbOverviewMeta?: MetaCounts };
const META_TTL_MS = 60_000;

async function metaCounts(): Promise<{ sticky: number; provider: number; keys: number }> {
  const cached = metaGlobals.__wbOverviewMeta;
  if (cached && Date.now() - cached.at < META_TTL_MS) {
    return { sticky: cached.sticky, provider: cached.provider, keys: cached.keys };
  }
  // 只统计 30min TTL 窗口内仍活跃的绑定（与 session.ts STICKY_TTL_MS 一致），
  // 避免历史累计的过期行把面板数字吹大。过期行由 keepalive cron 末尾的
  // gcSticky 实际删除。
  const [sticky, provider, keys] = await Promise.all([
    prisma.stickySession
      .count({ where: { updatedAt: { gte: new Date(Date.now() - 30 * 60_000) } } })
      .catch(() => 0),
    prisma.provider.count().catch(() => 0),
    prisma.apiKey.count().catch(() => 0),
  ]);
  metaGlobals.__wbOverviewMeta = { at: Date.now(), sticky, provider, keys };
  return { sticky, provider, keys };
}

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const cfg = await getConfig();
  const [snapshot, meta] = await Promise.all([pool.overviewSnapshot(cfg), metaCounts()]);
  return ok({
    version: "next-0.1",
    uptime_sec: Math.floor((Date.now() - started) / 1000),
    auth_required: cfg.api_key !== "",
    redis_mode: "noop",
    sticky_sessions: meta.sticky,
    ...snapshot.count,
    accounts: snapshot.accounts,
    model_locks: snapshot.model_locks,
    // model_fallback 降级路由表（上游 f1eca4a）：面板据此把「限流中」标注成
    // 「已路由至等价模型」——否则运维只看到限流，会误判为服务不可用。
    model_fallback: cfg.model_fallback ?? {},
    gateway: { enabled: meta.provider > 0, providers: meta.provider, keys: meta.keys },
  });
}
