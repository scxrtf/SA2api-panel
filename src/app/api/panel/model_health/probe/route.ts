import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { runModelHealthProbe } from "@/lib/modelhealth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// POST 手动执行真实最小聊天探测；传 model 时只探测该模型，不传则探测全部目录模型。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;

  let body: { model?: unknown };
  try {
    body = await req.json();
  } catch {
    return fail(400, "parse body failed");
  }
  const model = typeof body.model === "string" ? body.model.trim() : "";

  const result = await runModelHealthProbe("panel", model);
  if (model && result.total === 0) return fail(404, "model not found: " + model);
  return ok({
    total: result.total,
    success: result.ok,
    failed: result.failed,
    catalogErrors: result.catalogErrors,
    durationMs: result.durationMs,
  });
}
