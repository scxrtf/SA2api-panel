import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { mock } from "node:test";

process.env.USE_CLOUDBASE_REST = "1";

test("定时保留策略不再无条件清理全部请求对话", async () => {
  const queries: Record<string, unknown>[] = [];
  mock.module(new URL("../src/lib/db.ts", import.meta.url).href, {
    namedExports: {
      prisma: {
        requestLog: {
          async findMany(args: Record<string, unknown>) {
            queries.push(args);
            const where = args["where"] as { at?: unknown } | undefined;
            assert.ok(where?.at, "每次读取日志都必须带到期时间条件");
            return [];
          },
        },
        modelHealthCheck: {
          async deleteMany() { return { count: 0 }; },
        },
      },
    },
  });
  mock.module(new URL("../src/lib/runlog.ts", import.meta.url).href, {
    namedExports: { runlog() { return ""; } },
  });
  const { clearRequestLogDetails, runRetention } = await import("../src/lib/retention.ts");
  const result = await runRetention();
  assert.equal(queries.length, 2, "只查询到期详情与到期日志，不查询全部对话");
  assert.equal(result.detailCleared, 0);
  assert.equal(result.rowsDeleted, 0);
  assert.equal(result.healthDeleted, 0);
  assert.equal("dialogCleared" in result, false);
  assert.equal(await clearRequestLogDetails(0), 0, "0 小时表示禁用详情清理");
  assert.equal(queries.length, 2, "禁用详情清理时不应查询或修改日志");
});

test("详情清理同时覆盖过期的对话正文", async () => {
  const source = await readFile(new URL("../src/lib/retention.ts", import.meta.url), "utf8");
  const detailStart = source.indexOf("export async function clearRequestLogDetails");
  const detailEnd = source.indexOf("export async function pruneRequestLogs", detailStart);
  const detail = source.slice(detailStart, detailEnd);
  assert.match(detail, /requestMessages:\s*NIL,\s*responseMessage:\s*NIL/);
  assert.match(detail, /at:\s*\{\s*lt:\s*cutoff\s*\}/);
});
