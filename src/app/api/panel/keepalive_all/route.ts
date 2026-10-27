import { panelAuth, ok } from "@/lib/panel-auth";
import { runKeepalive } from "@/lib/cron";
import { runlog } from "@/lib/runlog";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST 手动触发全量 token 保活（force=true，跳过临期筛选；同步等待完成）。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  runlog("panel: 手动全量保活已触发");
  const r = await runKeepalive({ force: true, source: "panel" });
  return ok({ ...r });
}
