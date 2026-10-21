// 供应商端点拼接：面板允许 Base URL 直接填到版本段（如 https://host/v1），
// 也允许只填主机（https://host）。统一在这里补 /v1，避免出现 /v1/v1/models。
export function providerEndpoint(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : "/" + path;
  // 已带版本段（/v1、/v1beta、/v4 ...）时不再重复补 /v1。
  return /\/v\d+[a-z]*$/i.test(base) ? base + suffix : base + "/v1" + suffix;
}
