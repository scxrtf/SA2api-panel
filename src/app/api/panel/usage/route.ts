// GET /api/panel/usage — 用量聚合（hours 滚动窗口默认 72 / from-to 显式区间）。
import { panelAuth, ok } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const q = new URL(req.url).searchParams;
  const from = parseTime(q.get("from"));
  const to = parseTime(q.get("to"));
  let since: Date | null = from;
  let until: Date | null = to;
  if (!since && !until) {
    let hours = parseInt(q.get("hours") ?? "72", 10);
    if (!Number.isFinite(hours) || hours < 0) hours = 72;
    if (hours > 1440) hours = 1440;
    if (hours > 0) since = new Date(Date.now() - hours * 3600_000);
  }
  // UsageEvent 的时间字段是 at（不是 createdAt），where 是弱类型 tsc 查不出，注意。
  const where: Record<string, unknown> = {};
  if (since || until) {
    where["at"] = {};
    if (since) (where["at"] as Record<string, unknown>)["gte"] = since;
    if (until) (where["at"] as Record<string, unknown>)["lte"] = until;
  }

  const events = await prisma.usageEvent.findMany({ where, orderBy: { id: "asc" } });
  const nicks = new Map<string, string>();
  for (const a of await prisma.account.findMany({ select: { uid: true, nickname: true } })) {
    nicks.set(a.uid, a.nickname);
  }

  let prompt = 0;
  let completion = 0;
  let total = 0;
  let credit = 0;
  let okCount = 0;
  const byModel = new Map<string, { n: number; tokens: number; credit: number }>();
  const byAccount = new Map<string, { n: number; tokens: number; credit: number; nickname: string }>();
  for (const e of events) {
    prompt += e.promptTokens;
    completion += e.completionTok;
    total += e.totalTokens;
    credit += e.credit;
    if (e.ok) okCount++;
    const bm = byModel.get(e.model) ?? { n: 0, tokens: 0, credit: 0 };
    bm.n++;
    bm.tokens += e.totalTokens;
    bm.credit += e.credit;
    byModel.set(e.model, bm);
    const ba = byAccount.get(e.uid) ?? { n: 0, tokens: 0, credit: 0, nickname: nicks.get(e.uid) ?? "" };
    ba.n++;
    ba.tokens += e.totalTokens;
    ba.credit += e.credit;
    byAccount.set(e.uid, ba);
  }
  return ok({
    count: events.length,
    ok_count: okCount,
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    credit,
    by_model: [...byModel.entries()].map(([model, v]) => ({ model, ...v })),
    by_account: [...byAccount.entries()].map(([uid, v]) => ({ uid, ...v })),
  });
}

function parseTime(v: string | null): Date | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n > 1e12 ? n : n * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}
