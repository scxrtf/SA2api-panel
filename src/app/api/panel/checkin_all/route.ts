// POST /api/panel/checkin_all — 手动全量签到（同步执行返回汇总；global/企业号跳过）。
import { panelAuth, ok } from "@/lib/panel-auth";
import { runCheckin } from "@/lib/cron";
import { runlog } from "@/lib/runlog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  runlog("panel: 手动全量签到已触发（含猫猫旅行）");
  return ok(await runCheckin());
}
