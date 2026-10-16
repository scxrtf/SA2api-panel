// GET /api/livez —— 免鉴权存活探针（Railway healthcheck 用）。
// 只证明进程活着；业务健康度看 /api/healthz（带池计数）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ ok: true });
}
