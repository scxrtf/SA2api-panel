// POST /api/panel/balance_all — 手动全量余额刷新（同步等待，完成后返回最新池快照）。
import { panelAuth, ok } from "@/lib/panel-auth";
import * as pool from "@/lib/pool";
import { runBalanceRefresh } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const r = await runBalanceRefresh();
  return ok({ ...r, accounts: await pool.statusList() });
}
