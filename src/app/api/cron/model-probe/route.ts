// GET/POST /api/cron/model-probe — 外部 cron 触发一轮全模型真实健康探测。
// 鉴权：Authorization: Bearer <WB2A_API_KEY>；主密钥为空时拒绝。
import { verifyBearer } from "@/lib/auth-guard";
import { getConfig } from "@/lib/config";
import { runModelHealthProbe } from "@/lib/modelhealth";
import { jsonify } from "@/lib/panel-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: Request): Promise<Response> {
  const cfg = await getConfig();
  if (!cfg.api_key) {
    return jsonify({ ok: false, error: "cron requires WB2A_API_KEY to be set" }, 503);
  }
  if (!verifyBearer(req, cfg.api_key)) {
    return jsonify({ ok: false, error: "invalid_api_key" }, 401);
  }
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
