// 上游响应结构探针（脱敏）。
//
// 用法：
//   node --env-file=.env scripts/dump-upstream.mjs --realm cn --endpoint all
//   node --env-file=.env scripts/dump-upstream.mjs --realm cn --endpoint config
//   node --env-file=.env scripts/dump-upstream.mjs --realm cn --endpoint models
//   node --env-file=.env scripts/dump-upstream.mjs --realm cn --endpoint chat --model hy3
//   node --env-file=.env scripts/dump-upstream.mjs --realm cn --endpoint billing
//
// 安全边界：
//   - 不打印 accessToken / refreshToken / DATABASE_URL / DIRECT_URL / WB2A_API_KEY；
//   - uid 只显示前 6 位；
//   - billing 响应按敏感键名递归打码；
//   - 原始响应不落盘，只落脱敏摘要。

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const CHAT_BASE_CN = "https://copilot.tencent.com";
const BILLING_BASE_CN = "https://www.codebuddy.cn";
const GLOBAL_BASE = "https://www.workbuddy.ai";
const CLIENT_VERSION = "5.5.4";
const CLI_VERSION = "2.137.1";
const IDE_UA = "CodeBuddyIDE/4.12.0 CodeBuddy/4.12.0";

const args = parseArgs(process.argv.slice(2));
const realm = args.realm === "global" ? "global" : "cn";
const endpoint = args.endpoint || "all";
const want = (name) => endpoint === "all" || endpoint === name;
const modelArg = args.model || "auto";
const outDir = join(process.cwd(), "data", "upstream-dumps");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = join(outDir, `dump-${realm}-${stamp}.json`);

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function uidPrefix(uid) {
  return uid ? uid.slice(0, 6) + "…" : "";
}

function stableID(uid, purpose) {
  return createHash("sha256").update(`wb2a:${purpose}:${uid}`, "utf8").digest("hex").slice(0, 36);
}

function chatBase(a) {
  return a.realm === "global" ? GLOBAL_BASE : CHAT_BASE_CN;
}

function billingBase(a) {
  return a.realm === "global" ? GLOBAL_BASE : BILLING_BASE_CN;
}

function origin(a) {
  return a.realm === "global" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn";
}

function clientVersion() {
  return CLIENT_VERSION;
}

function userAgent(a) {
  const platform = a.realm === "global" ? "WorkBuddy AI" : "WorkBuddy";
  return `WorkBuddy/${clientVersion()} ${platform}/${clientVersion()} CLI/${CLI_VERSION}`;
}

function commonHeaders(a) {
  const o = origin(a);
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Requested-With": "XMLHttpRequest",
    Origin: o,
    Referer: o + "/",
    "User-Agent": userAgent(a),
    "X-CodeBuddy-Request": "1",
    "Accept-Language": a.realm === "global" ? "en-US" : "zh-CN",
  };
  if (a.uid) {
    h["X-Machine-ID"] = stableID(a.uid, "machine");
    h["X-Session-ID"] = stableID(a.uid, "session");
  }
  return h;
}

function v3Domain(a) {
  const d = (a.domain || "").trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (d) return d;
  try {
    return new URL(chatBase(a)).host;
  } catch {
    return a.realm === "global" ? "www.workbuddy.ai" : "copilot.tencent.com";
  }
}

function v3Headers(a) {
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Authorization: "Bearer " + a.accessToken,
    ...(a.uid ? { "X-User-Id": a.uid } : {}),
    "X-Domain": v3Domain(a),
    "X-Product": "SaaS",
    "User-Agent": IDE_UA,
    "X-CodeBuddy-Request": "1",
  };
}

function billingHeaders(a) {
  const h = {
    Authorization: "Bearer " + a.accessToken,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-CodeBuddy-Request": "1",
    "Accept-Language": a.realm === "global" ? "en-US" : "zh-CN",
    "User-Agent": `WorkBuddy/${clientVersion()}`,
  };
  if (a.uid) h["X-User-Id"] = a.uid;
  if (a.enterpriseId) {
    h["X-Enterprise-Id"] = a.enterpriseId;
    h["X-Tenant-Id"] = a.enterpriseId;
  }
  if (a.domain) h["X-Domain"] = a.domain;
  if (a.deviceToken) h["X-Device-Token"] = a.deviceToken;
  return h;
}

function chatHeaders(a, meta) {
  const h = commonHeaders(a);
  h.Accept = "application/json, text/event-stream";
  h.Authorization = "Bearer " + a.accessToken;
  if (a.uid) h["X-User-Id"] = a.uid;
  if (a.realm === "global") {
    h["X-No-Enterprise-Id"] = "1";
    h["X-Domain"] = "www.workbuddy.ai";
  } else if (a.enterpriseId) {
    h["X-Enterprise-Id"] = a.enterpriseId;
  } else {
    h["X-No-Enterprise-Id"] = "1";
  }
  if (a.realm !== "global") {
    if (a.domain) h["X-Domain"] = a.domain;
    else h["X-No-Department-Info"] = "1";
  }
  h["X-Agent-Purpose"] = "conversation";
  h["X-IDE-Name"] = "WorkBuddy";
  h["X-IDE-Type"] = "WorkBuddy";
  h["X-IDE-Version"] = clientVersion();
  h["X-Product"] = "WorkBuddy";
  if (a.deviceToken) h["X-Device-Token"] = a.deviceToken;
  if (meta.conversationID) h["X-Conversation-ID"] = meta.conversationID;
  h["X-Conversation-Request-ID"] = meta.conversationRequestID;
  h["X-Conversation-Message-ID"] = meta.messageID;
  h["X-Request-ID"] = meta.messageID;
  h["X-Root-Request-ID"] = meta.conversationRequestID;
  h["X-Trace-ID"] = meta.traceID;
  h["X-B3-TraceId"] = meta.conversationRequestID;
  h["X-B3-SpanId"] = meta.messageID.slice(0, 16);
  h["X-B3-Sampled"] = "1";
  return h;
}

async function fetchJSON(url, headers, init = {}) {
  const t0 = Date.now();
  const resp = await fetch(url, {
    ...init,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await resp.text();
  return {
    status: resp.status,
    contentType: resp.headers.get("content-type") || "",
    requestID: resp.headers.get("x-request-id") || resp.headers.get("x-trace-id") || "",
    elapsedMs: Date.now() - t0,
    raw,
  };
}

function parseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function objKeys(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : [];
}

function countByType(list) {
  const types = {};
  for (const v of list) {
    const t = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    types[t] = (types[t] || 0) + 1;
  }
  return types;
}

function fieldStats(models) {
  const paths = new Map();
  const add = (path, v) => {
    if (!paths.has(path)) paths.set(path, []);
    paths.get(path).push(v);
  };
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    for (const [k, v] of Object.entries(m)) {
      add(k, v);
      if (k === "reasoning" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [rk, rv] of Object.entries(v)) add(`reasoning.${rk}`, rv);
      }
      if (k === "badge" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [bk, bv] of Object.entries(v)) add(`badge.${bk}`, bv);
      }
      if (k === "hover" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [hk, hv] of Object.entries(v)) add(`hover.${hk}`, hv);
      }
      if (k === "schedule" && v && typeof v === "object" && !Array.isArray(v)) {
        for (const [sk, sv] of Object.entries(v)) add(`schedule.${sk}`, sv);
      }
    }
  }
  const out = [];
  for (const [path, values] of [...paths.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    out.push({
      path,
      present: values.length,
      missing: models.length - values.length,
      types: countByType(values),
      examples: [...new Set(values.map((v) => JSON.stringify(v)))].slice(0, 3).map((s) => {
        try {
          const v = JSON.parse(s);
          if (typeof v === "string" && v.length > 120) return v.slice(0, 120) + "…";
          return v;
        } catch {
          return s;
        }
      }),
    });
  }
  return out;
}

function sanitizeDeep(v, key = "") {
  const k = key.toLowerCase();
  if (/(token|authorization|cookie|secret|password|passwd|apikey|api_key|accesskey|access_key|privatekey|private_key|connectionstring)/.test(k)) {
    return "[REDACTED]";
  }
  if (/(^|_)(uid|userid|user_id|accountid|account_id|tenantid|tenant_id|enterpriseid|enterprise_id|deviceid|device_id|machineid|machine_id|sessionid|session_id)$/.test(k)) {
    return typeof v === "string" ? uidPrefix(v) : "[REDACTED]";
  }
  if (/^(uin|appid|app_id|dealname|deal_name|resourceid|resource_id|payeruin|payer_uin)$/.test(k)) {
    return typeof v === "string" ? uidPrefix(v) : "[REDACTED]";
  }
  if (/(phone|mobile|email|mail|idcard|id_card)/.test(k)) return "[REDACTED]";
  if (k === "accountattributes" && Array.isArray(v)) {
    return v.map((x) => ({
      Key: x?.Key,
      Type: x?.Type,
      Value: "[REDACTED]",
    }));
  }
  if (Array.isArray(v)) return v.slice(0, 5).map((x) => sanitizeDeep(x, key));
  if (v && typeof v === "object") {
    const o = {};
    for (const [kk, vv] of Object.entries(v)) o[kk] = sanitizeDeep(vv, kk);
    return o;
  }
  if (typeof v === "string" && v.length > 500) return v.slice(0, 500) + "…";
  return v;
}

function summarizeEnvelope(env, rawLen) {
  if (!env || typeof env !== "object") return { parse: "failed", rawLength: rawLen };
  const data = env.data;
  return {
    rawLength: rawLen,
    envelopeKeys: objKeys(env),
    code: env.code,
    msg: env.msg,
    hasRequestId: typeof env.requestId === "string",
    dataType: Array.isArray(data) ? "array" : data === null ? "null" : typeof data,
    dataKeys: objKeys(data),
  };
}

function summarizeDataShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { type: Array.isArray(data) ? "array" : typeof data };
  }
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (Array.isArray(v)) {
      out[k] = { type: "array", length: v.length };
    } else if (v && typeof v === "object") {
      out[k] = { type: "object", keys: Object.keys(v).slice(0, 40) };
    } else {
      out[k] = { type: v === null ? "null" : typeof v };
    }
  }
  return out;
}

async function runConfig(a) {
  const started = Date.now();
  const r = await fetchJSON(chatBase(a) + "/v3/config", v3Headers(a), { method: "GET" });
  const env = parseJSON(r.raw);
  const data = env?.data;
  const models = Array.isArray(data?.models) ? data.models : [];
  const promotions = Array.isArray(data?.modelPromotions) ? data.modelPromotions : [];
  const banners =
    data?.productFeaturesConfig?.ModelTrialBanner?.banners ??
    env?.ProductFeaturesConfig?.ModelTrialBanner?.banners ??
    [];
  return {
    endpoint: "GET /v3/config",
    url: chatBase(a) + "/v3/config",
    http: {
      status: r.status,
      contentType: r.contentType,
      elapsedMs: r.elapsedMs,
      requestIDPresent: !!r.requestID,
    },
    envelope: summarizeEnvelope(env, r.raw.length),
    counts: {
      models: models.length,
      modelPromotions: promotions.length,
      trialBanners: Array.isArray(banners) ? banners.length : 0,
    },
    modelIds: models.map((m) => m?.id).filter(Boolean),
    models,
    modelFieldStats: fieldStats(models),
    modelPromotions: promotions,
    promotionFieldStats: fieldStats(promotions),
    productFeaturesConfig: data?.productFeaturesConfig ?? null,
    dataKeys: objKeys(data),
    dataShape: summarizeDataShape(data),
    startedAt: new Date(started).toISOString(),
  };
}

async function runModels(a) {
  const started = Date.now();
  const path = "/console/enterprises/personal/models";
  const r = await fetchJSON(chatBase(a) + path, {
    ...commonHeaders(a),
    Authorization: "Bearer " + a.accessToken,
  }, { method: "GET" });
  const env = parseJSON(r.raw);
  const data = env?.data;
  const models = Array.isArray(data?.models) ? data.models : [];
  const agents = Array.isArray(data?.agents) ? data.agents : [];
  const cli = agents.find((x) => x?.name === "cli");
  const cliModels = Array.isArray(cli?.models) ? cli.models : [];
  return {
    endpoint: "GET " + path,
    url: chatBase(a) + path,
    http: {
      status: r.status,
      contentType: r.contentType,
      elapsedMs: r.elapsedMs,
      requestIDPresent: !!r.requestID,
    },
    envelope: summarizeEnvelope(env, r.raw.length),
    counts: {
      models: models.length,
      agents: agents.length,
      cliModels: cliModels.length,
    },
    agentNames: agents.map((x) => x?.name).filter(Boolean),
    cliModels,
    modelIds: models.map((m) => m?.id).filter(Boolean),
    models,
    modelFieldStats: fieldStats(models),
    dataKeys: objKeys(data),
    startedAt: new Date(started).toISOString(),
  };
}

async function runChat(a) {
  const started = Date.now();
  const messageID = createHash("sha256").update(`dump:${started}:${Math.random()}`).digest("hex").slice(0, 32);
  const convReqID = createHash("sha256").update(`dump:req:${started}:${Math.random()}`).digest("hex").slice(0, 32);
  const meta = {
    conversationID: "dump-" + started,
    conversationRequestID: convReqID,
    messageID,
    traceID: convReqID,
  };
  const body = JSON.stringify({
    model: modelArg,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 32,
  });
  const resp = await fetch(chatBase(a) + "/v2/chat/completions", {
    method: "POST",
    headers: chatHeaders(a, meta),
    body,
    signal: AbortSignal.timeout(90_000),
  });
  const respHeaders = {};
  for (const [k, v] of resp.headers.entries()) {
    respHeaders[k] = /set-cookie|authorization|x-user-id|x-trace-id|x-request-id/i.test(k) ? "[REDACTED]" : v;
  }
  if (!resp.ok) {
    const raw = await resp.text();
    return {
      endpoint: "POST /v2/chat/completions",
      url: chatBase(a) + "/v2/chat/completions",
      model: modelArg,
      http: { status: resp.status, elapsedMs: Date.now() - started },
      responseHeaders: respHeaders,
      errorBody: sanitizeDeep(parseJSON(raw) ?? raw),
    };
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const frames = [];
  let bytes = 0;
  let doneSeen = false;
  const t0 = Date.now();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        doneSeen = true;
        continue;
      }
      const obj = parseJSON(payload);
      frames.push({
        atMs: Date.now() - t0,
        parsed: obj ? sanitizeDeep(obj) : payload.slice(0, 500),
        keys: objKeys(obj),
        choicesType: Array.isArray(obj?.choices) ? "array" : typeof obj?.choices,
        deltaKeys: objKeys(obj?.choices?.[0]?.delta),
        finishReason: obj?.choices?.[0]?.finish_reason ?? null,
        usage: obj?.usage ?? null,
      });
    }
  }
  const first = frames.slice(0, 10);
  const last = frames.length > 10 ? frames.slice(-10) : [];
  return {
    endpoint: "POST /v2/chat/completions",
    url: chatBase(a) + "/v2/chat/completions",
    model: modelArg,
    http: {
      status: resp.status,
      elapsedMs: Date.now() - started,
      streamBytes: bytes,
      streamMs: Date.now() - t0,
    },
    responseHeaders: respHeaders,
    requestBodyShape: JSON.parse(body),
    counts: {
      dataFrames: frames.length,
      doneSeen,
      reasoningFrames: frames.filter((f) => f.deltaKeys.includes("reasoning_content") || f.deltaKeys.includes("reasoning")).length,
      contentFrames: frames.filter((f) => f.deltaKeys.includes("content")).length,
    },
    firstFrames: first,
    lastFrames: last,
    lastUsage: [...frames].reverse().find((f) => f.usage)?.usage ?? null,
  };
}

async function runBilling(a) {
  const started = Date.now();
  const now = new Date();
  const end = new Date(now.getTime() + 101 * 365 * 24 * 3600_000);
  const fmt = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} 00:00:00`;
  const body = {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: "p_tcaca",
    Status: [0, 3],
    PackageEndTimeRangeBegin: fmt(now),
    PackageEndTimeRangeEnd: fmt(end),
  };
  const path = a.realm === "global" ? "/billing/meter/get-user-resource" : "/v2/billing/meter/get-user-resource";
  const r = await fetchJSON(billingBase(a) + path, billingHeaders(a), {
    method: "POST",
    body: JSON.stringify(body),
  });
  const env = parseJSON(r.raw);
  const accounts = env?.data?.Response?.Data?.Accounts;
  return {
    endpoint: "POST " + path,
    url: billingBase(a) + path,
    http: {
      status: r.status,
      contentType: r.contentType,
      elapsedMs: r.elapsedMs,
    },
    requestBody: body,
    envelope: summarizeEnvelope(env, r.raw.length),
    counts: {
      accounts: Array.isArray(accounts) ? accounts.length : 0,
    },
    responseKeys: objKeys(env?.data?.Response),
    dataKeys: objKeys(env?.data?.Response?.Data),
    accountKeys: Array.isArray(accounts) && accounts[0] ? Object.keys(accounts[0]) : [],
    accountSample: Array.isArray(accounts) && accounts[0] ? sanitizeDeep(accounts[0]) : null,
    accountSamples: Array.isArray(accounts) ? accounts.slice(0, 3).map((x) => sanitizeDeep(x)) : [],
    startedAt: new Date(started).toISOString(),
  };
}

async function main() {
  const accounts = await prisma.account.findMany({
    where: { realm, accessToken: { not: "" } },
    include: { state: true },
  });
  const usable = accounts
    .filter((x) => x.state && !x.state.disabled && !x.state.paused)
    .sort((a, b) => Number((b.state?.credits ?? 0n) - (a.state?.credits ?? 0n)));
  if (usable.length === 0) {
    console.log(JSON.stringify({
      realm,
      accounts: accounts.length,
      usable: 0,
      note: `没有可用的 ${realm} 账号，未做登录态探测`,
    }, null, 2));
    return;
  }
  const acct = usable[0];
  const a = {
    uid: acct.uid,
    nickname: acct.nickname,
    realm: acct.realm,
    accessToken: acct.accessToken,
    refreshToken: acct.refreshToken,
    expiresAt: Number(acct.expiresAt),
    domain: acct.domain,
    enterpriseId: acct.enterpriseId,
    deviceToken: acct.deviceToken,
  };

  const out = {
    generatedAt: new Date().toISOString(),
    realm,
    endpoint,
    account: {
      uidPrefix: uidPrefix(a.uid),
      nicknamePresent: !!a.nickname,
      realm: a.realm,
      hasEnterpriseId: !!a.enterpriseId,
      hasDomain: !!a.domain,
      hasDeviceToken: !!a.deviceToken,
      credits: acct.state?.credits?.toString?.() ?? String(acct.state?.credits ?? 0),
      total: acct.state?.total?.toString?.() ?? String(acct.state?.total ?? 0),
    },
    dbAccountCounts: {
      realmTotal: accounts.length,
      usable: usable.length,
    },
  };

  if (want("config")) out.config = await runConfig(a);
  if (want("models")) out.models = await runModels(a);
  if (want("chat")) out.chat = await runChat(a);
  if (want("billing")) out.billing = await runBilling(a);

  if (out.config && out.models) {
    const aIds = new Set(out.config.modelIds || []);
    const bIds = new Set(out.models.modelIds || []);
    const cliIds = new Set(out.models.cliModels || []);
    out.diff = {
      v3Only: [...aIds].filter((x) => !bIds.has(x)),
      enterpriseModelsOnly: [...bIds].filter((x) => !aIds.has(x)),
      cliOnly: [...cliIds].filter((x) => !aIds.has(x)),
      v3NotInCli: [...aIds].filter((x) => !cliIds.has(x)),
    };
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(outFile, JSON.stringify(out, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({
    outFile,
    account: out.account,
    sections: Object.keys(out).filter((k) => !["generatedAt", "account", "dbAccountCounts", "realm", "endpoint"].includes(k)),
    config: out.config ? {
      status: out.config.http.status,
      counts: out.config.counts,
      modelIds: out.config.modelIds,
    } : undefined,
    models: out.models ? {
      status: out.models.http.status,
      counts: out.models.counts,
      agentNames: out.models.agentNames,
      modelIds: out.models.modelIds,
      cliModels: out.models.cliModels,
    } : undefined,
    diff: out.diff,
    chat: out.chat ? {
      status: out.chat.http.status,
      counts: out.chat.counts,
      lastUsage: out.chat.lastUsage,
      errorBody: out.chat.errorBody,
    } : undefined,
    billing: out.billing ? {
      status: out.billing.http.status,
      counts: out.billing.counts,
      responseKeys: out.billing.responseKeys,
      dataKeys: out.billing.dataKeys,
      accountKeys: out.billing.accountKeys,
    } : undefined,
  }, null, 2));
}

try {
  await main();
} catch (e) {
  console.error("dump failed:", e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
