// 余额趋势前后端共用的短缓存：合并重复访问，但不覆盖 30 分钟采样周期。
// 此模块不依赖 React 或服务端运行时，供视图、API 和缓存状态页统一引用。
export const BALANCE_HISTORY_CACHE_MS = 60_000;
export const PANEL_CACHE_DEFAULT_TTL_MS = 60 * 60_000;

export function panelCacheTtlMs(key: string): number {
  return key.startsWith("balance_history:")
    ? BALANCE_HISTORY_CACHE_MS
    : PANEL_CACHE_DEFAULT_TTL_MS;
}
