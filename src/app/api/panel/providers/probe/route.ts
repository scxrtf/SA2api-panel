import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST 用「尚未创建」的 base_url + key 探测上游模型列表（对齐 providerProbe）。
// key 原文只在本次请求生命周期内用于上游请求，不落盘、不回显、不写日志。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let body: { base_url?: string; key?: string };
  try { body = await req.json(); } catch { return fail(400, "invalid json body"); }
  const baseUrl = (body.base_url ?? "").trim().replace(/\/+$/, "");
  const key = (body.key ?? "").trim();
  if (!baseUrl || !key) return fail(400, "base_url / key 均不能为空");
  try {
    const headers: Record<string, string> = {};
    if (key) headers["Authorization"] = "Bearer " + key;
    const resp = await fetch(baseUrl + "/v1/models", {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const raw = await resp.text();
      return fail(502, "upstream http " + resp.status + ": " + raw.slice(0, 200));
    }
    const data = (await resp.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
    return ok({ models });
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : "probe failed");
  }
}
