// GET/POST /api/cron/retention — 外部 cron 触发数据库保留策略（清详情 / 删过期日志 / 削健康检查）。
// 鉴权：Authorization: Bearer <WB2A_API_KEY>；主密钥为空时拒绝。
// 建议频率：每 6~12 小时一次。可用探针参数 ?days= / ?detailHours= 临时覆盖。
import { verifyBearer } from "@/lib/auth-guard";
import { getConfig } from "@/lib/config";
import { jsonify } from "@/lib/panel-auth";
import { runRetention, retentionConfig } from "@/lib/retention";

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
  const url = new URL(req.url);
  const days = Number(url.searchParams.get("days"));
  const detailHours = Number(url.searchParams.get("detailHours"));
  if (Number.isFinite(days) && days >= 1) process.env.REQUEST_LOG_RETENTION_DAYS = String(days);
  if (Number.isFinite(detailHours) && detailHours >= 0) process.env.REQUEST_LOG_DETAIL_HOURS = String(detailHours);

  const result = await runRetention();
  return jsonify({ ok: true, ...result, config: retentionConfig() });
}

export const GET = run;
export const POST = run;
