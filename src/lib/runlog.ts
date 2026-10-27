// 进程内运行日志环形缓冲（对齐 Go internal/panel/ring.go）。
// 容量 500，FIFO 淘汰；console.log/error 与任务链路经 runlog() 镜像进来，
// 面板 /api/panel/logs 读取快照。重启后清空（与 Go 单机版同语义）。

export type LogChannel = "task" | "chat" | "call" | "probe" | "sys";
export interface LogEntry {
  ts: number;
  ch: LogChannel;
  text: string;
  ref: string;
  persistedId?: string;
}

const CAP = 500;

interface RingState {
  entries: LogEntry[];
  refSeq: number;
}

// 模块级单例（dev 热更新与多 chunk 下保持同一份）。
const g = globalThis as unknown as { __wbRunlog?: RingState };
const ring: RingState = g.__wbRunlog ?? (g.__wbRunlog = { entries: [], refSeq: 0 });
if (ring.refSeq === undefined) ring.refSeq = 0;

// taskPrefixes 对齐 Go ring.go taskPrefixes：行首特征归类任务频道。
const TASK_PREFIXES = [
  "school ", "streak-bonus ", "travel ", "blackcat ", "lottery ",
  "checkin ", "activity ", "keepalive ", "balance ", "user-resource ",
  "panel: 手动", // 对齐 Go ring.go taskPrefixes（批量任务触发行归任务频道）
  "[scheduler]", "[growth", "[task",
];

function classify(text: string): LogChannel {
  if (TASK_PREFIXES.some((p) => text.startsWith(p))) return "task";
  if (text.startsWith("[probe]") || text.startsWith("modelhealth ")) return "probe";
  if (text.startsWith("[call]") || text.startsWith("chat ") || text.startsWith("OK ") || text.startsWith("ERR ")) return "call";
  return "sys";
}

// runlog 写入一行（自动剥掉已有的时间戳前缀与换行）。
// 返回值是该条内存日志的关联键；持久化成功后用 markRunlogPersisted 回填数据库 ID。
export function runlog(text: string, persistedId = ""): string {
  const line = text.trim();
  if (!line) return "";
  ring.refSeq++;
  const ref = Date.now().toString(36) + ":" + ring.refSeq.toString(36);
  ring.entries.push({
    ts: Date.now(),
    ch: classify(line),
    text: line,
    ref,
    ...(persistedId ? { persistedId } : {}),
  });
  if (ring.entries.length > CAP) {
    ring.entries.splice(0, ring.entries.length - CAP);
  }
  return ref;
}

// markRunlogPersisted 为已成功落库的内存日志回填数据库 ID，供状态日志合并去重。
export function markRunlogPersisted(ref: string, persistedId: string): void {
  if (!ref || !persistedId) return;
  for (let i = ring.entries.length - 1; i >= 0; i--) {
    if (ring.entries[i].ref !== ref) continue;
    ring.entries[i].persistedId = persistedId;
    return;
  }
}

// runlogSnapshot 拷贝返回全部条目。
export function runlogSnapshot(): LogEntry[] {
  return ring.entries.slice();
}

// runlogAccount 账号池操作日志：统一 "[accounts] " 前缀，classify 自动归 sys 频道。
// action 写动作与账号标签（label(uid, nickname)），detail 补原因/余额等附加信息。
// 约定：不写入 token/refresh_token 等凭证字段。
export function runlogAccount(action: string, detail = ""): void {
  const line = "[accounts] " + action + (detail ? " " + detail : "");
  runlog(line);
}

// 环形缓冲在模块初始化时预写一条启动行，保证首个 /api/panel/logs 请求
// 一定能看到「缓冲就绪」——即使 instrumentation 尚未跑、console hook 还没装上。
if (ring.entries.length === 0) {
  runlog("[sys] wb2api-next 运行日志缓冲就绪");
}

// 启动时镜像 console.log/error（Next 生产模式进程级唯一）。
const hooked = globalThis as unknown as { __wbRunlogHooked?: boolean };
if (!hooked.__wbRunlogHooked) {
  hooked.__wbRunlogHooked = true;
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...args: unknown[]) => {
    origLog(...args);
    try { runlog(args.map(String).join(" ")); } catch { /* 忽略序列化失败 */ }
  };
  console.error = (...args: unknown[]) => {
    origErr(...args);
    try { runlog("error " + args.map(String).join(" ")); } catch { /* 同上 */ }
  };
  runlog("[sys] wb2api-next 进程启动，运行日志缓冲就绪");
}
