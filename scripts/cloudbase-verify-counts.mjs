// CloudBase PostgREST 行数对拍：manifest.json 导出口径 vs 当前目标库实时 count。
import { config } from "dotenv";
config();
process.env.USE_CLOUDBASE_REST = "1";
import { readFileSync } from "node:fs";
const { dal } = await import("../src/lib/dal.ts");

const manifest = JSON.parse(readFileSync("backup-cloudbase-migration-20261110/manifest.json", "utf8"));
const MODEL = {
  Account: "account", ApiKey: "apiKey", BalanceSample: "balanceSample",
  LoginSession: "loginSession", ModelCooldown: "modelCooldown", ModelCost: "modelCost",
  ModelHealthCheck: "modelHealthCheck", ModelProbe: "modelProbe", Provider: "provider",
  RequestLog: "requestLog", Setting: "setting", StickySession: "stickySession",
  TaskQueueItem: "taskQueueItem", UsageEvent: "usageEvent",
};

let fail = 0;
for (const [table, meta] of Object.entries(manifest.tables)) {
  const model = MODEL[table];
  if (!model) continue; // _prisma_migrations 等
  const got = await dal[model].count();
  const want = meta.rows;
  const okMark = got >= want ? "OK " : "MISMATCH";
  if (got < want) fail++;
  console.log(`${okMark} ${table.padEnd(22)} manifest=${want}  cloudbase=${got}`);
}
console.log(fail ? `FAIL: ${fail} tables below manifest` : "ALL PASS");
