// GET/POST /api/cron/keepalive — 外部 cron 触发（cron-job.org / Railway Cron 插件）。
import { jsonify } from "@/lib/panel-auth";
import { runKeepalive } from "@/lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function run(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const result = await runKeepalive({ force, source: "cron" });
  return jsonify({ ok: true, ...result });
}

export const GET = run;
export const POST = run;
