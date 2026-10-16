// GET /api/healthz —— 业务健康度（池计数）。DB 不可达返回 503；
// 池为空是初始部署的正常状态，不影响存活判定（存活探针用 /api/status）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { counts } from "@/lib/pool";

export async function GET(): Promise<Response> {
  try {
    const c = await counts();
    return Response.json({
      ok: true,
      degraded: c.healthy === 0 && c.total > 0,
      empty: c.total === 0,
      ...c,
    });
  } catch (e) {
    return Response.json(
      { ok: false, reason: e instanceof Error ? e.message : "db error" },
      { status: 503 },
    );
  }
}
