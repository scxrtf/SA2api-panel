// 单个基准的统一加载入口：本地快照 → 自建基准 → 上游按需回源。
//
// 关键点：绝不通过站点自身 HTTP 读取 /api/panel/aichecker/baseline。
// Railway 等平台服务端对自身公网域名发请求常因回环/出站限制失败，
// 即使 public/ 里已有 gpt-6-astra.json 也会报「无法下载基准」。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BASELINE_ID_RE } from "@/lib/aichecker-official";
import { getCustomBaseline } from "@/lib/aichecker-baselines";
import { normalizeBaseline, type Baseline } from "@/lib/aichecker";
import { fetchUpstreamText } from "@/lib/aichecker-upstream";

export type BaselineSource = "官方快照" | "自建基准" | "上游基准";

export interface LoadedBaseline {
  id: string;
  source: BaselineSource;
  data: Baseline;
}

export interface LoadBaselineOptions {
  // check 主流程可关掉回源，避免本地全缺时被上游超时拖住。
  allowUpstream?: boolean;
}

export async function loadBaseline(
  id: string,
  opts: LoadBaselineOptions = {},
): Promise<LoadedBaseline | null> {
  if (!BASELINE_ID_RE.test(id)) return null;

  // 1. 容器内静态快照（随镜像部署，不依赖网络与自身 HTTP）。
  const local = await readLocalBaseline(id);
  if (local) return { id, source: "官方快照", data: local };

  // 2. 用户自建/导入基准（Setting 表）。
  try {
    const custom = await getCustomBaseline(id);
    if (custom) return { id, source: "自建基准", data: custom.data };
  } catch {
    // DB 未就绪时继续尝试上游；最终返回 null 由调用方给出统一报错。
  }

  // 3. 本地缺文件时按需回源，兼容新增了基准但尚未重新构建的部署。
  if (opts.allowUpstream !== false) {
    try {
      const text = await fetchUpstreamText(id + ".json");
      const data = normalizeBaseline(JSON.parse(text));
      if (data) return { id, source: "上游基准", data };
    } catch {
      // 上游不可达按「基准不存在」处理，调用方会给出 404/502。
    }
  }

  return null;
}

async function readLocalBaseline(id: string): Promise<Baseline | null> {
  try {
    const raw = await readFile(
      join(process.cwd(), "public", "aichecker", "baselines", id + ".json"),
      "utf8",
    );
    return normalizeBaseline(JSON.parse(raw));
  } catch {
    return null;
  }
}
