// GET /api/panel/usage — 用量聚合（对齐 Go usage.SnapshotWindow 的同构输出）。
// 口径：hours 滚动窗口（默认 72）/ from-to 显式区间 / 全部历史（hours=0）。
// 聚合维度：totals / by_realm / by_account / by_model / by_key / by_provider /
// by_provider_model / series / series_group / credit_by_account / credit_by_model。
// 另含 credit_by_key：按 API Key 归属的积分扣除明细。
// series_group 仅在请求带 group=key|model|account|provider|realm 时返回，
// 供面板把「用量时序」拆成可选维度的堆叠图；不传 group 时保持轻量旧响应。
import { panelAuth, ok } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { currentModelRate } from "@/lib/upstream/modelCatalog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Agg {
  requests: number;
  errors: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  credits: number;
  credit_samples: number;
  credit_tokens: number;
  credits_per_1m_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  cache_hit_rate: number;
  avg_latency_ms: number;
  avg_tokens_per_second: number;
}

class AggAcc {
  requests = 0; errors = 0;
  prompt = 0; completion = 0; total = 0;
  credits = 0; creditSamples = 0; creditTokens = 0;
  cacheHit = 0; cacheMiss = 0;
  latSum = 0; latSamples = 0;
  tpsSum = 0; tpsSamples = 0;

  add(e: UsageRow): void {
    this.requests++;
    if (!e.ok) this.errors++;
    this.prompt += e.promptTokens;
    this.completion += e.completionTok;
    this.total += e.totalTokens;
    if (e.hasCredit) {
      this.credits += e.credit;
      this.creditSamples++;
      this.creditTokens += e.totalTokens;
    }
    this.cacheHit += e.cacheHitTok;
    this.cacheMiss += e.cacheMissTok;
    if (e.latencyMs > 0) {
      this.latSum += e.latencyMs;
      this.latSamples++;
    }
    if (e.tps > 0) {
      this.tpsSum += e.tps;
      this.tpsSamples++;
    }
  }

  finish(): Agg {
    return {
      requests: this.requests,
      errors: this.errors,
      prompt_tokens: this.prompt,
      completion_tokens: this.completion,
      total_tokens: this.total,
      credits: this.credits,
      credit_samples: this.creditSamples,
      credit_tokens: this.creditTokens,
      credits_per_1m_tokens: this.creditTokens > 0 ? this.credits / this.creditTokens * 1_000_000 : 0,
      cache_hit_tokens: this.cacheHit,
      cache_miss_tokens: this.cacheMiss,
      cache_hit_rate: this.cacheHit + this.cacheMiss > 0 ? this.cacheHit / (this.cacheHit + this.cacheMiss) * 100 : 0,
      avg_latency_ms: this.latSamples > 0 ? this.latSum / this.latSamples : 0,
      avg_tokens_per_second: this.tpsSamples > 0 ? this.tpsSum / this.tpsSamples : 0,
    };
  }
}

interface UsageRow {
  uid: string; model: string; realm: string;
  provider?: string;
  promptTokens: number; completionTok: number; totalTokens: number;
  credit: number; hasCredit: boolean;
  cacheHitTok: number; cacheMissTok: number;
  latencyMs: number; tps: number;
  keyName: string; modelRate: string;
  ok: boolean;
  at: Date;
}

interface KeyedAgg { key: string; realm?: string; extra?: string; agg: Agg }

type SeriesDim = "key" | "model" | "account" | "provider" | "realm";
const SERIES_DIMS = new Set<string>(["key", "model", "account", "provider", "realm"]);

interface GroupSeries {
  key: string;
  label: string;
  realm?: string;
  buckets: Map<string, AggAcc>;
}

function keyedFinish(m: Map<string, AggAcc>, label: (k: string) => { realm?: string; extra?: string }): KeyedAgg[] {
  const out: KeyedAgg[] = [];
  for (const [k, acc] of m) {
    const { realm, extra } = label(k);
    out.push({ key: k, realm, extra, agg: acc.finish() });
  }
  out.sort((a, b) =>
    b.agg.total_tokens - a.agg.total_tokens ||
    b.agg.requests - a.agg.requests ||
    a.key.localeCompare(b.key),
  );
  return out;
}

interface CreditAgg {
  key: string; realm?: string; nickname?: string; rate?: string;
  requests: number; credits: number; credit_samples: number; credit_tokens: number;
  credits_per_1m_tokens: number;
  cache_hit_tokens: number; cache_miss_tokens: number; cache_hit_rate: number;
}

class CreditAcc {
  requests = 0; credits = 0; samples = 0; tokens = 0;
  cacheHit = 0; cacheMiss = 0;
  add(e: UsageRow): void {
    this.requests++;
    this.credits += e.credit;
    this.samples++;
    this.tokens += e.totalTokens;
    this.cacheHit += e.cacheHitTok;
    this.cacheMiss += e.cacheMissTok;
  }
}

function creditFinish(m: Map<string, CreditAcc>): CreditAgg[] {
  const out: CreditAgg[] = [];
  for (const [k, acc] of m) {
    const [key, rate] = k.split("\x00");
    out.push({
      key,
      rate: rate || "",
      requests: acc.requests,
      credits: acc.credits,
      credit_samples: acc.samples,
      credit_tokens: acc.tokens,
      credits_per_1m_tokens: acc.tokens > 0 ? acc.credits / acc.tokens * 1_000_000 : 0,
      cache_hit_tokens: acc.cacheHit,
      cache_miss_tokens: acc.cacheMiss,
      cache_hit_rate: acc.cacheHit + acc.cacheMiss > 0 ? acc.cacheHit / (acc.cacheHit + acc.cacheMiss) * 100 : 0,
    });
  }
  out.sort((a, b) => b.credits - a.credits || b.credit_tokens - a.credit_tokens || a.key.localeCompare(b.key));
  return out;
}

// canonicalUsageModel 去掉 cn:/global: 前缀（Go canonicalUsageModel）。
function canonicalUsageModel(model: string): string {
  let m = (model ?? "").trim();
  for (const p of ["cn:", "global:"]) {
    if (m.startsWith(p)) { m = m.slice(p.length); break; }
  }
  return m || "(unknown)";
}

// providerNameFromRealm 提取 "provider:名字" 的供应商名；非供应商桶返回空。
function providerNameFromRealm(realm: string): string {
  if (!realm.startsWith("provider:")) return "";
  return realm.slice("provider:".length);
}

// beijingParts 分桶锚定北京时间（Go tz.Beijing 同语义）。
function beijingParts(d: Date): { hour: string; day: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const hh = parts.hour === "24" ? "00" : parts.hour;
  return { hour: `${day}T${hh}`, day };
}

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const q = new URL(req.url).searchParams;
  const groupRaw = (q.get("group") ?? "").trim();
  const groupDim = (SERIES_DIMS.has(groupRaw) ? groupRaw : "") as SeriesDim | "";
  const from = parseTime(q.get("from"));
  const to = parseTime(q.get("to"));
  let since: Date | null = from;
  const until: Date | null = to;
  let explicit = false;
  if (!since && !until) {
    let hours = parseInt(q.get("hours") ?? "72", 10);
    if (!Number.isFinite(hours) || hours < 0) hours = 72;
    if (hours > 1440) hours = 1440;
    if (hours > 0) since = new Date(Date.now() - hours * 3600_000);
  } else {
    explicit = true;
  }
  const where: Record<string, unknown> = {};
  if (since || until) {
    where["at"] = {};
    if (since) (where["at"] as Record<string, unknown>)["gte"] = since;
    if (until) (where["at"] as Record<string, unknown>)["lte"] = until;
  }

  const events = (await prisma.usageEvent.findMany({
    where,
    orderBy: { at: "asc" },
  })) as unknown as UsageRow[];
  const nicks = new Map<string, string>();
  for (const a of await prisma.account.findMany({ select: { uid: true, nickname: true } })) {
    nicks.set(a.uid, a.nickname);
  }

  const total = new AggAcc();
  const realmAgg = new Map<string, AggAcc>();
  const acctAgg = new Map<string, AggAcc>();
  const acctRealm = new Map<string, string>();
  const modelAgg = new Map<string, AggAcc>();
  const keyAgg = new Map<string, AggAcc>();
  const keyRealm = new Map<string, string>();
  const providerAgg = new Map<string, AggAcc>();
  const providerModelAgg = new Map<string, AggAcc>();
  const hourSeries = new Map<string, AggAcc>();
  const daySeries = new Map<string, AggAcc>();
  const creditAcctAgg = new Map<string, CreditAcc>();
  const creditModelAgg = new Map<string, CreditAcc>();
  const creditKeyAgg = new Map<string, CreditAcc>();
  const groupSeries = new Map<string, GroupSeries>();
  const rateCache = new Map<string, string>();
  // 窗口 > 7 天按日分桶，否则按小时（旧版前端同口径）。
  const dayScope = since !== null && (Date.now() - since.getTime()) > 7 * 86_400_000;

  for (const e of events) {
    total.add(e);
    const realm = e.realm || "cn";
    if (!realmAgg.has(realm)) realmAgg.set(realm, new AggAcc());
    realmAgg.get(realm)!.add(e);
    if (!acctAgg.has(e.uid)) acctAgg.set(e.uid, new AggAcc());
    acctAgg.get(e.uid)!.add(e);
    if (!acctRealm.has(e.uid)) acctRealm.set(e.uid, realm);
    const model = e.model || "(unknown)";
    if (!modelAgg.has(model)) modelAgg.set(model, new AggAcc());
    modelAgg.get(model)!.add(e);
    // 按 key 维度：旧记录 keyName 为空 = 上线前未归属，归入 "(未知)"。
    const kn = e.keyName || "(未知)";
    if (!keyAgg.has(kn)) keyAgg.set(kn, new AggAcc());
    keyAgg.get(kn)!.add(e);
    if (!keyRealm.has(kn)) keyRealm.set(kn, realm);
    // 供应商维度：realm 形如 "provider:名字"；第二层按供应商×裸模型名。
    // 兜底：旧记录 realm 未带前缀但 provider 列非空时也归入供应商桶（防明细缺失）。
    const prov = providerNameFromRealm(realm) || (e.provider ?? "");
    const provKey = prov || "内置池";
    if (prov) {
      if (!providerAgg.has(prov)) providerAgg.set(prov, new AggAcc());
      providerAgg.get(prov)!.add(e);
      const pmKey = prov + ":" + canonicalUsageModel(model);
      if (!providerModelAgg.has(pmKey)) providerModelAgg.set(pmKey, new AggAcc());
      providerModelAgg.get(pmKey)!.add(e);
    }
    const { hour, day } = beijingParts(new Date(e.at));
    const scopeKey = dayScope ? day : hour;
    const scopeMap = dayScope ? daySeries : hourSeries;
    if (!scopeMap.has(scopeKey)) scopeMap.set(scopeKey, new AggAcc());
    scopeMap.get(scopeKey)!.add(e);
    if (groupDim) {
      // 分组时序：同一时间桶里按所选维度拆成多个堆叠段。
      let gk: string, glabel: string, grealm: string | undefined;
      if (groupDim === "key") {
        gk = kn; glabel = kn; grealm = realm;
      } else if (groupDim === "model") {
        gk = model; glabel = model;
      } else if (groupDim === "account") {
        gk = e.uid; glabel = nicks.get(e.uid) || e.uid.slice(0, 8) || "(未知)";
        grealm = realm;
      } else if (groupDim === "provider") {
        gk = provKey; glabel = provKey;
      } else {
        gk = realm; glabel = realm;
      }
      let g = groupSeries.get(gk);
      if (!g) {
        g = { key: gk, label: glabel, realm: grealm, buckets: new Map() };
        groupSeries.set(gk, g);
      }
      if (!g.buckets.has(scopeKey)) g.buckets.set(scopeKey, new AggAcc());
      g.buckets.get(scopeKey)!.add(e);
    }
    // 积分维度只统计 hasCredit 样本；模型维度按 (裸模型, 生效倍率) 分组，
    // 旧记录缺倍率时用当前目录倍率回填（不伪造未知价格）。
    if (e.hasCredit) {
      if (!creditAcctAgg.has(e.uid)) creditAcctAgg.set(e.uid, new CreditAcc());
      creditAcctAgg.get(e.uid)!.add(e);
      const ckn = e.keyName || "(未知)";
      if (!creditKeyAgg.has(ckn)) creditKeyAgg.set(ckn, new CreditAcc());
      creditKeyAgg.get(ckn)!.add(e);
      const cm = canonicalUsageModel(model);
      let rate = e.modelRate;
      if (!rate) {
        const ck = realm + "\x00" + cm;
        if (rateCache.has(ck)) {
          rate = rateCache.get(ck)!;
        } else {
          rate = providerNameFromRealm(realm) ? "" : currentModelRate(realm, cm);
          rateCache.set(ck, rate);
        }
      }
      const mk = cm + "\x00" + rate;
      if (!creditModelAgg.has(mk)) creditModelAgg.set(mk, new CreditAcc());
      creditModelAgg.get(mk)!.add(e);
    }
  }

  // 时序升序输出（day 与 hour 不会混用——同一窗口同一口径）。
  const series = [...(dayScope ? daySeries : hourSeries).entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, acc]) => {
      const agg = acc.finish();
      const ts = dayScope
        ? Date.parse(t + "T00:00:00+08:00")
        : Date.parse(t + ":00:00+08:00");
      return { t: ts, scope: dayScope ? "day" : "hour", label: t.slice(5), ...agg };
    });

  const byAccount = keyedFinish(acctAgg, (k) => ({ extra: nicks.get(k) ?? "" }));
  for (const row of byAccount) row.realm = acctRealm.get(row.key) ?? "";

  const byProviderModel = [...providerModelAgg.entries()]
    .map(([k, acc]) => {
      const idx = k.indexOf(":");
      const prov = k.slice(0, idx);
      const model = k.slice(idx + 1);
      return { key: k, realm: prov, extra: model, agg: acc.finish() };
    })
    .sort((a, b) =>
      (a.realm ?? "").localeCompare(b.realm ?? "") ||
      b.agg.total_tokens - a.agg.total_tokens ||
      a.key.localeCompare(b.key),
    );

  const creditByAccount = creditFinish(creditAcctAgg);
  for (const r of creditByAccount) r.nickname = nicks.get(r.key) ?? "";

  // 维度时序：每个分组保持稀疏点集，由前端按主轴桶对齐并堆叠。
  // 排序按窗口内合计 Token 降序，前端只展示 Top N，其余自动归入「其它」。
  const seriesGroup = groupDim ? {
    dim: groupDim,
    scope: dayScope ? "day" : "hour",
    groups: [...groupSeries.values()]
      .map((g) => {
        let prompt = 0, completion = 0, total = 0, requests = 0;
        const points = [...g.buckets.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([t, acc]) => {
            const agg = acc.finish();
            prompt += agg.prompt_tokens;
            completion += agg.completion_tokens;
            total += agg.total_tokens;
            requests += agg.requests;
            const ts = dayScope
              ? Date.parse(t + "T00:00:00+08:00")
              : Date.parse(t + ":00:00+08:00");
            return {
              t: ts,
              scope: dayScope ? "day" : "hour",
              label: t.slice(5),
              ...agg,
            };
          });
        return {
          key: g.key,
          label: g.label,
          realm: g.realm,
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: total,
          requests,
          points,
        };
      })
      .sort((a, b) =>
        b.total_tokens - a.total_tokens ||
        b.requests - a.requests ||
        a.label.localeCompare(b.label),
      ),
  } : null;

  const sinceRow = events.length > 0 ? events[0].at : null;
  return ok({
    totals: total.finish(),
    by_realm: keyedFinish(realmAgg, () => ({})),
    by_account: byAccount,
    by_model: keyedFinish(modelAgg, () => ({})),
    by_key: keyedFinish(keyAgg, (k) => ({ realm: keyRealm.get(k) ?? "" })),
    by_provider: keyedFinish(providerAgg, () => ({})),
    by_provider_model: byProviderModel,
    credit_by_account: creditByAccount,
    credit_by_model: creditFinish(creditModelAgg),
    credit_by_key: creditFinish(creditKeyAgg),
    series,
    series_group: seriesGroup,
    buckets: events.length,
    since: sinceRow ? new Date(sinceRow).toISOString() : "",
    window_from: explicit && from ? from.toISOString() : "",
    window_to: explicit && to ? to.toISOString() : "",
    generated: new Date().toISOString(),
  });
}

function parseTime(v: string | null): Date | null {
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) return new Date(n > 1e12 ? n : n * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : new Date(t);
}
