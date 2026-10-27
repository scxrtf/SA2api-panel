import { prisma } from "./db";
import { runlogSnapshot, type LogChannel } from "./runlog";

export type StatusLogChannel = Exclude<LogChannel, "chat">;

export interface StatusLogEntry {
  id: string;
  ts: number;
  ch: StatusLogChannel;
  text: string;
}

const DEFAULT_LIMIT = 500;

// listStatusLog 合并进程内运行日志与两张持久化审计表。
// 调用日志以 RequestLog 为准，探测日志以 ModelHealthCheck 为准；数据库读取失败时
// 保留内存中的 call/probe 行作为降级展示。
export async function listStatusLog(limit = DEFAULT_LIMIT): Promise<StatusLogEntry[]> {
  const take = Number.isFinite(limit)
    ? Math.max(1, Math.min(1000, Math.trunc(limit)))
    : DEFAULT_LIMIT;
  const memory = runlogSnapshot();
  // 查询量至少覆盖整个内存环形缓冲，避免 limit 较小时已持久化日志被重复展示。
  const queryTake = Math.max(take, 500);
  const [healthResult, callResult] = await Promise.allSettled([
    prisma.modelHealthCheck.findMany({
      orderBy: { checkedAt: "desc" },
      take: queryTake,
      select: {
        id: true,
        modelKey: true,
        ok: true,
        status: true,
        latencyMs: true,
        completionTokens: true,
        tokensPerSecond: true,
        errorKind: true,
        detail: true,
        source: true,
        checkedAt: true,
      },
    }),
    prisma.requestLog.findMany({
      orderBy: { at: "desc" },
      take: queryTake,
      select: {
        id: true,
        model: true,
        realm: true,
        provider: true,
        status: true,
        errKind: true,
        durationMs: true,
        completionTok: true,
        attempts: true,
        uid: true,
        slot: true,
        at: true,
      },
    }),
  ]);

  const healthRows = healthResult.status === "fulfilled" ? healthResult.value : null;
  const callRows = callResult.status === "fulfilled" ? callResult.value : null;
  const entries: StatusLogEntry[] = [];
  const persisted = new Set<string>();
  for (const row of healthRows ?? []) persisted.add("probe:" + row.id);
  for (const row of callRows ?? []) persisted.add("call:" + row.id);

  memory.forEach((entry, index) => {
    const channel: StatusLogChannel = entry.ch === "chat" ? "call" : entry.ch;
    const persistedKey = entry.persistedId
      ? channel + ":" + entry.persistedId
      : "";
    if (persistedKey && persisted.has(persistedKey)) return;
    entries.push({
      id: "memory:" + entry.ts + ":" + index,
      ts: entry.ts,
      ch: channel,
      text: entry.text,
    });
  });

  for (const row of healthRows ?? []) {
    entries.push({
      id: "probe:" + row.id,
      ts: row.checkedAt.getTime(),
      ch: "probe",
      text: probeText(row),
    });
  }
  for (const row of callRows ?? []) {
    entries.push({
      id: "call:" + row.id,
      ts: row.at.getTime(),
      ch: "call",
      text: callText(row),
    });
  }

  entries.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  return entries.slice(-take);
}

function probeText(row: {
  modelKey: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  completionTokens: number;
  tokensPerSecond: number;
  errorKind: string;
  detail: string;
  source: string;
}): string {
  const detail = !row.ok && row.detail
    ? " · " + oneLine(row.detail).slice(0, 180)
    : "";
  return "[probe] " + row.modelKey + " " + (row.ok ? "成功" : "失败") +
    " HTTP " + row.status +
    " · 延迟 " + fmtDuration(row.latencyMs) +
    " · 吞吐 " + fmtRate(row.tokensPerSecond) + " t/s" +
    " · 输出 " + row.completionTokens + " tok" +
    " · source=" + (row.source || "unknown") +
    (!row.ok && row.errorKind ? " · kind=" + row.errorKind : "") +
    detail;
}

function callText(row: {
  model: string;
  realm: string;
  provider: string;
  status: number;
  errKind: string;
  durationMs: number;
  completionTok: number;
  attempts: number;
  uid: string;
  slot: string;
}): string {
  const ok = row.status < 400 && !row.errKind;
  const route = row.provider
    ? row.provider + (row.slot && row.slot !== row.provider ? " · " + row.slot : "")
    : (row.realm || "unknown");
  return "[call] " + (row.model || "unknown") + " " + (ok ? "成功" : "失败") +
    " HTTP " + row.status +
    " · " + fmtDuration(row.durationMs) +
    " · 输出 " + row.completionTok + " tok" +
    " · " + route +
    (row.attempts > 0 ? " · 尝试 " + row.attempts + " 次" : "") +
    (row.uid ? " · uid=" + row.uid : "") +
    (!ok && row.errKind ? " · kind=" + row.errKind : "");
}

function fmtDuration(ms: number): string {
  const n = Math.max(0, Math.trunc(ms));
  if (n >= 1000) return (n / 1000).toFixed(1) + "s";
  return n + "ms";
}

function fmtRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
