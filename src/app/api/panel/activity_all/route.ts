import { panelAuth, ok } from "@/lib/panel-auth";
import { runActivityNow } from "@/lib/cron";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST 手动触发全量活跃上报（同步等待完成；点亮连登 + 解锁领养前置；对齐 activityAll）。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const r = await runActivityNow();
  return ok({ ...r });
}
