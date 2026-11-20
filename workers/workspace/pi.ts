import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAgentSession, createExtensionRuntime, defineTool, ModelRuntime, SessionManager, SettingsManager, type ResourceLoader } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { dataRoot } from "../../src/lib/workspace/settings";
import type { SessionRecord } from "../../src/lib/workspace/store";
import { listProjectFiles, readProjectFile, within, writeProjectFile } from "./files";
import { traceText, type Bridge, type RunResult } from "./bridge";

const provider = "wb2_workbench";
export function piConfiguration() {
  const model = process.env.WB2_WORKSPACE_PI_MODEL?.trim();
  const key = process.env.WB2_WORKSPACE_GATEWAY_KEY;
  const base = process.env.WB2_WORKSPACE_GATEWAY_URL?.trim() || "http://127.0.0.1:3000/api/v1";
  let url: URL;
  try { url = new URL(base); } catch { return undefined; }
  if (!model || !key || url.username || url.password || url.search || url.hash
      || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))) return undefined;
  return { model, key, base: base.replace(/\/+$/, "") };
}

export async function piRun(bridge: Bridge, source: SessionRecord, prompt: string, signal: AbortSignal): Promise<RunResult> {
  const config = piConfiguration();
  const cwd = source.cwd;
  if (!config || !cwd) throw new Error("请配置 Pi 网关、模型和工作目录。");
  const home = resolve(dataRoot(), "pi", source.id);
  const transcripts = join(home, "sessions");
  await mkdir(transcripts, { recursive: true });
  const modelsPath = join(home, "models.json");
  await writeFile(modelsPath, JSON.stringify({ providers: {
    [provider]: { baseUrl: config.base, api: "openai-completions",
      models: [{ id: config.model, name: config.model, reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 8192 }] },
  } }), "utf8");
  const modelRuntime = await ModelRuntime.create({
    authPath: join(home, "auth.json"), modelsPath, modelsStorePath: join(home, "catalog.json"),
    allowModelNetwork: false, refreshOnCreate: false, signal,
  });
  await modelRuntime.setRuntimeApiKey(provider, config.key);
  const model = modelRuntime.getModel(provider, config.model);
  if (!model) throw new Error("Pi 模型配置无效。");
  const engineRef = source.engineRef ? resolve(source.engineRef) : undefined;
  if (engineRef && (!within(transcripts, engineRef) || !existsSync(engineRef))) throw new Error("历史 Pi 会话文件已移动或缺失。");
  const manager = engineRef ? SessionManager.open(engineRef, transcripts, cwd) : SessionManager.create(cwd, transcripts);
  const readonly = source.role === "review" || bridge.job.phase === "join";
  const loader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => [
      "You are a software-development assistant in the registered project checkout.",
      "Use available tools only for the requested work. Read source before editing; do not access credential files.",
      "Do not claim to have run tests that were not executed. Respond in the user's language.",
      readonly ? "This turn is read-only. Summarize evidence, caveats and handoff." : "Save the requested files inside your checkout.",
    ].join(" "),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const answer = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
  const listing = defineTool({
    name: "workspace_list", label: "列出项目文件", description: "List tracked project file paths and nonignored new files.",
    parameters: Type.Object({}),
    async execute() { signal.throwIfAborted(); return answer(await listProjectFiles(cwd)); },
  });
  const readTool = defineTool({
    name: "workspace_read", label: "读取文件", description: "Read a UTF-8 file within the current Git checkout.",
    parameters: Type.Object({ path: Type.String({ maxLength: 500 }) }),
    async execute(_id, { path }) { signal.throwIfAborted(); return answer(await readProjectFile(cwd, path)); },
  });
  const writeTool = defineTool({
    name: "workspace_write", label: "写入文件", description: "Write UTF-8 contents atomically to a path inside this checkout.",
    parameters: Type.Object({ path: Type.String({ maxLength: 500 }), text: Type.String({ maxLength: 290000 }) }),
    executionMode: "sequential",
    async execute(_id, { path, text }) {
      signal.throwIfAborted();
      await writeProjectFile(cwd, path, text);
      return answer("Saved " + path);
    },
  });
  const customTools = readonly ? [listing, readTool] : [listing, readTool, writeTool];
  const { session } = await createAgentSession({
    cwd, agentDir: home, model, modelRuntime, resourceLoader: loader,
    noTools: "builtin", tools: customTools.map((tool) => tool.name), customTools,
    thinkingLevel: "off", sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
  });
  let responseIndex = 0;
  let aborted = false;
  let error = "";
  let projectionError: unknown;
  const toolLabels = new Map(customTools.map((tool) => [tool.name, tool.label]));
  const toolPaths = new Map<string, string>();
  const stop = () => { void session.abort().catch(() => undefined); };
  const unsubscribe = session.subscribe((event) => {
    try {
      if (event.type === "message_start" && event.message.role === "assistant") responseIndex++;
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        bridge.replyDelta(String(responseIndex), event.assistantMessageEvent.delta);
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message;
        const text = message.content.map((item) => item.type === "text" ? item.text : "").join("");
        error = message.stopReason === "error" ? message.errorMessage || "Pi 模型请求失败。" : "";
        bridge.reply(String(responseIndex), text, error ? "failed" : message.stopReason === "aborted" ? "cancelled" : "completed");
      }
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        const stage = event.type === "tool_execution_start" ? "running" : event.isError ? "failed" : "completed";
        const args = event.type === "tool_execution_start" ? event.args : undefined;
        const params = args && typeof args === "object" ? args as { path?: unknown } : {};
        if (typeof params.path === "string") toolPaths.set(event.toolCallId, params.path);
        bridge.tool(event.toolCallId, toolLabels.get(event.toolName) ?? event.toolName, stage, toolPaths.get(event.toolCallId) ?? "");
        if (event.type === "tool_execution_end") toolPaths.delete(event.toolCallId);
      }
      if (event.type === "agent_settled") aborted = event.aborted;
    } catch (err) { projectionError = err; }
  });
  signal.addEventListener("abort", stop, { once: true });
  try {
    if (signal.aborted) return { text: "", cancelled: true };
    if (session.getActiveToolNames().some((tool) => !toolLabels.has(tool))) throw new Error("Pi 加载了未注册工具。");
    await session.prompt(prompt);
    if (projectionError) throw projectionError;
    if (error) throw new Error(traceText(error, 500));
    return { ...bridge.result(), cancelled: signal.aborted || aborted };
  } finally {
    signal.removeEventListener("abort", stop);
    unsubscribe();
    session.dispose();
    bridge.flush();
    const file = manager.getSessionFile();
    if (file && within(transcripts, file) && existsSync(file)) bridge.store.setSessionRuntime(bridge.ticket, { engineRef: file });
  }
}
