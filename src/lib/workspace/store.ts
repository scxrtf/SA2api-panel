import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import proc from "node:process";
import {
  projectActivity, runNode, runStatusActivity, statusName, terminal, TEXT_LIMIT,
  type Activity, type Artifact, type Change, type Engine, type GatewaySource, type GraphNode, type Mode, type Role,
  type Run, type Session, type Snapshot, type WorkerState, type WorkspaceEvent,
} from "./contracts";
import { dataRoot, WorkspaceError } from "./settings";

interface Statement {
  get(...values: unknown[]): unknown;
  all(...values: unknown[]): unknown[];
  run(...values: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
}
interface Database {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
}
export interface SessionRecord extends Session {
  cwd?: string;
  base?: string;
  engineRef?: string;
}
export interface Job extends Run {
  prompt: string;
  parents: string[];
  context?: string;
  summary?: string;
}
export interface Ticket { job: Job; worker: string }
export interface GatewayInput {
  source: GatewaySource;
  thread?: string;
  parent?: string;
  previous?: string;
  prefixes: string[];
  toolResults: string[];
  prompt: string;
}
export interface GatewayTicket { runId: string; sessionId: string; machineId: string }
type GatewayAlias = { session_id: string; node_id: string; label: string };
interface Send {
  key: string;
  engine: Engine;
  prompt: string;
  mode: Mode;
  sessionId?: string;
  forkNodeId?: string;
  retryOf?: string;
}
const LEASE_MS = 30_000;
const MAX_ARTIFACT = 2 * 1024 * 1024;
const dbJson = (value: unknown) => JSON.stringify(value);
const parsed = <T>(value: unknown) => (value ? JSON.parse((value as { json: string }).json) as T : undefined);

function publicSession({ cwd: _cwd, base: _base, engineRef: _engineRef, ...session }: SessionRecord): Session {
  void _cwd; void _base; void _engineRef;
  return session;
}
function publicRun({ prompt: _prompt, context: _context, parents: _parents, summary: _summary, ...run }: Job): Run {
  void _prompt; void _context; void _parents; void _summary;
  return run;
}

export class WorkspaceStore {
  private db: Database;
  constructor(path: string, busyTimeout = 5000) {
    // Lazy: the rest of the panel can still load on older Node versions when the workspace is off.
    const sqlite = (proc as typeof proc & { getBuiltinModule?(name: string): unknown }).getBuiltinModule?.("node:sqlite") as { DatabaseSync: new (path: string) => Database } | undefined;
    if (!sqlite) throw new WorkspaceError("代理工作区需要 Node.js 22.19 或以上版本。", 503);
    const { DatabaseSync } = sqlite;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeout))};`);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS ws_sessions (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ws_runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES ws_sessions(id), parent_run TEXT,
        status TEXT NOT NULL, worker TEXT, lease INTEGER, created INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ws_queue ON ws_runs(status, created);
      CREATE INDEX IF NOT EXISTS ws_runs_session ON ws_runs(session_id, created);
      CREATE INDEX IF NOT EXISTS ws_runs_parent ON ws_runs(parent_run, created);
      CREATE TABLE IF NOT EXISTS ws_commands (key TEXT PRIMARY KEY, digest TEXT NOT NULL, run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ws_events (seq INTEGER PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ws_nodes (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ws_activity (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ws_activity_seq ON ws_activity(seq);
      CREATE INDEX IF NOT EXISTS ws_nodes_seq ON ws_nodes(seq);
      CREATE TABLE IF NOT EXISTS ws_artifacts (id TEXT PRIMARY KEY, json TEXT NOT NULL, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS ws_integrations (artifact_id TEXT PRIMARY KEY, status TEXT NOT NULL, path TEXT);
      CREATE TABLE IF NOT EXISTS ws_meta (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ws_gateway_alias (
        machine_id TEXT NOT NULL, kind TEXT NOT NULL, alias TEXT NOT NULL,
        session_id TEXT NOT NULL REFERENCES ws_sessions(id), node_id TEXT NOT NULL, label TEXT NOT NULL,
        PRIMARY KEY(machine_id, kind, alias, session_id)
      );
    `);
  }
  close() { this.db.close(); }
  private tx<T>(fn: () => T, write = true): T {
    this.db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private append(change: Change) {
    const seq = Number(this.db.prepare("INSERT INTO ws_events(json) VALUES (?)").run(dbJson(change)).lastInsertRowid);
    if (change.node) {
      const previous = this.node(change.node.id);
      const node = { ...change.node, seq: previous?.seq ?? seq };
      this.db.prepare("INSERT INTO ws_nodes VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json")
        .run(node.id, node.seq, dbJson(node));
    }
    if (change.activity) {
      const old = parsed<Activity>(this.db.prepare("SELECT json FROM ws_activity WHERE id=?").get(change.activity.id));
      const activity = projectActivity(old, change.activity, !!change.append, seq);
      this.db.prepare("INSERT INTO ws_activity VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json")
        .run(activity.id, activity.seq, dbJson(activity));
    }
    return seq;
  }
  cursor() {
    return (this.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM ws_events").get() as { seq: number }).seq;
  }
  events(after: number, limit = 128): WorkspaceEvent[] {
    return (this.db.prepare("SELECT seq,json FROM ws_events WHERE seq>? ORDER BY seq LIMIT ?").all(after, limit) as { seq: number; json: string }[])
      .map(({ seq, json }) => ({ ...JSON.parse(json) as Change, seq }));
  }
  snapshot(): Snapshot {
    return this.tx(() => ({
      cursor: this.cursor(),
      sessions: this.db.prepare("SELECT json FROM ws_sessions ORDER BY rowid").all().map((row) => publicSession(parsed<SessionRecord>(row)!)),
      runs: this.db.prepare("SELECT json FROM ws_runs ORDER BY created, rowid").all().map((row) => publicRun(parsed<Job>(row)!)),
      nodes: this.db.prepare("SELECT json FROM ws_nodes ORDER BY seq").all().map((row) => parsed<GraphNode>(row)!),
      activities: this.db.prepare("SELECT json FROM ws_activity ORDER BY seq").all().map((row) => parsed<Activity>(row)!),
      artifacts: this.db.prepare("SELECT json FROM ws_artifacts ORDER BY rowid").all().map((row) => parsed<Artifact>(row)!),
      worker: this.workerState(),
    }), false);
  }
  heartbeat(state: WorkerState) {
    this.db.prepare("INSERT INTO ws_meta VALUES ('worker',?) ON CONFLICT(id) DO UPDATE SET json=excluded.json").run(dbJson(state));
  }
  workerState(): WorkerState | null {
    return parsed<WorkerState>(this.db.prepare("SELECT json FROM ws_meta WHERE id='worker'").get()) ?? null;
  }
  session(id: string): SessionRecord | undefined {
    return parsed<SessionRecord>(this.db.prepare("SELECT json FROM ws_sessions WHERE id=?").get(id));
  }
  job(id: string): Job | undefined {
    return parsed<Job>(this.db.prepare("SELECT json FROM ws_runs WHERE id=?").get(id));
  }
  private node(id: string) {
    return parsed<GraphNode>(this.db.prepare("SELECT json FROM ws_nodes WHERE id=?").get(id));
  }
  private addSession(engine: Engine, name: string, role: Role, parent?: SessionRecord, forkNodeId?: string): SessionRecord {
    const id = randomUUID();
    const session: SessionRecord = { id, rootId: parent?.rootId ?? id, parentId: parent?.id, forkNodeId, name, engine, role, createdAt: Date.now(), base: parent?.base };
    this.db.prepare("INSERT INTO ws_sessions VALUES (?,?)").run(id, dbJson(session));
    this.append({ session: publicSession(session) });
    return session;
  }
  private changeRun(job: Job, beacon = false) {
    const id = runNode(job.id);
    const old = this.node(id);
    const label = job.gateway ? job.gateway.protocol === "compact" ? "上下文压缩" : "模型请求" : job.parentRunId ? "子代理执行" : "任务执行";
    this.db.prepare("UPDATE ws_runs SET status=?,json=? WHERE id=?").run(job.status, dbJson(job), job.id);
    this.append({
      run: publicRun(job),
      node: {
        id, sessionId: job.sessionId, runId: job.id, kind: "run", label, status: job.status,
        parents: old?.parents ?? job.parents, activityId: runStatusActivity(job.id),
      },
      activity: {
        id: runStatusActivity(job.id), sessionId: job.sessionId, runId: job.id, kind: "status",
        title: statusName[job.status], text: job.detail ?? "", status: job.status,
      },
      beacon: beacon ? { from: "model", fromId: job.sessionId, nodeId: job.phase === "join" ? `merge:${job.id}` : id } : undefined,
    });
  }
  private addRun(job: Job, showPrompt = job.prompt, beacon = false) {
    this.db.prepare("INSERT INTO ws_runs(id,session_id,parent_run,status,created,json) VALUES (?,?,?,?,?,?)")
      .run(job.id, job.sessionId, job.parentRunId ?? null, job.status, job.createdAt, dbJson(job));
    this.append({ activity: {
      id: `input:${job.id}`, sessionId: job.sessionId, runId: job.id, kind: "user", title: job.gateway ? "客户端请求" : "任务", text: showPrompt,
    } });
    this.changeRun(job, beacon);
  }
  private gatewayAlias(machineId: string, kind: string, alias?: string): GatewayAlias | undefined {
    if (!alias) return undefined;
    const rows = this.db.prepare("SELECT session_id,node_id,label FROM ws_gateway_alias WHERE machine_id=? AND kind=? AND alias=? LIMIT 2")
      .all(machineId, kind, alias) as GatewayAlias[];
    return rows.length === 1 ? rows[0] : undefined;
  }
  private saveGatewayAlias(machineId: string, kind: string, alias: string | undefined, sessionId: string, nodeId: string, label = "") {
    if (!alias) return;
    this.db.prepare(`
      INSERT INTO ws_gateway_alias VALUES (?,?,?,?,?,?)
      ON CONFLICT(machine_id,kind,alias,session_id) DO UPDATE SET node_id=excluded.node_id,label=excluded.label
    `).run(machineId, kind, alias, sessionId, nodeId, label);
  }
  private gatewayTail(sessionId: string) {
    const row = this.db.prepare(`
      SELECT json FROM ws_nodes WHERE json_extract(json,'$.sessionId')=?
      AND json_extract(json,'$.kind') IN ('run','reply') ORDER BY seq DESC LIMIT 1
    `).get(sessionId);
    return parsed<GraphNode>(row)?.id;
  }
  beginGateway(input: GatewayInput): GatewayTicket {
    return this.tx(() => {
      const { machineId } = input.source;
      const explicit = this.gatewayAlias(machineId, "thread", input.thread);
      const response = this.gatewayAlias(machineId, "response", input.previous);
      const toolLinks = input.toolResults.map((alias) => this.gatewayAlias(machineId, "tool", alias)).filter((link): link is GatewayAlias => !!link);
      const tool = new Set(toolLinks.map((link) => link.session_id)).size === 1 ? toolLinks[0] : undefined;
      const history = !input.thread ? input.prefixes.map((alias) => this.gatewayAlias(machineId, "history", alias)).find(Boolean) : undefined;
      const previous = explicit ?? (!input.thread ? response ?? tool ?? history : undefined);
      let session = previous && this.session(previous.session_id);
      const id = randomUUID();
      const source: GatewaySource = {
        ...input.source,
        correlation: input.thread ? "explicit" : response ? "response" : tool ? "tool" : history ? "history" : "unlinked",
        lastStatus: "running", lastRunId: id,
      };
      let anchor = session && [response, tool, history].find((link) => link?.session_id === session!.id)?.node_id;
      if (!session) {
        const origin = input.parent && input.parent !== input.thread ? this.gatewayAlias(machineId, "thread", input.parent) : undefined;
        const parent = origin && this.session(origin.session_id);
        const sessionId = randomUUID();
        const target = parent ? this.gatewayTail(parent.id) : undefined;
        const forkId = target ? `observed-fork:${id}` : undefined;
        session = {
          id: sessionId, rootId: parent?.rootId ?? sessionId, parentId: parent?.id, forkNodeId: forkId,
          engine: source.client === "Codex" ? "codex" : "pi", role: "owner",
          name: input.prompt.replace(/\s+/g, " ").slice(0, 56) || `${source.client} 会话 ${sessionId.slice(0, 6)}`,
          gateway: source, createdAt: source.lastAt,
        };
        this.db.prepare("INSERT INTO ws_sessions VALUES (?,?)").run(session.id, dbJson(session));
        this.append({ session: publicSession(session) });
        if (forkId && target) {
          this.append({ node: {
            id: forkId, sessionId: session.id, runId: id, kind: "fork", label: "客户端上报分支", parents: [target], activityId: `input:${id}`,
          } });
          anchor = forkId;
        }
      } else {
        if (source.correlation === "unlinked" && session.gateway) source.correlation = session.gateway.correlation;
        session.gateway = source;
        this.db.prepare("UPDATE ws_sessions SET json=? WHERE id=?").run(dbJson(session), session.id);
        this.append({ session: publicSession(session) });
      }
      if (!anchor) anchor = this.gatewayTail(session.id);
      const job: Job = {
        id, sessionId: session.id, prompt: input.prompt, parents: anchor ? [anchor] : [], status: "running",
        mode: "single", phase: "execute", createdAt: source.lastAt,
        detail: source.model, gateway: { protocol: source.protocol, model: source.model },
      };
      this.addRun(job, input.prompt || (input.toolResults.length ? "客户端回传工具结果" : "已收到请求"), true);
      this.saveGatewayAlias(machineId, "thread", input.thread, session.id, runNode(id));
      for (const [index, tool] of input.toolResults.entries()) {
        const call = this.gatewayAlias(machineId, "tool", tool);
        const previousNode = call?.session_id === session.id ? call.node_id : undefined;
        const key = `observed-tool-result:${id}:${index}`;
        const label = call?.label ? `工具结果：${call.label}` : "工具结果已回传";
        this.append({
          node: { id: key, sessionId: session.id, runId: id, kind: "tool", label, parents: previousNode ? [previousNode, runNode(id)] : [runNode(id)], activityId: key, status: "completed" },
          activity: { id: key, sessionId: session.id, runId: id, kind: "tool", title: label, text: "", status: "completed" },
        });
      }
      return { runId: id, sessionId: session.id, machineId };
    });
  }
  gatewayTool(ticket: GatewayTicket, alias: string, label: string) {
    this.tx(() => {
      const job = this.job(ticket.runId);
      if (!job || job.status !== "running" || !job.gateway) return;
      const id = `observed-tool:${job.id}:${alias}`;
      if (this.node(id)) return;
      this.saveGatewayAlias(ticket.machineId, "tool", alias, ticket.sessionId, id, label);
      this.append({
        node: { id, sessionId: ticket.sessionId, runId: job.id, kind: "tool", label: `模型请求工具：${label}`, parents: [runNode(job.id)], activityId: id },
        activity: { id, sessionId: ticket.sessionId, runId: job.id, kind: "tool", title: `模型请求工具：${label}`, text: "由发起请求的客户端执行。" },
      });
    });
  }
  finishGateway(ticket: GatewayTicket, result: {
    status: "completed" | "failed" | "cancelled" | "interrupted";
    httpStatus?: number; detail?: string; text: string; hasReply: boolean;
    response?: string; history?: string;
  }) {
    this.tx(() => {
      const job = this.job(ticket.runId);
      if (!job || job.status !== "running" || !job.gateway) return;
      const tail = result.hasReply ? `observed-reply:${job.id}` : runNode(job.id);
      if (result.hasReply) {
        this.append({
          activity: { id: tail, sessionId: ticket.sessionId, runId: job.id, kind: "assistant", title: "模型回复", text: result.text || "已收到模型回复，正文未保存。", status: result.status },
          node: { id: tail, sessionId: ticket.sessionId, runId: job.id, kind: "reply", label: "模型回复", parents: [runNode(job.id)], activityId: tail, status: result.status },
          beacon: result.status === "completed" ? { from: "activity", fromId: tail, nodeId: tail } : undefined,
        });
      }
      if (result.status === "completed") {
        this.saveGatewayAlias(ticket.machineId, "response", result.response, ticket.sessionId, tail);
        this.saveGatewayAlias(ticket.machineId, "history", result.history, ticket.sessionId, tail);
      }
      job.status = result.status;
      job.gateway = { ...job.gateway, httpStatus: result.httpStatus, endedAt: Date.now() };
      job.detail = result.detail ?? (result.httpStatus ? `HTTP ${result.httpStatus}` : "");
      this.changeRun(job);
      const session = this.session(ticket.sessionId);
      if (session?.gateway?.lastRunId === job.id) {
        session.gateway.lastStatus = result.status;
        this.db.prepare("UPDATE ws_sessions SET json=? WHERE id=?").run(dbJson(session), session.id);
        this.append({ session: publicSession(session) });
      }
    });
  }
  gatewaySnapshot(selected?: string): Snapshot {
    return this.tx(() => {
      const sessions = this.db.prepare(`
        SELECT json FROM ws_sessions WHERE json_extract(json,'$.gateway') IS NOT NULL
        ORDER BY json_extract(json,'$.gateway.lastAt') DESC LIMIT 250
      `).all().map((row) => publicSession(parsed<SessionRecord>(row)!));
      const requested = selected ? this.session(selected) : undefined;
      const active = requested?.gateway ? requested : sessions[0];
      const lanes = active?.gateway ? this.db.prepare(`
        SELECT json FROM ws_sessions WHERE json_extract(json,'$.rootId')=?
        ORDER BY (id=? OR id=?) DESC, json_extract(json,'$.gateway.lastAt') DESC LIMIT 80
      `).all(active.rootId, active.id, active.rootId).map((row) => publicSession(parsed<SessionRecord>(row)!)) : [];
      const listed = new Set(sessions.map(({ id }) => id));
      for (const lane of lanes) if (!listed.has(lane.id)) sessions.push(lane);
      const ids = lanes.map(({ id }) => id);
      const placeholders = ids.map(() => "?").join(",");
      const load = <T>(table: "ws_nodes" | "ws_activity", limit: number) => ids.length ? this.db.prepare(
        `SELECT json FROM ${table} WHERE json_extract(json,'$.sessionId') IN (${placeholders}) ORDER BY seq DESC LIMIT ?`,
      ).all(...ids, limit).reverse().map((row) => parsed<T>(row)!) : [];
      return {
        cursor: this.cursor(), sessions, runs: [], worker: null, artifacts: [],
        nodes: load<GraphNode>("ws_nodes", 640), activities: load<Activity>("ws_activity", 640),
      };
    }, false);
  }
  reapGateway() {
    const old = this.db.prepare("SELECT json FROM ws_runs WHERE status='running' AND created<? AND json_extract(json,'$.gateway') IS NOT NULL LIMIT 32")
      .all(Date.now() - 20 * 60 * 1000);
    for (const row of old) {
      const job = parsed<Job>(row)!;
      const session = this.session(job.sessionId);
      if (session?.gateway) this.finishGateway({ runId: job.id, sessionId: session.id, machineId: session.gateway.machineId }, {
        status: "interrupted", text: "", hasReply: false, detail: "未观察到请求终态。",
      });
    }
  }
  private lastNode(job: Job) {
    const result = this.db.prepare(
      "SELECT json FROM ws_nodes WHERE json_extract(json,'$.runId')=? AND json_extract(json,'$.kind') IN ('reply','merge') ORDER BY seq DESC LIMIT 1",
    ).get(job.id);
    return parsed<GraphNode>(result)?.id ?? runNode(job.id);
  }
  private history(sessionId: string, seq: number): string {
    const rows = this.db.prepare(`
      SELECT json_extract(json, '$.activity') as json FROM ws_events WHERE seq<=? AND json_extract(json,'$.activity.sessionId')=?
      AND json_extract(json,'$.activity.kind') IN ('user','assistant')
      AND NOT COALESCE(json_extract(json, '$.append'), 0)
      AND COALESCE(json_extract(json,'$.activity.status'), 'completed')='completed'
      ORDER BY seq DESC LIMIT 12
    `).all(seq, sessionId);
    return rows.reverse().map((row) => {
      const activity = parsed<Activity>(row)!;
      return `${activity.kind === "user" ? "用户" : "代理"}：${activity.text.slice(0, 1600)}`;
    }).join("\n\n").slice(-10_000);
  }
  send(input: Send): Run {
    return this.tx(() => {
      const digest = createHash("sha256").update(dbJson(input)).digest("hex");
      const previous = this.db.prepare("SELECT digest,run_id FROM ws_commands WHERE key=?").get(input.key) as { digest: string; run_id: string } | undefined;
      if (previous) {
        if (previous.digest !== digest) throw new WorkspaceError("同一请求标识已用于另一条任务。", 409);
        return publicRun(this.job(previous.run_id)!);
      }
      const worker = this.workerState();
      if (!worker || Date.now() - worker.at > LEASE_MS) throw new WorkspaceError("工作区 Worker 离线，请先启动。", 503);
      if (!worker[input.engine] || (input.mode === "mixed" && !(worker.pi && worker.codex))) {
        throw new WorkspaceError("所选执行器未配置或不可用。", 409);
      }
      const prior = input.retryOf ? this.job(input.retryOf) : undefined;
      if (input.retryOf && (!prior || !terminal(prior.status) || prior.status === "completed" || prior.sessionId !== input.sessionId)) {
        throw new WorkspaceError("请选择已停止、中断或失败的任务。", 409);
      }
      const source = input.sessionId ? this.session(input.sessionId) : undefined;
      if (input.sessionId && !source) throw new WorkspaceError("会话不存在。", 404);
      if (input.forkNodeId && (!source || input.mode !== "single")) throw new WorkspaceError("分叉需要选择源会话。");
      if (source?.id.startsWith("native-") && !input.forkNodeId) throw new WorkspaceError("原生 Codex 子代理由父会话管理。", 409);
      if (source && !input.forkNodeId && source.engine !== input.engine) throw new WorkspaceError("切换执行器请新建或分叉会话。", 409);
      const id = randomUUID();
      const sourceNode = input.forkNodeId ? this.node(input.forkNodeId) : undefined;
      if (input.forkNodeId && (!sourceNode || sourceNode.sessionId !== source?.id || (sourceNode.status && !terminal(sourceNode.status)))) {
        throw new WorkspaceError("请从当前会话已结束的节点分叉。", 409);
      }
      const checkpoint = sourceNode ? this.db.prepare(
        "SELECT MAX(seq) AS seq FROM ws_events WHERE json_extract(json,'$.node.id')=?",
      ).get(sourceNode.id) as { seq: number | null } : undefined;
      if (source && !sourceNode) {
        const active = this.db.prepare("SELECT id FROM ws_runs WHERE session_id=? AND status IN ('queued','running','stopping','waiting')").get(source.id);
        if (active) throw new WorkspaceError("当前会话已有任务在执行。", 409);
      }
      const name = input.prompt.replace(/\s+/g, " ").slice(0, 56);
      const forkId = sourceNode ? `fork:${id}` : undefined;
      const session = !source || sourceNode ? this.addSession(input.engine, name, source?.role ?? "owner", source, forkId) : source;
      const last = parsed<Job>(this.db.prepare("SELECT json FROM ws_runs WHERE session_id=? ORDER BY created DESC,rowid DESC LIMIT 1").get(session.id));
      const job: Job = {
        id, sessionId: session.id, prompt: input.prompt, mode: input.mode, phase: "execute",
        status: input.mode === "single" ? "queued" : "waiting", createdAt: Date.now(),
        retryOf: prior?.id, parents: forkId ? [forkId] : last ? [this.lastNode(last)] : [],
        context: sourceNode && source ? this.history(source.id, checkpoint?.seq ?? sourceNode.seq ?? 0) : undefined,
      };
      if (forkId && sourceNode) this.append({ node: {
        id: forkId, sessionId: session.id, runId: id, kind: "fork", label: "会话分叉", parents: [sourceNode.id], activityId: `input:${id}`,
      } });
      this.addRun(job);
      if (input.mode !== "single") {
        const fork = `fork:${id}`;
        this.append({ node: { id: fork, sessionId: session.id, runId: id, kind: "fork", label: "并行分派", parents: [runNode(id)], activityId: `input:${id}` } });
        const specs: { role: Role; name: string; engine: Engine; purpose: string }[] = [
          { role: "implement", name: "实施", engine: input.engine, purpose: "实现用户任务；仅修改自己的项目检出，说明改动和验证。" },
          { role: "review", name: "核查", engine: input.mode === "mixed" ? input.engine === "pi" ? "codex" : "pi" : input.engine, purpose: "独立核查需求和项目基线，给验收清单与发现；不要修改文件。" },
        ];
        for (const spec of specs) {
          const child = this.addSession(spec.engine, spec.name, spec.role, session, fork);
          this.addRun({
            id: randomUUID(), sessionId: child.id, parentRunId: id, status: "queued", mode: "single",
            phase: "execute", createdAt: Date.now(), parents: [fork], prompt: `${spec.purpose}\n\n用户任务：\n${input.prompt}`,
          });
        }
      }
      this.db.prepare("INSERT INTO ws_commands VALUES (?,?,?)").run(input.key, digest, id);
      return publicRun(job);
    });
  }
  retry(key: string, id: string) {
    const last = this.job(id);
    if (!last) throw new WorkspaceError("任务不存在。", 404);
    const session = this.session(last.sessionId)!;
    return this.send({ key, retryOf: id, sessionId: last.sessionId, prompt: last.prompt, engine: session.engine, mode: last.mode });
  }
  claim(worker: string, engines: Engine[], capacity: number): Ticket | undefined {
    if (engines.length === 0) return undefined;
    return this.tx(() => {
      const active = this.db.prepare("SELECT COUNT(*) AS count FROM ws_runs WHERE status IN ('running','stopping')").get() as { count: number };
      if (active.count >= capacity) return undefined;
      const job = parsed<Job>(this.db.prepare(`
        SELECT r.json FROM ws_runs r JOIN ws_sessions s ON s.id=r.session_id WHERE r.status='queued'
        AND json_extract(s.json,'$.engine') IN (${engines.map(() => "?").join(",")})
        ORDER BY r.created,r.rowid LIMIT 1
      `).get(...engines));
      if (!job) return undefined;
      job.status = "running";
      this.db.prepare("UPDATE ws_runs SET worker=?,lease=? WHERE id=?").run(worker, Date.now() + LEASE_MS, job.id);
      this.changeRun(job, true);
      return { job, worker };
    });
  }
  private owned(ticket: Ticket): Job | undefined {
    return parsed<Job>(this.db.prepare("SELECT json FROM ws_runs WHERE id=? AND worker=? AND status IN ('running','stopping') AND lease>=?")
      .get(ticket.job.id, ticket.worker, Date.now()));
  }
  renew(ticket: Ticket): "running" | "stopping" | "lost" {
    return this.tx(() => {
      const job = this.owned(ticket);
      if (!job) return "lost";
      this.db.prepare("UPDATE ws_runs SET lease=? WHERE id=?").run(Date.now() + LEASE_MS, job.id);
      return job.status === "stopping" ? "stopping" : "running";
    });
  }
  setSessionRuntime(ticket: Ticket, update: Pick<SessionRecord, "engineRef" | "cwd" | "base">) {
    this.tx(() => {
      if (!this.owned(ticket)) throw new WorkspaceError("任务租约已失效。", 409);
      const session = this.session(ticket.job.sessionId)!;
      Object.assign(session, update);
      this.db.prepare("UPDATE ws_sessions SET json=? WHERE id=?").run(dbJson(session), session.id);
    });
  }
  publish(ticket: Ticket, change: Change) {
    return this.tx(() => {
      if (!this.owned(ticket)) return false;
      this.append(change);
      return true;
    });
  }
  pinBase(ticket: Ticket, candidate: string) {
    return this.tx(() => {
      if (!this.owned(ticket)) throw new WorkspaceError("任务租约已失效。", 409);
      const session = this.session(ticket.job.sessionId)!;
      const root = this.session(session.rootId)!;
      if (!root.base) {
        root.base = candidate;
        this.db.prepare("UPDATE ws_sessions SET json=? WHERE id=?").run(dbJson(root), root.id);
      }
      return session.base ?? root.base;
    });
  }
  deliveryFor(ticket: Ticket) {
    const descendants = this.db.prepare("SELECT id FROM ws_runs WHERE parent_run=?").all(ticket.job.id) as { id: string }[];
    const ids = new Set([ticket.job.id, ...descendants.map((row) => row.id)]);
    return this.db.prepare("SELECT json FROM ws_artifacts ORDER BY rowid")
      .all().map((row) => parsed<Artifact>(row)!).filter((item) => ids.has(item.runId));
  }
  agentBranch(ticket: Ticket, externalId: string, label: string, sourceNode: string): Session | undefined {
    return this.tx(() => {
      if (!this.owned(ticket)) return undefined;
      const id = `native-${createHash("sha256").update(ticket.job.id + ":" + externalId).digest("hex").slice(0, 28)}`;
      const existing = this.session(id);
      if (existing) return publicSession(existing);
      const parent = this.session(ticket.job.sessionId)!;
      const session: SessionRecord = {
        id, rootId: parent.rootId, parentId: parent.id, forkNodeId: sourceNode,
        name: label.slice(0, 56), engine: "codex", role: "review", createdAt: Date.now(),
      };
      this.db.prepare("INSERT INTO ws_sessions VALUES (?,?)").run(id, dbJson(session));
      this.append({
        session, node: { id: `branch:${id}`, sessionId: id, runId: ticket.job.id, kind: "fork", label: session.name, parents: [sourceNode] },
      });
      return session;
    });
  }
  putArtifact(ticket: Ticket, name: string, bytes: Buffer, sourceId: string, parentNode: string, patch = false): Artifact | undefined {
    if (bytes.length > MAX_ARTIFACT) return undefined;
    return this.tx(() => {
      const job = this.owned(ticket);
      if (!job || job.status === "stopping") return undefined;
      const id = randomUUID();
      const artifact: Artifact = {
        id, sessionId: ticket.job.sessionId, runId: job.id, sourceId, name: name.slice(0, 192), size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"), at: Date.now(), patch,
      };
      this.db.prepare("INSERT INTO ws_artifacts VALUES (?,?,?)").run(id, dbJson(artifact), bytes);
      const activity: Activity = { id: `file:${id}`, sessionId: job.sessionId, runId: job.id, kind: "file", title: artifact.name, text: "", artifactId: id };
      this.append({
        artifact, activity,
        node: { id: activity.id, sessionId: job.sessionId, runId: job.id, kind: "file", label: artifact.name, parents: [parentNode], activityId: activity.id },
        beacon: { from: "activity", fromId: sourceId, nodeId: activity.id },
      });
      return artifact;
    });
  }
  artifact(id: string): { info: Artifact; bytes: Buffer } | undefined {
    const row = this.db.prepare("SELECT json,bytes FROM ws_artifacts WHERE id=?").get(id) as { json: string; bytes: Uint8Array } | undefined;
    return row && { info: parsed<Artifact>(row)!, bytes: Buffer.from(row.bytes) };
  }
  beginIntegration(artifactId: string) {
    return this.tx(() => {
      const old = this.db.prepare("SELECT status,path FROM ws_integrations WHERE artifact_id=?").get(artifactId) as { status: string; path?: string } | undefined;
      if (old?.status === "applied") return old.path!;
      if (old?.status === "applying") throw new WorkspaceError("此补丁已在应用中。", 409);
      this.db.prepare("INSERT INTO ws_integrations VALUES (?,'applying',NULL) ON CONFLICT(artifact_id) DO UPDATE SET status='applying',path=NULL")
        .run(artifactId);
      return undefined;
    });
  }
  endIntegration(info: Artifact, path?: string) {
    this.tx(() => {
      this.db.prepare("UPDATE ws_integrations SET status=?,path=? WHERE artifact_id=?")
        .run(path ? "applied" : "failed", path ?? null, info.id);
      if (path) {
        const id = `integration:${info.id}`;
        this.append({
          node: { id, kind: "file", label: "已应用到集成检出", sessionId: info.sessionId, runId: info.runId, parents: [`file:${info.id}`], activityId: id, status: "completed" },
          activity: { id, kind: "status", title: "已应用到集成检出（原检出未修改）", text: path, sessionId: info.sessionId, runId: info.runId, status: "completed" },
          beacon: { from: "activity", fromId: `file:${info.id}`, nodeId: id },
        });
      }
    });
  }
  private settleParent(id: string | undefined) {
    const parent = id ? this.job(id) : undefined;
    if (!parent || (parent.status !== "waiting" && parent.status !== "stopping")) return;
    const children = this.db.prepare("SELECT json FROM ws_runs WHERE parent_run=? ORDER BY created,rowid")
      .all(parent.id).map((row) => parsed<Job>(row)!);
    if (!children.length || children.some((child) => !terminal(child.status))) return;
    if (parent.status === "stopping") {
      parent.status = "cancelled";
      this.changeRun(parent);
      return;
    }
    const success = children.filter((child) => child.status === "completed").length;
    const mergeId = `merge:${parent.id}`;
    const mergeLabel = success === children.length ? "结果汇入" : `部分结果汇入（${success}/${children.length}）`;
    this.append({ node: {
      id: mergeId, sessionId: parent.sessionId, runId: parent.id, kind: "merge", label: mergeLabel,
      parents: children.map((c) => this.lastNode(c)), activityId: runStatusActivity(parent.id),
    } });
    for (const child of children) {
      const source = this.node(this.lastNode(child));
      if (source?.activityId) this.append({ beacon: { from: "activity", fromId: source.activityId, nodeId: mergeId } });
    }
    parent.phase = "join";
    parent.status = "queued";
    parent.detail = success === children.length ? "" : `已收集 ${success}/${children.length} 个成功分支，其余状态保留。`;
    parent.context = children.map((child) => {
      const source = this.session(child.sessionId)!;
      return `分支 ${source.name}（${source.engine}，${statusName[child.status]}）：\n${(child.summary || child.detail || "没有可用输出").slice(0, 6500)}`;
    }).join("\n\n");
    this.changeRun(parent);
  }
  finish(ticket: Ticket, outcome: "completed" | "failed" | "cancelled", summary = "", detail?: string) {
    return this.tx(() => {
      const job = this.owned(ticket);
      if (!job) return false;
      job.status = job.status === "stopping" ? "cancelled" : outcome;
      job.detail = detail?.slice(0, 1000) || job.detail;
      job.summary = summary.slice(0, TEXT_LIMIT);
      this.db.prepare("UPDATE ws_runs SET worker=NULL,lease=NULL WHERE id=?").run(job.id);
      this.closeOpenActivities(job);
      this.changeRun(job);
      this.settleParent(job.parentRunId);
      return true;
    });
  }
  reap() {
    this.tx(() => {
      for (const row of this.db.prepare("SELECT json FROM ws_runs WHERE lease<? AND worker IS NOT NULL").all(Date.now())) {
        const job = parsed<Job>(row)!;
        job.status = "interrupted";
        job.detail = "执行器失联，未自动重放。";
        this.db.prepare("UPDATE ws_runs SET worker=NULL,lease=NULL WHERE id=?").run(job.id);
        this.closeOpenActivities(job);
        this.changeRun(job);
        this.settleParent(job.parentRunId);
      }
    });
  }
  private closeOpenActivities(job: Job) {
    const rows = this.db.prepare("SELECT json FROM ws_activity WHERE json_extract(json,'$.runId')=? AND json_extract(json,'$.status')='running' AND json_extract(json, '$.kind')!='status'").all(job.id);
    for (const row of rows) {
      const activity = parsed<Activity>(row)!;
      const node = this.node(activity.id);
      const status = job.status === "completed" ? "interrupted" : job.status;
      this.append({ activity: { ...activity, status }, node: node && { ...node, status } });
    }
  }
  stop(id: string): Run {
    return this.tx(() => {
      const root = this.job(id);
      if (!root) throw new WorkspaceError("任务不存在。", 404);
      if (terminal(root.status)) return publicRun(root);
      const stopJob = (job: Job) => {
        if (terminal(job.status)) return;
        job.status = job.status === "queued" ? "cancelled" : "stopping";
        this.changeRun(job);
      };
      stopJob(root);
      for (const row of this.db.prepare("SELECT json FROM ws_runs WHERE parent_run=?").all(id)) stopJob(parsed<Job>(row)!);
      this.settleParent(id);
      this.settleParent(root.parentRunId);
      return publicRun(this.job(id)!);
    });
  }
}

const instances = globalThis as typeof globalThis & { __wbAgentStores?: Map<string, WorkspaceStore> };
function openStore(filename: string, busyTimeout: number) {
  const dir = dataRoot();
  const stores = instances.__wbAgentStores ??= new Map();
  const path = join(dir, filename);
  let store = stores.get(path);
  if (!store) {
    mkdirSync(dir, { recursive: true });
    store = new WorkspaceStore(path, busyTimeout);
    stores.set(path, store);
  }
  return store;
}
export const workspaceStore = () => openStore("workspace.sqlite", 5000);
export const gatewayStore = () => openStore("gateway-trace.sqlite", 70);
