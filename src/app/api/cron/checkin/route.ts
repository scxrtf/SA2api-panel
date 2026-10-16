// GET/POST /api/cron/checkin — 外部 cron 触发（cron-job.org / Railway Cron 插件）。
// 鉴权：Authorization: Bearer <WB2A_API_KEY>；主密钥为空时拒绝（防无鉴权公网暴露）。
import { verifyBearer } from "@/lib/auth-guard";
import { getConfig } from "@/lib/config";
import { jsonify } from "@/lib/panel-auth";
import { runCheckin } from "@/lib/cron";

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
  const result = await runCheckin();
  return jsonify({ ok: true, ...result });
}

export const GET = run;
export const POST = run;
