import { panelAuth, ok } from "@/lib/panel-auth";
import { runTravelNow } from "@/lib/cron";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST 手动触发全量旅行巡检（同步等待完成，返回动作计数；对齐 travelAll + RunTravelNow）。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const r = await runTravelNow();
  return ok({ ...r });
}
