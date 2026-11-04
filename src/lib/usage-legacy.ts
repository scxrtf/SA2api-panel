// 旧版 Node.js 用量聚合。仅由只读对拍脚本使用，生产路由走 usage-query.ts。
import { currentModelRate } from "@/lib/upstream/modelCatalog";
import type { UsageAggRow } from "./usage-aggregation";

export type SeriesDim = "key" | "model" | "account" | "provider" | "realm";

export interface LegacyUsageRow {
  uid: string; model: string; realm: string; provider?: string;
  promptTokens: number; completionTok: number; totalTokens: number;
  credit: number; hasCredit: boolean; cacheHitTok: number; cacheMissTok: number;
  latencyMs: number; tps: number; keyName: string; modelRate: string;
  ok: boolean; at: Date;
}

class Acc {
  requests = 0; errors = 0; prompt = 0; completion = 0; total = 0;
  credits = 0; creditSamples = 0; creditTokens = 0;
  cacheHit = 0; cacheMiss = 0; latSum = 0; latSamples = 0;
  tpsSum = 0; tpsSamples = 0;
  add(e: LegacyUsageRow): void {
    this.requests++;
    if (!e.ok) this.errors++;
    this.prompt += e.promptTokens; this.completion += e.completionTok; this.total += e.totalTokens;
    if (e.hasCredit) {
      this.credits += e.credit; this.creditSamples++; this.creditTokens += e.totalTokens;
    }
    this.cacheHit += e.cacheHitTok; this.cacheMiss += e.cacheMissTok;
    if (e.latencyMs > 0) { this.latSum += e.latencyMs; this.latSamples++; }
    if (e.tps > 0) { this.tpsSum += e.tps; this.tpsSamples++; }
  }
  row(dimension: string, key = "", realm = "", extra = "", bucket = "", eventAt: Date | null = null): UsageAggRow {
    return {
      dimension, key, realm, extra, bucket, eventAt,
      requests: this.requests, errors: this.errors, prompt: this.prompt, completion: this.completion,
      total: this.total, credit: this.credits, creditSamples: this.creditSamples,
      creditTokens: this.creditTokens, cacheHit: this.cacheHit, cacheMiss: this.cacheMiss,
      latSum: this.latSum, latSamples: this.latSamples, tpsSum: this.tpsSum, tpsSamples: this.tpsSamples,
    };
  }
}

class CreditAcc {
  requests = 0; credits = 0; samples = 0; tokens = 0; cacheHit = 0; cacheMiss = 0;
  add(e: LegacyUsageRow): void {
    this.requests++; this.credits += e.credit; this.samples++; this.tokens += e.totalTokens;
    this.cacheHit += e.cacheHitTok; this.cacheMiss += e.cacheMissTok;
  }
  row(dimension: string, key: string, realm = "", extra = ""): UsageAggRow {
    return {
      dimension, key, realm, extra, bucket: "", eventAt: null,
      requests: this.requests, errors: 0, prompt: 0, completion: 0, total: 0,
      credit: this.credits, creditSamples: this.samples, creditTokens: this.tokens,
      cacheHit: this.cacheHit, cacheMiss: this.cacheMiss, latSum: 0, latSamples: 0,
      tpsSum: 0, tpsSamples: 0,
    };
  }
}

const canonical = (value: string): string => {
  let model = (value ?? "").trim();
  for (const prefix of ["cn:", "global:"]) {
    if (model.startsWith(prefix)) { model = model.slice(prefix.length); break; }
  }
  return model || "（未知模型）";
};
const providerFromRealm = (realm: string): string => realm.startsWith("provider:") ? realm.slice(9) : "";

function beijingParts(value: Date): { hour: string; day: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  }).formatToParts(value);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const day = `${p.year}-${p.month}-${p.day}`;
  return { day, hour: `${day}T${p.hour === "24" ? "00" : p.hour}` };
}

// 输出与 SQL 分支同形，随后交给同一个 buildUsageSnapshot，隔离验证 SQL 的口径。
export function legacyUsageRows(events: LegacyUsageRow[], dayScope: boolean, groupDim: SeriesDim | ""): UsageAggRow[] {
  const total = new Acc(); const providerTotal = new Acc();
  const all = new Map<string, Map<string, Acc>>();
  const get = (dimension: string, key: string): Acc => {
    let map = all.get(dimension);
    if (!map) { map = new Map(); all.set(dimension, map); }
    let acc = map.get(key);
    if (!acc) { acc = new Acc(); map.set(key, acc); }
    return acc;
  };
  const credit = new Map<string, Map<string, CreditAcc>>();
  const getCredit = (dimension: string, key: string): CreditAcc => {
    let map = credit.get(dimension);
    if (!map) { map = new Map(); credit.set(dimension, map); }
    let acc = map.get(key);
    if (!acc) { acc = new CreditAcc(); map.set(key, acc); }
    return acc;
  };
  const groupRealms = new Map<string, string>();

  for (const e of events) {
    total.add(e);
    const realm = e.realm || "cn";
    const model = e.model || "（未知模型）";
    const key = e.keyName || "(未知)";
    const prov = providerFromRealm(realm) || (e.provider ?? "");
    get("by_realm", realm).add(e);
    get("by_account", e.uid).add(e);
    get("by_model", model).add(e);
    get("by_key", key).add(e);
    get("by_key_model", key + "\x00" + model).add(e);
    if (prov) {
      providerTotal.add(e);
      get("by_provider", prov).add(e);
      get("by_provider_model", prov + ":" + canonical(model)).add(e);
    } else {
      get("by_pool_model", model).add(e);
      get("by_pool_key", key).add(e);
      get("by_pool_key_model", key + "\x00" + model).add(e);
    }
    const parts = beijingParts(e.at);
    const bucket = dayScope ? parts.day : parts.hour;
    get("series", bucket).add(e);
    if (groupDim) {
      const groupKey = groupDim === "key" ? key : groupDim === "model" ? model
        : groupDim === "account" ? e.uid : groupDim === "provider" ? prov || "内置池" : realm;
      get("series_group", groupKey + "\x00" + bucket).add(e);
      if (!groupRealms.has(groupKey)) groupRealms.set(groupKey, realm);
    }
    if (e.hasCredit) {
      getCredit("credit_by_account", e.uid).add(e);
      getCredit("credit_by_key", key).add(e);
      const cm = canonical(model);
      const rate = e.modelRate || (providerFromRealm(realm) ? "" : currentModelRate(realm, cm));
      getCredit("credit_by_model", cm + "\x00" + realm + "\x00" + rate).add(e);
    }
  }

  const out = [total.row("totals", "", "", "", "", events[0]?.at ?? null), providerTotal.row("provider_totals")];
  for (const [dimension, map] of all) {
    for (const [key, acc] of map) {
      if (dimension === "series") out.push(acc.row(dimension, "", "", "", key));
      else if (dimension === "series_group") {
        const [groupKey, bucket] = key.split("\x00");
        out.push(acc.row(dimension, groupKey, groupRealms.get(groupKey) ?? "", "", bucket));
      } else if (dimension === "by_account" || dimension === "by_key") {
        const first = events.find((e) => dimension === "by_account" ? e.uid === key : (e.keyName || "(未知)") === key);
        out.push(acc.row(dimension, key, first?.realm || "cn"));
      } else if (dimension === "by_key_model" || dimension === "by_pool_key_model") {
        const [keyName, model] = key.split("\x00");
        out.push(acc.row(dimension, key, keyName, model));
      } else if (dimension === "by_provider_model") {
        const split = key.indexOf(":");
        out.push(acc.row(dimension, key, key.slice(0, split), key.slice(split + 1)));
      } else out.push(acc.row(dimension, key));
    }
  }
  for (const [dimension, map] of credit) {
    for (const [key, acc] of map) {
      if (dimension === "credit_by_model") {
        const [model, realm, rate] = key.split("\x00");
        out.push(acc.row(dimension, model, realm, rate));
      } else out.push(acc.row(dimension, key));
    }
  }
  return out;
}
