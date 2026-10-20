// POST /api/panel/balance_all — 手动全量余额刷新（同步等待，完成后返回最新池快照）。
import { panelAuth, ok } from "@/lib/panel-auth";
import * as pool from "@/lib/pool";
import { runBalanceRefresh, syncNicknames } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const r = await runBalanceRefresh();
  // 手动刷新触发昵称同步（Go balanceAll 内 syncNicknames；后台定时器不调）。
  await syncNicknames();
  return ok({ ...r, accounts: await pool.statusList() });
}
