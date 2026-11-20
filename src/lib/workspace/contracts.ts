export type Engine = "pi" | "codex";
export type Role = "owner" | "implement" | "review";
export type Status = "queued" | "running" | "waiting" | "stopping" | "completed" | "failed" | "cancelled" | "interrupted";
export type Mode = "single" | "parallel" | "mixed";
export const terminal = (status: Status) => ["completed", "failed", "cancelled", "interrupted"].includes(status);
export const engineName = { pi: "Pi", codex: "Codex" } as const;
export const statusName: Record<Status, string> = {
  queued: "排队中", running: "运行中", waiting: "等待分支", stopping: "正在停止",
  completed: "已完成", failed: "失败", cancelled: "已停止", interrupted: "运行中断",
};

export type GatewayProtocol = "chat" | "responses" | "anthropic" | "compact";
export interface GatewaySource {
  machineId: string;
  machineLabel: string;
  machineBasis: "device" | "key" | "connection";
  client: string;
  model: string;
  protocol: GatewayProtocol;
  correlation: "explicit" | "response" | "tool" | "history" | "unlinked";
  lastAt: number;
  lastRunId?: string;
  lastStatus?: Status;
}

export interface Session {
  id: string;
  rootId: string;
  parentId?: string;
  forkNodeId?: string;
  name: string;
  engine: Engine;
  role: Role;
  createdAt: number;
  gateway?: GatewaySource;
}
export interface Run {
  id: string;
  sessionId: string;
  status: Status;
  parentRunId?: string;
  retryOf?: string;
  mode: Mode;
  phase: "execute" | "join";
  createdAt: number;
  detail?: string;
  gateway?: { protocol: GatewayProtocol; model: string; endedAt?: number; httpStatus?: number };
}
export interface GraphNode {
  id: string;
  sessionId: string;
  runId: string;
  kind: "run" | "fork" | "merge" | "reply" | "tool" | "file";
  label: string;
  parents: string[];
  activityId?: string;
  status?: Status;
  seq?: number;
}
export interface Activity {
  id: string;
  sessionId: string;
  runId: string;
  kind: "user" | "assistant" | "tool" | "status" | "file";
  title: string;
  text: string;
  status?: Status;
  artifactId?: string;
  seq?: number;
}
export interface Artifact {
  id: string;
  sessionId: string;
  runId: string;
  sourceId: string;
  name: string;
  size: number;
  sha256: string;
  at: number;
  patch?: boolean;
}
export interface WorkerState {
  at: number;
  pi: boolean;
  codex: boolean;
  piModel?: string;
  codexModel?: string;
}
export interface Change {
  session?: Session;
  run?: Run;
  node?: GraphNode;
  activity?: Activity;
  append?: boolean;
  artifact?: Artifact;
  worker?: WorkerState;
  beacon?: { from: "model" | "activity"; fromId: string; nodeId: string };
}
export interface WorkspaceEvent extends Change {
  seq: number;
}
export interface Snapshot {
  cursor: number;
  sessions: Session[];
  runs: Run[];
  nodes: GraphNode[];
  activities: Activity[];
  artifacts: Artifact[];
  worker: WorkerState | null;
}

const update = <T extends { id: string }>(items: T[], item: T) => {
  const index = items.findIndex((it) => it.id === item.id);
  if (index < 0) return [...items, item];
  const next = items.slice();
  next[index] = item;
  return next;
};

export const TEXT_LIMIT = 65_536;
export function projectActivity(previous: Activity | undefined, item: Activity, append: boolean, seq: number): Activity {
  return {
    ...item, seq: previous?.seq ?? seq,
    text: (append ? (previous?.text ?? "") + item.text : item.text).slice(0, TEXT_LIMIT),
  };
}

export function applyEvent(state: Snapshot, event: WorkspaceEvent): Snapshot {
  if (event.seq <= state.cursor) return state;
  const previousNode = event.node && state.nodes.find((n) => n.id === event.node!.id);
  const previousActivity = event.activity && state.activities.find((a) => a.id === event.activity!.id);
  return {
    cursor: event.seq,
    sessions: event.session ? update(state.sessions, event.session) : state.sessions,
    runs: event.run ? update(state.runs, event.run) : state.runs,
    nodes: event.node ? update(state.nodes, { ...event.node, seq: previousNode?.seq ?? event.seq }) : state.nodes,
    activities: event.activity ? update(state.activities, projectActivity(previousActivity, event.activity, !!event.append, event.seq)) : state.activities,
    artifacts: event.artifact ? update(state.artifacts, event.artifact) : state.artifacts,
    worker: event.worker ?? state.worker,
  };
}

export const blankSnapshot = (): Snapshot => ({
  cursor: 0, sessions: [], runs: [], nodes: [], activities: [], artifacts: [], worker: null,
});
export const runNode = (id: string) => `run:${id}`;
export const runStatusActivity = (id: string) => `status:${id}`;
export const sessionColor = (id: string) => {
  const colors = ["#2363a5", "#a05229", "#26736d", "#7751a0", "#9b4866"];
  let hash = 0;
  for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length];
};
