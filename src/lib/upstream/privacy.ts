// WorkBuddy 5.9.3's ModelProvider resolves enableModelOptimization before setting
// X-Private-Data. Local artifact evidence: CLI bundle module 8154, byte 8912000.
import type { AppConfig } from "../config";
import type { AuthShape } from "./client";

export function isEnterpriseEditionAccount(account: Pick<AuthShape, "enterpriseId" | "type" | "accountType">): boolean {
  const edition = account.type ?? account.accountType;
  return !!account.enterpriseId.trim() || edition === "ultimate" || edition === "exclusive";
}

export function resolveModelOptimizationEnabled(options: {
  explicitEnabled?: boolean | null;
  productDefaultEnabled?: boolean;
  isEnterpriseEdition: boolean;
}): boolean {
  if (typeof options.explicitEnabled === "boolean") return options.explicitEnabled;
  return !options.isEnterpriseEdition && (options.productDefaultEnabled ?? true);
}

export function privateDataHeader(
  config: Pick<AppConfig, "enable_model_optimization" | "model_optimization_default_enabled" | "model_optimization_accounts">,
  account: Pick<AuthShape, "uid" | "enterpriseId" | "type" | "accountType">,
): "true" | "false" {
  const perAccount = config.model_optimization_accounts?.[account.uid];
  const enabled = resolveModelOptimizationEnabled({
    explicitEnabled: typeof perAccount === "boolean" ? perAccount : config.enable_model_optimization,
    productDefaultEnabled: config.model_optimization_default_enabled,
    isEnterpriseEdition: isEnterpriseEditionAccount(account),
  });
  return enabled ? "false" : "true";
}

export function validateModelOptimizationAccounts(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model_optimization_accounts 必须是 UID 到布尔值的映射");
  }
  const entries = Object.entries(value);
  if (entries.length > 10_000) throw new Error("model_optimization_accounts 最多配置 10000 个账号");
  const result = Object.create(null) as Record<string, boolean>;
  for (const [uid, enabled] of entries) {
    if (!uid.trim() || uid !== uid.trim() || uid.length > 256 || typeof enabled !== "boolean") {
      throw new Error("model_optimization_accounts 的 UID 必须非空且不超过 256 字符，值必须为布尔值");
    }
    result[uid] = enabled;
  }
  return result;
}
