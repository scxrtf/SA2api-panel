// 进程内运行日志环形缓冲（对齐 Go internal/panel/ring.go）。
// 容量 500，FIFO 淘汰；console.log/error 与任务链路经 runlog() 镜像进来，
// 面板 /api/panel/logs 读取快照。重启后清空（与 Go 单机版同语义）。

export type LogChannel = "task" | "chat" | "sys";
export interface LogEntry { ts: number; ch: LogChannel; text: string }

const CAP = 500;

interface RingState { entries: LogEntry[] }

// 模块级单例（dev 热更新与多 chunk 下保持同一份）。
const g = globalThis as unknown as { __wbRunlog?: RingState };
const ring: RingState = g.__wbRunlog ?? (g.__wbRunlog = { entries: [] });

// taskPrefixes 对齐 Go ring.go taskPrefixes：行首特征归类任务频道。
const TASK_PREFIXES = [
  "school ", "streak-bonus ", "travel ", "blackcat ", "lottery ",
  "checkin ", "activity ", "keepalive ", "balance ", "user-resource ",
  "[scheduler]", "[growth", "[task",
];

function classify(text: string): LogChannel {
  if (TASK_PREFIXES.some((p) => text.startsWith(p))) return "task";
  if (text.startsWith("chat ") || text.startsWith("OK ") || text.startsWith("ERR ")) return "chat";
  return "sys";
}

// runlog 写入一行（自动剥掉已有的时间戳前缀与换行）。
export function runlog(text: string): void {
  const line = text.trim();
  if (!line) return;
  ring.entries.push({ ts: Date.now(), ch: classify(line), text: line });
  if (ring.entries.length > CAP) {
    ring.entries.splice(0, ring.entries.length - CAP);
  }
}

// runlogSnapshot 拷贝返回全部条目。
export function runlogSnapshot(): LogEntry[] {
  return ring.entries.slice();
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
