import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { dataRoot } from "../../src/lib/workspace/settings";
import type { Session, Status } from "../../src/lib/workspace/contracts";
import type { SessionRecord } from "../../src/lib/workspace/store";
import { childEnv } from "./files";
import { traceText, type Bridge, type RunResult } from "./bridge";

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value && typeof value === "object" && !Array.isArray(value) ? value as Obj : {};
const str = (value: unknown) => typeof value === "string" ? value : "";
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const statusOf = (value: unknown): Status => {
  if (value === "completed" || value === "success") return "completed";
  if (value === "failed" || value === "error" || value === "errored" || value === "declined" || value === "notFound") return "failed";
  if (value === "interrupted" || value === "shutdown" || value === "cancelled") return "cancelled";
  return "running";
};

export function findCodex(): string | undefined {
  const configured = process.env.WB2_WORKSPACE_CODEX_BIN;
  if (configured) return existsSync(resolve(configured)) ? resolve(configured) : undefined;
  const windows = process.platform === "win32";
  const filename = windows ? "codex.exe" : "codex";
  const onPath = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir.replace(/^"|"$/g, ""), filename)).find(existsSync);
  if (onPath || !windows) return onPath;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const target = arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const candidates = [process.env.APPDATA && join(process.env.APPDATA, "npm"), ...((process.env.PATH ?? "").split(delimiter))].filter(Boolean) as string[];
  return candidates.map((dir) => join(dir.replace(/^"|"$/g, ""), "node_modules", "@openai", "codex", "node_modules", "@openai", `codex-win32-${arch}`, "vendor", target, "bin", filename)).find(existsSync);
}

export class AppServer {
  private counter = 0;
  private pending = new Map<number, { ok: (value: Obj) => void; fail: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private lines: ReturnType<typeof createInterface>;
  private closeResolve!: (error: Error) => void;
  private error?: Error;
  readonly ended = new Promise<Error>((resolve) => { this.closeResolve = resolve; });
  readonly exited: Promise<void>;
  private log = "";

  constructor(readonly child: ChildProcessWithoutNullStreams, onEvent: (method: string, params: Obj) => void) {
    this.exited = new Promise((done) => child.once("close", () => done()));
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stderr.on("data", (chunk: Buffer) => { this.log = (this.log + chunk.toString("utf8")).slice(-2500); });
    child.on("error", (error) => this.end(error));
    child.stdin.on("error", (error) => this.end(error));
    child.on("close", (code) => this.end(new Error(`Codex App Server 退出（${code ?? "信号"}）。${traceText(this.log, 260)}`)));
    this.lines.on("line", (line) => {
      if (line.length > 16 * 1024 * 1024) return;
      let msg: Obj;
      try { msg = obj(JSON.parse(line)); } catch { return; }
      const id = msg.id;
      const method = str(msg.method);
      if (method) {
        if (id !== undefined) {
          this.write({ id, error: { code: -32601, message: "No interactive client is attached to approve this request." } });
        } else {
          try { onEvent(method, obj(msg.params)); } catch (error) {
            this.end(error instanceof Error ? error : new Error("Codex 执行事件处理失败。"));
            this.close();
          }
        }
        return;
      }
      if (typeof id !== "number") return;
      const awaiting = this.pending.get(id);
      if (!awaiting) return;
      this.pending.delete(id);
      clearTimeout(awaiting.timer);
      if (msg.error) awaiting.fail(new Error(traceText(str(obj(msg.error).message) || "Codex RPC 执行失败。", 400)));
      else awaiting.ok(obj(msg.result));
    });
  }
  private end(error: Error) {
    if (this.error) return;
    this.error = error;
    for (const { timer, fail } of this.pending.values()) { clearTimeout(timer); fail(error); }
    this.pending.clear();
    this.closeResolve(error);
  }
  private write(value: Obj) {
    if (!this.error && !this.child.stdin.destroyed) this.child.stdin.write(JSON.stringify(value) + "\n");
  }
  ask(method: string, params: Obj, timeout = 30_000): Promise<Obj> {
    const id = ++this.counter;
    if (this.error) return Promise.reject(this.error);
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new Error(`Codex RPC 超时：${method}`));
      }, timeout);
      this.pending.set(id, { ok, fail, timer });
      this.write({ method, id, params });
    });
  }
  notify(method: string, params?: Obj) { this.write({ method, params }); }
  close() {
    this.lines.close();
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
}

export function codexEvents(bridge: Bridge, findThread: () => string) {
  const children = new Map<string, Session>();
  const childText = new Map<string, string>();
  const deferred: { method: string; params: Obj }[] = [];
  const toolLabels: Record<string, string> = {
    commandExecution: "命令", fileChange: "修改文件", mcpToolCall: "MCP 工具", dynamicToolCall: "工具",
    webSearch: "网页检索", collabAgentToolCall: "Codex 分派",
  };
  const apply = (method: string, params: Obj, buffer = true) => {
    const threadId = str(params.threadId);
    const session = threadId === findThread() ? bridge.session : children.get(threadId);
    if (!session) {
      if (threadId && buffer && deferred.length < 150) deferred.push({ method, params });
      return;
    }
    if (method === "item/agentMessage/delta") {
      bridge.replyDelta(str(params.itemId), str(params.delta), session);
      return;
    }
    if (method !== "item/started" && method !== "item/completed") return;
    const item = obj(params.item);
    const type = str(item.type);
    const id = str(item.id);
    const done = method === "item/completed";
    if (!id) return;
    if (type === "agentMessage" && done) {
      bridge.reply(id, str(item.text), "completed", session);
      return;
    }
    if (!toolLabels[type]) return;
    const toolName = type === "mcpToolCall" ? [str(item.server), str(item.tool)].filter(Boolean).join(" / ") : str(item.tool);
    let detail = "";
    if (type === "commandExecution" && done && typeof item.exitCode === "number") {
      detail = `退出码 ${item.exitCode}`;
    } else if (type === "fileChange") {
      detail = array(item.changes).slice(0, 18).map((change) => str(obj(change).path).replaceAll("\\", "/").split("/").pop() ?? "").join("\n");
    }
    const observedStatus = statusOf(item.status);
    const nodeId = bridge.tool(id, [toolLabels[type], toolName].filter(Boolean).join(" / "), done ? observedStatus === "running" ? "completed" : observedStatus : "running", detail, session);
    if (type !== "collabAgentToolCall") return;
    const states = obj(item.agentsStates);
    const ids = new Set([...array(item.receiverThreadIds).filter((id): id is string => typeof id === "string"), ...Object.keys(states)]);
    for (const childId of ids) {
      if (childId === findThread()) continue;
      let child = children.get(childId);
      if (!child && children.size < 24) {
        child = bridge.nativeBranch(childId, children.size + 1, nodeId);
        if (child) children.set(childId, child);
      }
      if (!child) continue;
      const state = obj(states[childId]);
      if (state.status) bridge.tool("native-state", "子代理状态", statusOf(state.status), "", child);
      const message = str(state.message);
      if (message && childText.get(childId) !== message) {
        childText.set(childId, message);
        bridge.reply("native-summary", message, "completed", child);
      }
      for (let i = 0; i < deferred.length; ) {
        if (deferred[i].params.threadId === childId) {
          const [event] = deferred.splice(i, 1);
          apply(event.method, event.params, false);
        } else i++;
      }
    }
  };
  return apply;
}

export async function codexRun(bridge: Bridge, session: SessionRecord, prompt: string, signal: AbortSignal, executable: string): Promise<RunResult> {
  if (signal.aborted) return { text: "", cancelled: true };
  const cwd = session.cwd;
  if (!cwd) throw new Error("Codex 会话缺少 Git 检出。");
  const home = resolve(process.env.WB2_WORKSPACE_CODEX_HOME || join(dataRoot(), "codex-home"));
  await mkdir(home, { recursive: true });
  const readonly = session.role === "review" || bridge.job.phase === "join";
  const model = process.env.WB2_WORKSPACE_CODEX_MODEL?.trim();
  const apiKey = process.env.WB2_WORKSPACE_CODEX_API_KEY;
  let thread = "";
  let turn = "";
  let complete!: (value: Obj) => void;
  const finished = new Promise<Obj>((resolve) => { complete = resolve; });
  const observe = codexEvents(bridge, () => thread);
  const child = spawn(executable, ["app-server", "--listen", "stdio://", "--disable", "hooks", "-c", 'shell_environment_policy.inherit="none"'], {
    cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...childEnv(), CODEX_HOME: home,
      ...(apiKey ? { OPENAI_API_KEY: apiKey, WB2_WORKSPACE_CODEX_API_KEY: apiKey } : {}),
    },
  });
  const server = new AppServer(child, (method, params) => {
    if (thread && params.threadId === thread) {
      if (method === "turn/started") turn = str(obj(params.turn).id) || turn;
      if (method === "turn/completed") complete(obj(params.turn));
    }
    if (thread) observe(method, params);
  });
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    if (!turn) { server.close(); return; }
    void server.ask("turn/interrupt", { threadId: thread, turnId: turn }, 2500).catch(() => server.close());
    hardStop = setTimeout(() => server.close(), 5500);
  };
  signal.addEventListener("abort", interrupt, { once: true });
  try {
    if (signal.aborted) return { text: "", cancelled: true };
    await server.ask("initialize", { clientInfo: { name: "wb2api_workspace", title: "WB2API Workspace", version: "0.1.0" } });
    server.notify("initialized");
    const settings = { cwd, ...(model ? { model } : {}), approvalPolicy: "never", sandbox: readonly ? "read-only" : "workspace-write" };
    const opened = session.engineRef
      ? await server.ask("thread/resume", { ...settings, threadId: session.engineRef, excludeTurns: true })
      : await server.ask("thread/start", settings);
    thread = str(obj(opened.thread).id);
    if (!thread) throw new Error("Codex 未返回线程 ID。");
    bridge.store.setSessionRuntime(bridge.ticket, { engineRef: thread });
    const result = await server.ask("turn/start", {
      threadId: thread, cwd,
      approvalPolicy: "never",
      sandboxPolicy: readonly ? { type: "readOnly", networkAccess: false } : {
        type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true,
      },
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    turn = str(obj(result.turn).id) || turn;
    const outcome = await Promise.race([finished, server.ended.then((error) => { throw error; })]);
    bridge.flush();
    if (signal.aborted || outcome.status === "interrupted") return { ...bridge.result(), cancelled: true };
    if (outcome.status !== "completed") throw new Error(traceText(str(obj(outcome.error).message) || "Codex 任务失败。", 500));
    return bridge.result();
  } catch (error) {
    if (signal.aborted) return { ...bridge.result(), cancelled: true };
    throw error;
  } finally {
    signal.removeEventListener("abort", interrupt);
    if (hardStop) clearTimeout(hardStop);
    bridge.flush();
    server.close();
    await Promise.race([server.exited, sleep(2500, undefined, { ref: false })]);
  }
}
