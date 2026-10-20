import { panelAuth, fail, jsonify } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { BASELINE_ID_RE } from "@/lib/aichecker-official";
import { loadBaseline } from "@/lib/aichecker-baseline-loader";

// 返回单个基准：本地快照 → 自建/导入基准 → 上游按需回源。
// 直接读文件，不走站点自身 HTTP，避免 Railway 回环 fetch 失败。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const name = (new URL(req.url).searchParams.get("name") ?? "").trim();
  if (!name) return fail(400, "缺少 name 参数");
  if (!BASELINE_ID_RE.test(name)) return fail(400, "基准名称不合法");

  try {
    const found = await loadBaseline(name);
    if (found) return jsonify({ name, source: found.source, data: found.data });
  } catch (e) {
    return fail(500, `读取基准「${name}」失败：` + (e instanceof Error ? e.message : String(e)));
  }
  return fail(404, `基准「${name}」不存在`);
}
