import { panelAuth, ok } from "@/lib/panel-auth";
import { getConfig } from "@/lib/config";
import { tasksScanAll } from "@/lib/taskcenter";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET 扫描全部账号成长任务待办（只读；对齐 tasksScanAll）。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const r = await tasksScanAll(await getConfig());
  return ok({ accounts: r.accounts, pending_count: r.pending_count });
}
