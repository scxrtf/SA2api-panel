import { panelAuth, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,80}$/;

// 下载并返回单个官方基准（对齐 start.py serve_baseline_file）。
// 同样改为读随站点部署的 baselines 快照。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const name = (new URL(req.url).searchParams.get("name") ?? "").trim();
  if (!name) return fail(400, "缺少 name 参数");
  if (!SAFE_NAME_RE.test(name)) return fail(400, "基准名称不合法");
  try {
    const res = await fetch(new URL(`/aichecker/baselines/${name}.json`, req.url), { cache: "no-store" });
    if (!res.ok) throw new Error("http " + res.status);
    const data: unknown = await res.json();
    return new Response(JSON.stringify({ name, source: "内置快照", data }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: `无法下载基准「${name}」`,
      detail: e instanceof Error ? e.message : String(e),
    }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
}
