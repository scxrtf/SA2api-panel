// GET /api/panel/models — 池账号实时模型目录 + 供应商目录（某域失败独立容错）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import {
  fetchModelsFull,
  fetchGlobalModelInfos,
  contextWindowListing,
  maxOutputTokensListing,
  type ModelInfoFull,
} from "@/lib/upstream/modelCatalog";
import { effortListing } from "@/lib/upstream/payload";
import { providerModels } from "@/lib/provider";
import { authShapeOf } from "@/lib/login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// panelModelEntry 组装单个池模型条目（对齐 Go panel.go panelModelEntry）：
// id 带 realm 前缀（调用值即显示值）；context_length / max_output_tokens 走四级
// 查找链；effort 档位按 realm 取 EffortListing（远端权威 ∪ 静态兜底表）——与
// /v1/models 同一口径，两侧不再漂移。能力布尔 true 才写（前端据此渲染徽标）。
function panelModelEntry(realm: string, mi: ModelInfoFull): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: realm + ":" + mi.id,
    name: mi.name ?? mi.id,
    credits: mi.credits ?? "",
    description: mi.description,
    vendor: mi.vendor,
  };
  if (mi.tags && mi.tags.length > 0) entry["tags"] = mi.tags;
  if (mi.isDefault) entry["is_default"] = true;
  if (mi.supportsReasoning) entry["supports_reasoning"] = true;
  if (mi.supportsToolCall) entry["supports_tool_call"] = true;
  if (mi.supportsImages) entry["supports_images"] = true;
  if (mi.onlyReasoning) entry["only_reasoning"] = true;
  if (mi.canDisableThinking) entry["can_disable_thinking"] = true;
  if (mi.reasoningSummary) entry["reasoning_summary"] = mi.reasoningSummary;
  if (mi.promoFactor !== undefined) {
    entry["promo_factor"] = mi.promoFactor;
    entry["promo_credits"] = mi.promoCredits;
  }
  if (mi.promoLabel) entry["promo_label"] = mi.promoLabel;
  if (mi.promoNote) entry["promo_note"] = mi.promoNote;
  if (mi.promoWindow) entry["promo_window"] = mi.promoWindow;
  if (mi.promoNextWindow) entry["promo_next_window"] = mi.promoNextWindow;
  entry["context_length"] = contextWindowListing(mi.id, mi.contextWindow);
  const mo = maxOutputTokensListing(mi.id, mi.maxTokens);
  if (mo !== undefined) entry["max_output_tokens"] = mo;
  const { efforts, defaultEffort } = effortListing(realm, mi.id, mi.efforts, mi.defaultEffort);
  if (efforts) {
    entry["supported_efforts"] = efforts;
    if (defaultEffort) entry["default_effort"] = defaultEffort;
  }
  return entry;
}

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const cfg = await getConfig();
  const out: Record<string, unknown>[] = [];
  const fetchErrs: string[] = [];

  // 池通道：CN / global 各取一个可用账号探测（某域无账号则整域跳过）。
  // realm 判定与 /v1/models 同口径：global 精确匹配，其余（""/"cn"）归 cn。
  const accounts = await prisma.account.findMany({ include: { state: true } });
  const usable = accounts.filter(
    (a) => !(a.state?.disabled ?? false) && !(a.state?.paused ?? false) && a.accessToken !== "",
  );
  const realmOf = (a: { realm: string }) => (a.realm === "global" ? "global" : "cn");
  for (const realm of ["cn", "global"] as const) {
    const acct = usable.find((a) => realmOf(a) === realm);
    if (!acct) continue;
    try {
      const shape = authShapeOf(acct);
      if (realm === "global") {
        // global 域纯动态四路探测（v3 三路 UA + 企业端点补缺），拉不出即空名单。
        const { names, infos } = await fetchGlobalModelInfos(cfg, shape);
        const infoMap = new Map<string, ModelInfoFull>();
        for (const mi of infos ?? []) infoMap.set(mi.id, mi);
        for (const id of names) {
          const mi = infoMap.get(id) ?? { id, contextWindow: 0, maxTokens: 0 };
          out.push(panelModelEntry(realm, mi));
        }
      } else {
        const infos = await fetchModelsFull(cfg, shape);
        for (const mi of infos) {
          out.push(panelModelEntry(realm, mi));
        }
      }
    } catch (e) {
      fetchErrs.push(realm + ": " + (e instanceof Error ? e.message : String(e)));
    }
  }

  // 供应商通道：name:model 前缀入库（与路由口径一致）。
  const providerErrs: string[] = [];
  try {
    for (const m of await providerModels(undefined, providerErrs)) {
      const name = m.owned_by;
      const bare = m.id.startsWith(name + ":") ? m.id.slice(name.length + 1) : m.id;
      out.push({ id: m.id, name: bare, vendor: name, provider: true });
    }
  } catch (e) {
    fetchErrs.push("providers: " + (e instanceof Error ? e.message : String(e)));
  }

  if (out.length === 0) {
    const errs = [...fetchErrs, ...providerErrs];
    if (errs.length > 0) return fail(502, "fetch models: " + errs.join("; "));
    return fail(503, "没有可用账号：请先在面板添加账号再查询");
  }
  // 供应商目录失败时透出原因，避免「探测能拿到模型、模型页却空着」无从排查。
  return ok({ models: out, ...(providerErrs.length > 0 ? { warnings: providerErrs } : {}) });
}
