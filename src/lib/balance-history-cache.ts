// 余额趋势前后端共用的短 TTL：合并重复访问，但不覆盖 30 分钟采样周期。
// 供浏览器与服务端共同引用。
export const BALANCE_HISTORY_CACHE_MS = 60_000;
