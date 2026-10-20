import { panelAuth, fail, jsonify } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { BASELINE_ID_RE } from "@/lib/aichecker-official";
import { getCustomBaseline } from "@/lib/aichecker-baselines";

// 返回单个基准：先查内置官方快照，再查 Setting 表里的自建/导入基准。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const name = (new URL(req.url).searchParams.get("name") ?? "").trim();
  if (!name) return fail(400, "缺少 name 参数");
  if (!BASELINE_ID_RE.test(name)) return fail(400, "基准名称不合法");

  let officialError = "";
  try {
    const res = await fetch(new URL(`/aichecker/baselines/${name}.json`, req.url), { cache: "no-store" });
    if (res.ok) {
      return jsonify({ name, source: "官方快照", data: await res.json() });
    }
    officialError = "http " + res.status;
  } catch (e) {
    officialError = e instanceof Error ? e.message : String(e);
  }

  try {
    const custom = await getCustomBaseline(name);
    if (custom) return jsonify({ name, source: "自建基准", data: custom.data });
  } catch (e) {
    return fail(500, `读取基准「${name}」失败：` + (e instanceof Error ? e.message : String(e)));
  }
  return fail(404, `基准「${name}」不存在` + (officialError ? `（官方快照 ${officialError}）` : ""));
}
