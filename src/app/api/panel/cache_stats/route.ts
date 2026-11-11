// 缓存状态汇总：进程内各层缓存的实时条目与 TTL，供面板「缓存详细」页展示。
import { ok, panelAuth } from "@/lib/panel-auth";
import { usageCacheStats } from "@/lib/usage-cache";
import { panelCacheStats } from "@/lib/panel-cache";
import { databaseCacheStats } from "../database/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;

  const usage = usageCacheStats();
  const database = databaseCacheStats();
  const panel = panelCacheStats();
  const PANEL_TTL_MS = 3_600_000;

  return ok({
    at: Date.now(),
    layers: [
      {
        name: "面板数据缓存（panel-cache）",
        scope: "服务端进程内",
        ttlMs: PANEL_TTL_MS,
        maxEntries: null,
        size: panel.size,
        entries: panel.entries.map((e) => ({
          key: e.key,
          ttlMs: Math.max(e.ttlMs - e.ageMs, 0),
        })),
        note: "积分构成 / 模型与档位 / 模型鉴别缓存 1 小时，余额趋势缓存 60 秒；"
          + "手动刷新带 ?refresh=1 立即绕过，基准保存/删除/同步后自动失效对应条目。",
        visible: true,
      },
      {
        name: "用量聚合短缓存（usage-cache）",
        scope: "服务端进程内",
        ttlMs: usage.ttlMs,
        maxEntries: usage.maxEntries,
        size: usage.size,
        entries: usage.entries,
        note: "相同聚合查询 20 秒内只访问一次数据库；并发请求共享 Promise。",
        visible: true,
      },
      {
        name: "CloudBase 监控缓存（database 路由）",
        scope: "服务端进程内",
        ttlMs: database.cacheMs,
        cached: database.cached,
        remainingMs: database.ttlMs,
        size: database.cached ? 1 : 0,
        maxEntries: 1,
        entries: database.cached ? [{ key: "database:stats", ttlMs: database.ttlMs }] : [],
        note: "整份 Stats JSON 缓存 1 小时；POST 清理动作与 ?refresh=1 会立即失效。",
        visible: true,
      },
    ],
  });
}
