// 官方基准清单（public/aichecker/baselines/index.json 内置快照）。
// 单独抽出便于 baselines 列表与自建基准保存共用同一份名称校验/解析逻辑。
export const BASELINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,80}$/;

export interface BaselineListItem {
  id: string;
  file: string;
}

// 对齐 start.py _parse_index：兼容纯名称数组与 {"models": [...]} 对象数组。
export function parseBaselineIndex(data: unknown): BaselineListItem[] {
  const items: unknown = Array.isArray(data)
    ? data
    : (data as { models?: unknown })?.models;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const models: BaselineListItem[] = [];
  for (const it of items) {
    let name = "";
    if (typeof it === "string") name = it;
    else if (it && typeof it === "object") {
      const o = it as { id?: unknown; name?: unknown };
      name = typeof o.id === "string" ? o.id : typeof o.name === "string" ? o.name : "";
    }
    if (name.endsWith(".json")) name = name.slice(0, -5);
    if (BASELINE_ID_RE.test(name) && !seen.has(name)) {
      seen.add(name);
      models.push({ id: name, file: name + ".json" });
    }
  }
  models.sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
  return models;
}

// loadOfficialBaselines 通过站点自身 HTTP 读取静态快照，
// 兼容 serverless / 只读文件系统等无法直接读 public 的场景。
export async function loadOfficialBaselines(reqURL: string): Promise<BaselineListItem[]> {
  // 优先直接读容器内文件：Railway 等平台上服务端对自身公网域名发 fetch
  // 常因回环/出站限制报 "fetch failed"，而 public/ 已随镜像 COPY 进容器。
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const raw = await readFile(join(process.cwd(), "public", "aichecker", "baselines", "index.json"), "utf8");
    const models = parseBaselineIndex(JSON.parse(raw));
    if (models.length > 0) return models;
  } catch {
    // 文件不可读（如纯 serverless 部署）时退回 HTTP 自取。
  }
  const res = await fetch(new URL("/aichecker/baselines/index.json", reqURL), { cache: "no-store" });
  if (!res.ok) throw new Error("index.json http " + res.status);
  const models = parseBaselineIndex(await res.json());
  if (models.length === 0) throw new Error("index.json 内容为空");
  return models;
}
