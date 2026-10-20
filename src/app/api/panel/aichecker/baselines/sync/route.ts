import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { promises as fs } from "fs";
import path from "path";
import { BASELINE_ID_RE, parseBaselineIndex } from "@/lib/aichecker-official";

// 上游基准仓库（hlwy-ai-checker）。官方快照平时随站点部署在
// public/aichecker/baselines，这里提供「手动拉取最新基准」的通道：
// 先读 baselines/index.json 清单，再逐个下载基准 JSON 覆盖本地快照。
const UPSTREAM_BASE =
  "https://raw.githubusercontent.com/hanlinwenyuan/hlwy-ai-checker/main/baselines";
const FETCH_TIMEOUT_MS = 15_000;
// 基准 JSON 约 5KB/个，355 桶分布；限制单文件 1MB 防止异常响应撑爆内存。
const MAX_FILE_BYTES = 1_000_000;

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ac.signal });
    if (!res.ok) throw new Error("http " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// 基本结构校验：数组首元素需含 355 桶 distribution；上游旧格式是纯名称数组。
// 不在这里做深度校验（判据算法会再解析），只挡明显不是基准文件的内容。
function validateBaselineJSON(id: string, text: string): void {
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error(id + " JSON 解析失败"); }
  const first = Array.isArray(data) ? data[0] : data;
  const dist = (first as { distribution?: unknown })?.distribution;
  if (!Array.isArray(dist) || dist.length !== 355) {
    throw new Error(id + " 缺少 355 桶 distribution，已跳过");
  }
}

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;

  const dir = path.join(process.cwd(), "public", "aichecker", "baselines");

  let indexText: string;
  try {
    indexText = await fetchText(UPSTREAM_BASE + "/index.json");
  } catch (e) {
    return fail(502, "拉取上游基准清单失败：" + (e instanceof Error ? e.message : String(e)));
  }
  let items;
  try {
    items = parseBaselineIndex(JSON.parse(indexText));
  } catch {
    return fail(502, "上游基准清单格式异常");
  }
  if (items.length === 0) return fail(502, "上游基准清单为空");

  await fs.mkdir(dir, { recursive: true });

  const added: string[] = [];
  const updated: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const it of items) {
    if (!BASELINE_ID_RE.test(it.id)) {
      skipped.push({ id: it.id, reason: "id 不合法" });
      continue;
    }
    try {
      const text = await fetchText(UPSTREAM_BASE + "/" + encodeURIComponent(it.file));
      if (text.length > MAX_FILE_BYTES) throw new Error("文件超过 1MB");
      validateBaselineJSON(it.id, text);
      const fp = path.join(dir, it.id + ".json");
      let existed = true;
      let same = false;
      try {
        same = (await fs.readFile(fp, "utf8")) === text;
      } catch {
        existed = false;
      }
      if (same) continue;
      await fs.writeFile(fp, text, "utf8");
      (existed ? updated : added).push(it.id);
    } catch (e) {
      skipped.push({ id: it.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // 清单最后写：部分基准失败时 index 与磁盘文件保持一致（失败的仍沿用旧文件，
  // 不在 index 里剔除——上游清单是权威，用户应该知道哪些没拉下来）。
  await fs.writeFile(path.join(dir, "index.json"), indexText, "utf8");

  return ok({
    total: items.length,
    added,
    updated,
    unchanged: items.length - added.length - updated.length - skipped.length,
    skipped,
  });
}
