// GET /api/panel/balance_history — 余额采样序列，供「余额趋势」视图画折线。
// days 查询参数控制窗口（默认 30，上限 30 = 原始点保留期；更早的数据已折叠为日粒度）。
import { panelAuth, ok } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { cbAccountNames, cbBalanceSamples, isCloudbaseRestEnabled } from "@/lib/cloudbase-rest";
import { snapshotBalance } from "@/lib/balance";
import { panelCacheGet, panelCacheSet } from "@/lib/panel-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";
  let days = 30;
  const v = url.searchParams.get("days");
  if (v) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && n > 0) days = n;
  }
  if (days > 30) days = 30;
  const cacheKey = `balance_history:${days}`;
  if (!refresh) {
    const cached = panelCacheGet<Record<string, unknown>>(cacheKey);
    if (cached) return ok({ ...cached, cached: true });
  }
  const sinceMs = new Date().getTime() - days * 24 * 3600_000;
  // 昵称与域仅用于展示，取自账号表（不含任何凭证）。realm 必须在 snapshot 前注入：
  // cn 与 global 的积分不同源、不可互换，前端需按域分组渲染。
  if (isCloudbaseRestEnabled()) {
    // CloudBase 灰度：账号名与采样点都走 PostgREST 网关。
    const accounts = await cbAccountNames();
    const names: Record<string, string> = {};
    const realms: Record<string, string> = {};
    for (const a of accounts) {
      if (a.nickname) names[a.uid] = a.nickname;
      if (a.realm) realms[a.uid] = a.realm;
    }
    const rows = await cbBalanceSamples({ sinceMs, order: "asc", limit: 50_000 });
    const samples = rows.map((r) => ({
      uid: r.uid,
      at: new Date(r.at),
      credits: BigInt(r.credits),
      day: r.day || "",
      first: BigInt(r.first),
      consumed: BigInt(r.consumed),
      gained: BigInt(r.gained),
    }));
    const series = await snapshotBalance(sinceMs, names, realms, samples);
    const payload = { now: new Date().toISOString(), days, series, source: "cloudbase" };
    panelCacheSet(cacheKey, payload);
    return ok(payload);
  }
  const accounts = await prisma.account.findMany({ select: { uid: true, nickname: true, realm: true } });
  const names: Record<string, string> = {};
  const realms: Record<string, string> = {};
  for (const a of accounts) {
    if (a.nickname) names[a.uid] = a.nickname;
    if (a.realm) realms[a.uid] = a.realm;
  }
  const series = await snapshotBalance(sinceMs, names, realms);
  const payload = {
    now: new Date().toISOString(),
    days,
    series,
    source: "prisma",
  };
  panelCacheSet(cacheKey, payload);
  return ok(payload);
}
