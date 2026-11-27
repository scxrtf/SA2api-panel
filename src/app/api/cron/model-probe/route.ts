// GET/POST /api/cron/model-probe — 外部 cron 触发一轮全模型真实健康探测。
import { runModelHealthProbe } from "@/lib/modelhealth";
import { jsonify } from "@/lib/panel-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(): Promise<Response> {
  const result = await runModelHealthProbe("cron");
  return jsonify({
    ok: true,
    total: result.total,
    success: result.ok,
    failed: result.failed,
    catalogErrors: result.catalogErrors,
    durationMs: result.durationMs,
  });
}

export const GET = run;
export const POST = run;
