import { randomUUID } from "node:crypto";
import { enabled } from "../../src/lib/workspace/settings";
import { workspaceStore } from "../../src/lib/workspace/store";

const prompt = process.argv.slice(2).join(" ").trim();
if (!enabled() || !prompt || prompt.length > 24_000) {
  console.error('请启用工作区，并运行 npm run workspace:codex -- "任务描述"（最多 24000 字符）。');
  process.exit(1);
}
const store = workspaceStore();
try {
  const run = store.send({ key: randomUUID(), engine: "codex", mode: "single", prompt });
  console.log(`Codex 任务已入队：${run.id}\n工作区链接：/panel/workspace?session=${run.sessionId}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Codex 任务入队失败。");
  process.exitCode = 1;
} finally { store.close(); }
