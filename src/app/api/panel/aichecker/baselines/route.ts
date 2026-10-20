import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 官方基准列表（对齐 start.py serve_baseline_list）。
// 数据源改为随站点部署的 public/aichecker/baselines 快照（克隆时打包进仓库），
// 不再实时打 GitHub，规避匿名 API 限流与部署环境直连 GitHub 失败的问题。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  try {
    const res = await fetch(new URL("/aichecker/baselines/index.json", req.url), { cache: "no-store" });
    if (!res.ok) throw new Error("index.json http " + res.status);
    const data: unknown = await res.json();
    const models = parseIndex(data);
    if (models.length === 0) throw new Error("index.json 内容为空");
    return ok({ models, count: models.length, source: "内置快照", repo: "hanlinwenyuan/hlwy-ai-checker" });
  } catch (e) {
    return new Response(JSON.stringify({
      error: "无法获取官方基准列表",
      detail: e instanceof Error ? e.message : String(e),
    }), { status: 502, headers: { "Content-Type": "application/json" } });
  }
}

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,80}$/;

// 对齐 start.py _parse_index：兼容纯名称数组与 {"models": [...]} 对象数组。
function parseIndex(data: unknown): { id: string; file: string }[] {
  const items: unknown = Array.isArray(data)
    ? data
    : (data as { models?: unknown })?.models;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const models: { id: string; file: string }[] = [];
  for (const it of items) {
    let name = "";
    if (typeof it === "string") name = it;
    else if (it && typeof it === "object") {
      const o = it as { id?: unknown; name?: unknown };
      name = typeof o.id === "string" ? o.id : typeof o.name === "string" ? o.name : "";
    }
    if (name.endsWith(".json")) name = name.slice(0, -5);
    if (SAFE_NAME_RE.test(name) && !seen.has(name)) {
      seen.add(name);
      models.push({ id: name, file: name + ".json" });
    }
  }
  models.sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
  return models;
}
