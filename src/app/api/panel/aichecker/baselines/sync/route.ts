import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { promises as fs } from "fs";
import path from "path";
import { BASELINE_ID_RE, parseBaselineIndex } from "@/lib/aichecker-official";

// 上游基准仓库（hlwy-ai-checker）。官方快照平时随站点部署在
// public/aichecker/baselines，这里提供「手动拉取最新基准」的通道：
// 走 GitHub Contents API 而不是 raw.githubusercontent.com——后者在国内网络
// 常被重置导致整批 "fetch failed"，api.github.com 一般可达；少数被墙环境
// 再回退 raw。base64 解码后内容与 raw 完全一致，下游校验不变。
const UPSTREAM_BASE =
  "https://raw.githubusercontent.com/hanlinwenyuan/hlwy-ai-checker/main/baselines";
const API_CONTENTS_BASE =
  "https://api.github.com/repos/hanlinwenyuan/hlwy-ai-checker/contents/baselines";
const FETCH_TIMEOUT_MS = 15_000;
// 基准 JSON 约 5KB/个，355 桶分布；限制单文件 1MB 防止异常响应撑爆内存。
const MAX_FILE_BYTES = 1_000_000;

async function fetchRaw(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: ac.signal,
      headers: {
        Accept: "application/vnd.github.raw+json",
        "User-Agent": "wb2api-panel",
      },
    });
    if (!res.ok) throw new Error("http " + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// fetchUpstreamText 优先 GitHub Contents API（带 ?ref=main 固定分支），
// 网络层错误（连接重置/超时）或 5xx 时回退 raw 域名；4xx 属资源不存在，
// 直接抛出不回退，避免把 404 重试成无效请求。
async function fetchUpstreamText(file: string): Promise<string> {
  const enc = encodeURIComponent(file);
  try {
    return await fetchRaw(API_CONTENTS_BASE + "/" + enc + "?ref=main");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const m = /^http (\d+)$/.exec(msg);
    if (m && Number(m[1]) >= 400 && Number(m[1]) < 500) throw e;
    // 落到 raw 再试一次；两个通道都挂才报失败。
    return await fetchRaw(UPSTREAM_BASE + "/" + enc);
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
