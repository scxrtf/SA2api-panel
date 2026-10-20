import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { promises as fs } from "fs";
import path from "path";
import { BASELINE_ID_RE, parseBaselineIndex } from "@/lib/aichecker-official";
import {
  fetchUpstreamText, MAX_BASELINE_FILE_BYTES, validateBaselineJSON,
} from "@/lib/aichecker-upstream";

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;

  const dir = path.join(process.cwd(), "public", "aichecker", "baselines");

  let indexText: string;
  try {
    indexText = await fetchUpstreamText("index.json");
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
      const text = await fetchUpstreamText(it.file);
      if (text.length > MAX_BASELINE_FILE_BYTES) throw new Error("文件超过 1MB");
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
