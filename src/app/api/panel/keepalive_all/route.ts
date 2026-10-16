import { panelAuth, ok } from "@/lib/panel-auth";
import { runKeepalive } from "@/lib/cron";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST 手动触发全量 token 保活（同步等待完成；对齐 keepaliveAll）。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const r = await runKeepalive();
  return ok({ ...r });
}
