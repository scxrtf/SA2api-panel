// GET/POST /api/cron/balance — 外部 cron 触发（cron-job.org / Railway Cron 插件）。
import { jsonify } from "@/lib/panel-auth";
import { runBalanceRefresh } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(): Promise<Response> {
  const result = await runBalanceRefresh();
  return jsonify({ ok: true, ...result });
}

export const GET = run;
export const POST = run;
