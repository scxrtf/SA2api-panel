// GET /api/v1/models —— 聚合模型目录（对齐 Go internal/server/handler.go modelList）：
//   - CN 前缀 cn:、global 前缀 global:、供应商 name: 前缀；
//   - created:1753600000、owned_by:"workbuddy"（供应商 owned_by=name）；
//   - context_length / max_output_tokens 四级查找（上游动态值 → 静态种子表 →
//     进程内缓存 → models.dev 按需拉取，1M 兜底 / 输出上限未知则省略）；
//   - 上游模型对象全字段透出（applyModelInfoFields 空值省略规则）；
//   - effort 能力透出（远端 supportedEfforts 权威 → 静态兜底表 → 省略）。
// 纯动态：动态拉取失败/无号 → 该域空列表，无静态兜底。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { identifyKeyIdentity, providerAllowlist, verifyAny } from "@/lib/auth-guard";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { authShapeOf } from "@/lib/login";
import {
  fetchModelsFull,
  fetchGlobalModelInfos,
  contextWindowListing,
  maxOutputTokensListing,
  effortsSnapshot,
  type ModelInfoFull,
} from "@/lib/upstream/modelCatalog";
import { effortListing, globalEffortMap } from "@/lib/upstream/payload";
import { providerModels } from "@/lib/provider";

const MODEL_CREATED = 1753600000;

// fmtCreditsPrefix 从上游 credits 原文提取倍率并格式化为 "[x0.05 credit]"
// （上游格式不统一："x0.05 credits" / "x0.29" 等，统一提取 x数字 部分）。
function fmtCreditsPrefix(raw: string): string {
  let s = raw.trim();
  if (s.toLowerCase().endsWith("credits")) s = s.slice(0, -"credits".length);
  s = s.trim();
  if (s === "") return "";
  return "[" + s + " credit]";
}

// applyModelInfoFields 把上游模型对象全字段按「空值省略」写出规则合入条目
// （对齐 Go handler.go applyModelInfoFields，CN 与 global 共用同一字段集）。
function applyModelInfoFields(entry: Record<string, unknown>, mi: ModelInfoFull): void {
  if (mi.name) entry["name"] = mi.name;
  if (mi.description) {
    // 积分倍率前缀拼入 description，方便下游面板直接展示。
    entry["description"] = mi.credits
      ? fmtCreditsPrefix(mi.credits) + " " + mi.description
      : mi.description;
  }
  if (mi.credits) entry["credits"] = mi.credits; // 积分倍率原文，仅展示
  if (mi.tags && mi.tags.length > 0) entry["tags"] = mi.tags;
  if (mi.vendor) entry["vendor"] = mi.vendor;
  if (mi.isDefault) entry["is_default"] = true;
  if (mi.supportsImages) entry["supports_images"] = true;
  if (mi.supportsReasoning) {
    entry["supports_reasoning"] = true;
    if (mi.canDisableThinking) entry["can_disable_thinking"] = true;
  }
  if (mi.supportsToolCall) entry["supports_tool_call"] = true;
  if (mi.onlyReasoning) entry["only_reasoning"] = true;
  if (mi.maxAllowedSize && mi.maxAllowedSize > 0) entry["max_allowed_size"] = mi.maxAllowedSize;
  if (mi.reasoningEffort) entry["reasoning_effort"] = mi.reasoningEffort;
  if (mi.reasoningSummary) entry["reasoning_summary"] = mi.reasoningSummary;
  // 限时优惠（生效价 + 标签 + 说明；credits 字段是牌价）。
  if (mi.promoFactor !== undefined) entry["promo_factor"] = mi.promoFactor;
  if (mi.promoCredits) entry["promo_credits"] = mi.promoCredits;
  if (mi.promoLabel) entry["promo_label"] = mi.promoLabel;
  if (mi.promoNote) entry["promo_note"] = mi.promoNote;
}

// buildEntry 组装单模型条目：基础字段 + 四级查找 + 全字段透出 + effort 能力。
function buildEntry(
  prefixedID: string,
  bareID: string,
  realm: string,
  mi: ModelInfoFull | undefined,
  remoteEfforts?: string[],
  remoteDefault?: string,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: prefixedID,
    object: "model",
    created: MODEL_CREATED,
    owned_by: "workbuddy",
  };
  if (mi) applyModelInfoFields(entry, mi);
  entry["context_length"] = contextWindowListing(bareID, mi?.contextWindow ?? 0);
  const mo = maxOutputTokensListing(bareID, mi?.maxTokens ?? 0);
  if (mo !== undefined) entry["max_output_tokens"] = mo;
  const { efforts, defaultEffort } = effortListing(
    realm,
    bareID,
    remoteEfforts ?? mi?.efforts,
    remoteDefault ?? mi?.defaultEffort,
  );
  if (efforts) {
    entry["reasoning_supported_efforts"] = efforts;
    if (defaultEffort) entry["reasoning_default_effort"] = defaultEffort;
  }
  return entry;
}

export async function GET(req: Request): Promise<Response> {
  if (!(await verifyAny(req))) {
    return Response.json(
      { error: { message: "invalid or missing api key", type: "invalid_api_key" } },
      { status: 401 },
    );
  }
  const cfg = await getConfig();
  // 供应商模型目录按 key 授权过滤：主线（主密钥 / 未启用鉴权）不限制；
  // 子密钥只列出已授权供应商；身份缺失按空集合处理（fail closed）。
  const keyIdentity = await identifyKeyIdentity(req);
  const providerAllow = providerAllowlist(keyIdentity);
  const data: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  // 池通道：CN / global 各取一个可用账号探测（某域无账号则整域跳过）。
  const accounts = await prisma.account.findMany({ include: { state: true } });
  const usable = accounts.filter(
    (a) => !(a.state?.disabled ?? false) && !(a.state?.paused ?? false) && a.accessToken !== "",
  );
  // CN 域：v3/config 主路 + 企业端点补缺（fetchModelsFull 内部刷新 effort 桶）。
  const cnAcct = usable.find((a) => a.realm !== "global");
  if (cnAcct) {
    try {
      for (const mi of await fetchModelsFull(cfg, authShapeOf(cnAcct))) {
        const id = "cn:" + mi.id;
        if (seen.has(id)) continue;
        seen.add(id);
        data.push(buildEntry(id, mi.id, "cn", mi));
      }
    } catch {
      // 单域目录失败不影响整体（纯动态：失败 → 该域空列表）。
    }
  }

  // global 域：纯动态四路探测；effort 桶 = globalEffortMap(远端桶 ∪ 静态兜底) 合成。
  const globalAcct = usable.find((a) => a.realm === "global");
  if (globalAcct) {
    try {
      const { names, infos } = await fetchGlobalModelInfos(cfg, authShapeOf(globalAcct));
      const infoMap = new Map<string, ModelInfoFull>();
      for (const mi of infos ?? []) infoMap.set(mi.id, mi);
      const snap = effortsSnapshot("global");
      const merged = globalEffortMap(snap.efforts, snap.defaults);
      for (const id of names) {
        const pid = "global:" + id;
        if (seen.has(pid)) continue;
        seen.add(pid);
        const mi = infoMap.get(id);
        data.push(buildEntry(pid, id, "global", mi, merged.efforts[id], merged.defs[id]));
      }
    } catch {
      // 同上。
    }
  }

  // 供应商通道：name:model 前缀（远端探测失败 → 该供应商空名单，不阻塞其他）。
  for (const m of await providerModels(providerAllow)) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    data.push({ id: m.id, object: "model", created: MODEL_CREATED, owned_by: m.owned_by });
  }

  return Response.json({ object: "list", data });
}
