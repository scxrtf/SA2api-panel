import { requestCacheUsage } from "./request-log-metrics";

export interface RequestLogSession {
  id: string;
  lastAt: string;
  model: string;
  modelCount: number;
  keyName: string;
  count: number;
  failed: number;
  reported: number;
  cacheHitTok: number;
  cacheMissTok: number;
}

export interface RequestLogScope { from: string; to: string }

export interface RequestLogSessionsPage {
  entries: RequestLogSession[];
  scope: RequestLogScope;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export function summarizeRequestSessions(entries: readonly RequestLogSession[]) {
  const sums = { count: 0, failed: 0, reported: 0, cacheHitTok: 0, cacheMissTok: 0 };
  for (const entry of entries) {
    sums.count += entry.count;
    sums.failed += entry.failed;
    sums.reported += entry.reported;
    sums.cacheHitTok += entry.cacheHitTok;
    sums.cacheMissTok += entry.cacheMissTok;
  }
  return { count: sums.count, failed: sums.failed, reported: sums.reported, rate: requestCacheUsage(sums).rate };
}
