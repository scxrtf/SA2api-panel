import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { BASELINE_ID_RE, loadOfficialBaselines } from "@/lib/aichecker-official";
import {
  buildFromDistribution, buildFromImport, cleanLabel, deleteCustomBaseline,
  listCustomBaselines, makeBaselineID, putCustomBaseline,
  type CustomBaselineMeta,
} from "@/lib/aichecker-baselines";

// 基准清单 = 内置官方快照 + 用户自建/导入基准。
// 官方快照随站点部署在 public/aichecker/baselines，不实时打 GitHub（规避限流与部署网络问题）。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;

  let official: { id: string; file: string }[] = [];
  let officialError = "";
  try {
    official = await loadOfficialBaselines(req.url);
  } catch (e) {
    officialError = e instanceof Error ? e.message : String(e);
  }
  let custom: CustomBaselineMeta[] = [];
  try {
    custom = await listCustomBaselines();
  } catch {
    // DB 未就绪时仍可只用官方基准；保存自建基准会单独报错。
  }

  if (official.length === 0 && custom.length === 0) {
    return fail(502, "无法获取官方基准列表" + (officialError ? `：${officialError}` : ""));
  }
  const models = [
    ...official.map((b) => ({ ...b, source: "official" as const, label: b.id })),
    ...custom.map((b) => ({
      id: b.id, file: b.id + ".json", source: "custom" as const,
      label: b.label, model: b.model, createdAt: b.createdAt,
    })),
  ];
  return ok({
    models, count: models.length,
    official: official.length, custom: custom.length,
    source: "内置快照 + 自建",
    repo: "hanlinwenyuan/hlwy-ai-checker",
    ...(officialError ? { official_error: officialError } : {}),
  });
}

// POST 保存基准：
//   1. { label, model?, distribution, samples? } —— 把一次真实鉴别结果存为基准；
//   2. { import: <上游基准 JSON>, label?, id? } —— 导入外部导出的基准。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let body: {
    id?: string; label?: string; model?: string;
    distribution?: unknown; samples?: number; import?: unknown;
  };
  try { body = await req.json(); } catch { return fail(400, "parse body failed"); }

  const built = body.import !== undefined
    ? buildFromImport(body.import, body.label)
    : buildFromDistribution({
      label: body.label ?? "",
      model: body.model,
      distribution: body.distribution,
      samples: body.samples,
    });
  if ("error" in built) return fail(400, built.error);
  const data = built.data;

  let official: { id: string }[] = [];
  try { official = await loadOfficialBaselines(req.url); } catch { /* 静态快照缺失不阻塞保存 */ }
  let custom: CustomBaselineMeta[] = [];
  try { custom = await listCustomBaselines(); } catch { /* 下面 put 会给出真实错误 */ }
  const officialIDs = new Set(official.map((b) => b.id));
  const customIDs = new Set(custom.map((b) => b.id));

  const requested = (body.id ?? "").trim();
  if (requested && !BASELINE_ID_RE.test(requested)) {
    return fail(400, "基准 id 不合法（字母数字开头，仅允许 . _ -，最长 81 字符）");
  }
  if (requested && officialIDs.has(requested)) {
    return fail(409, `「${requested}」是官方内置基准，不能覆盖`);
  }
  const id = requested || makeBaselineID(data.model || data.name, new Set([...officialIDs, ...customIDs]));
  const label = cleanLabel(body.label ?? data.name) || data.name;

  try {
    await putCustomBaseline({
      id, label, createdAt: new Date().toISOString(),
      model: data.model, data: { ...data, name: label },
    });
  } catch (e) {
    return fail(500, "保存基准失败：" + (e instanceof Error ? e.message : String(e)));
  }
  return ok({ baseline: { id, label, source: "custom", created: !customIDs.has(id) } });
}

// DELETE 删除自建基准（官方快照不可删）。
export async function DELETE(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const id = (new URL(req.url).searchParams.get("name") ?? "").trim();
  if (!id) return fail(400, "缺少 name 参数");
  if (!BASELINE_ID_RE.test(id)) return fail(400, "基准名称不合法");
  try {
    const removed = await deleteCustomBaseline(id);
    if (!removed) return fail(404, `自建基准「${id}」不存在`);
    return ok({ deleted: id });
  } catch (e) {
    return fail(500, "删除基准失败：" + (e instanceof Error ? e.message : String(e)));
  }
}
