// GET /api/panel/usage — 用量聚合（保持既有面板响应契约）。
// PostgreSQL 内完成分组、求和与北京时间分桶，只把聚合行传回 Node.js。
import { panelAuth, ok } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { buildUsageSnapshot, type SeriesDim } from "@/lib/usage-aggregation";
import { queryUsageAggregate } from "@/lib/usage-query";
import { cachedUsageQuery } from "@/lib/usage-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERIES_DIMS = new Set<string>(["key", "model", "account", "provider", "realm"]);

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const q = new URL(req.url).searchParams;
  const groupRaw = (q.get("group") ?? "").trim();
  const groupDim = (SERIES_DIMS.has(groupRaw) ? groupRaw : "") as SeriesDim | "";
  const from = parseTime(q.get("from"));
  const to = parseTime(q.get("to"));
  let since: Date | null = from;
  let rollingHours: number | null = null;
  const explicit = Boolean(from || to);
  if (!explicit) {
    let hours = parseInt(q.get("hours") ?? "72", 10);
    if (!Number.isFinite(hours) || hours < 0) hours = 72;
    if (hours > 1440) hours = 1440;
    rollingHours = hours;
    if (hours > 0) since = new Date(Date.now() - hours * 3600_000);
  }
  const dayScope = since !== null && (Date.now() - since.getTime()) > 7 * 86_400_000;
  const windowFrom = explicit && from ? from.toISOString() : "";
  const windowTo = explicit && to ? to.toISOString() : "";
  // 滚动窗口用 hours 而不是当前毫秒作 key，20 秒 TTL 才能跨轮询复用。
  const cacheKey = JSON.stringify({ rollingHours, from: windowFrom, to: windowTo, groupDim, dayScope });
  const snapshot = await cachedUsageQuery(cacheKey, async () => {
    const [rows, accounts] = await Promise.all([
      queryUsageAggregate(prisma, { since, until: to, dayScope, groupDim }),
      prisma.account.findMany({ select: { uid: true, nickname: true } }),
    ]);
    return buildUsageSnapshot(
      rows,
      new Map(accounts.map((a) => [a.uid, a.nickname])),
      { dayScope, groupDim, windowFrom, windowTo },
    );
  });
  return ok(snapshot);
}

function parseTime(v: string | null): Date | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n > 1e12 ? n : n * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}
