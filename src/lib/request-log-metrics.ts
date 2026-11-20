type CacheTokens = { cacheHitTok?: number | null; cacheMissTok?: number | null };
type LogResult = { status: number; errKind?: string | null };

export function requestFailed({ status, errKind }: LogResult): boolean {
  return status >= 400 || Boolean(errKind);
}

function tokenCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function hitRate(hit: number, miss: number): number | null {
  return hit + miss > 0 ? hit / (hit + miss) : null;
}

export function requestCacheUsage(request: CacheTokens) {
  const hit = tokenCount(request.cacheHitTok);
  const miss = tokenCount(request.cacheMissTok);
  // Both zero is also the storage default for upstreams that report no cache usage.
  return { hit, miss, rate: hitRate(hit, miss) };
}

export function summarizeRequestPage(requests: readonly (LogResult & CacheTokens)[]) {
  let failed = 0;
  let reported = 0;
  let hit = 0;
  let miss = 0;
  for (const request of requests) {
    if (requestFailed(request)) failed++;
    const cache = requestCacheUsage(request);
    if (cache.rate !== null) reported++;
    hit += cache.hit;
    miss += cache.miss;
  }
  return { count: requests.length, failed, reported, rate: hitRate(hit, miss) };
}

const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });
const wholeTokens = new Intl.NumberFormat("en-US");
const millions = new Intl.NumberFormat("en-US", { maximumFractionDigits: 3 });

export function formatLogTokens(count: number): string {
  return count >= 10_000 ? `${millions.format(count / 1_000_000)}M` : wholeTokens.format(count);
}

export function formatCacheRate(rate: number): string {
  if (rate > 0 && rate < 0.001) return "<0.1%";
  if (rate < 1 && rate > 0.999) return ">99.9%";
  return percent.format(rate);
}
