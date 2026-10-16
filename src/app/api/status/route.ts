// GET /api/status —— 池状态快照（兼容 Go /status 的消费方）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { verifyAny } from "@/lib/auth-guard";
import { statusList, counts, costExploreStatus } from "@/lib/pool";
import { getConfig } from "@/lib/config";

export async function GET(req: Request): Promise<Response> {
  if (!(await verifyAny(req))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const cfg = await getConfig();
  const [accounts, c] = await Promise.all([statusList(), counts()]);
  return Response.json({
    ...c,
    credit_floor: cfg.credit_floor,
    cost_explore: costExploreStatus(),
    accounts,
  });
}
