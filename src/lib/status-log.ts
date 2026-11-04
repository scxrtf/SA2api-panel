import { prisma } from "./db";
import { runlogSnapshot, type LogChannel } from "./runlog";

export type StatusLogChannel = Exclude<LogChannel, "chat">;

export interface StatusLogEntry {
  id: string;
  ts: number;
  ch: StatusLogChannel;
  text: string;
}

// 默认返回条数。面板一次刷新取 200 条已足够铺满视口；调大只会线性放大 Egress。
const DEFAULT_LIMIT = 200;
// 单次数据库查询上限：与内存环形缓冲（CAP=500）对齐并压低到 200。
const MAX_QUERY_TAKE = 200;
// 调用日志只看最近 7 天：更老的行走 retention 清理，查询面收窄后扫描堆页更少。
const CALL_LOG_WINDOW_MS = 7 * 24 * 3600_000;

// listStatusLog 合并进程内运行日志与两张持久化审计表。
// 调用日志以 RequestLog 为准，探测日志以 ModelHealthCheck 为准；数据库读取失败时
// 保留内存中的 call/probe 行作为降级展示。
// since 非空时走增量模式：只查该时刻之后的持久化行，并按升序取满 take 条——
// 面板轮询 60s 一次，增量下每次回传通常只有 0~几条，避免整页 200 行反复出网。
export async function listStatusLog(limit = DEFAULT_LIMIT, since?: Date): Promise<StatusLogEntry[]> {
  const take = Number.isFinite(limit)
    ? Math.max(1, Math.min(500, Math.trunc(limit)))
    : DEFAULT_LIMIT;
  const memory = runlogSnapshot();
  // 查询量收敛到 200：内存条目按 persistedId 去重，未被本次查询覆盖的条目
  // 只会从内存展示一次，不会重复；继续拉 500 条纯属多传字节。
  const queryTake = Math.min(take, MAX_QUERY_TAKE);
  const delta = !!since;
  const callSince = new Date(Math.max(Date.now() - CALL_LOG_WINDOW_MS, since?.getTime() ?? 0));
  const order = delta ? "asc" : "desc";
  const [healthResult, callResult] = await Promise.allSettled([
    prisma.modelHealthCheck.findMany({
      ...(delta ? { where: { checkedAt: { gte: since } } } : {}),
      orderBy: { checkedAt: order },
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
      where: { at: { gte: callSince } },
      orderBy: { at: order },
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
    // 增量模式下老的内存行已经在客户端展示过（或已落库），不再重复回传。
    if (since && entry.ts < since.getTime()) return;
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
