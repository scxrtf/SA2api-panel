// 全账号模型可用性扫描（面板「扫描模型限流」）。
// 逐账号拉取该账号可见的模型目录，再对每个模型发一次最小流式请求，
// 把 429 / 6004 / 11102 等限流与不可用结果扫出来并落进账号池处置
// （6004 → 模型级冷却、11102 → 模型负缓存、429 → 账号级冷却）。
//
// 扫描在进程内后台执行，状态挂在 globalThis 上供 GET 轮询；服务重启即丢失，
// 与 modeltest / runlog 的单实例语义一致。
import { randomUUID } from "crypto";
import { prisma } from "./db";
import { getConfig, type AppConfig } from "./config";
import { authShapeOf } from "./login";
import { chatStream } from "./upstream/client";
import { fetchGlobalModelInfos, fetchModelsFull } from "./upstream/modelCatalog";
import { classify, isModelRateLimit, isQueueWait, type ErrKind } from "./upstream/errors";
import * as pool from "./pool";
import { runlog } from "./runlog";
import { label } from "./logfmt";

// 每个模型最多等 20s；扫描总并发按账号计（同一账号内串行，避免自己打出 429）。
const PROBE_TIMEOUT_MS = 20_000;
const FRAME_WAIT_MS = 5_000;
const ACCOUNT_CONCURRENCY = 2;
const STALE_MS = 15 * 60_000;

type ProbeKind = ErrKind | "timeout" | "transport";

export interface ScanIssue {
  uid: string;
  nickname: string;
  realm: string;
  model: string;
  full_model: string;
  status: number;
  kind: string;
  code: string;
  label: string;
  message: string;
  at: number;
}

export interface ModelScanSnapshot {
  id: string;
  running: boolean;
  status: "running" | "done" | "cancelled" | "error";
  started_at: number;
  updated_at: number;
  finished_at: number;
  accounts_total: number;
  accounts_done: number;
  total: number;
  done: number;
  ok: number;
  bad: number;
  skipped: number;
  skipped_accounts: number;
  current: string;
  issues: ScanIssue[];
  error: string;
}

export interface ScanJob extends ModelScanSnapshot {
  ctrl: AbortController;
}

interface AccountJob {
  uid: string;
  nickname: string;
  realm: string;
  shape: ReturnType<typeof authShapeOf>;
  models: string[];
}

interface ProbeResult {
  status: number;
  kind: ProbeKind;
  body: string;
  retryAfterMs: number;
  cancelled: boolean;
}

const g = globalThis as unknown as { __wbModelScanJob?: ScanJob };

export function beginModelScan(): ScanJob | null {
  const prev = g.__wbModelScanJob;
  if (prev?.running) return null;
  const now = Date.now();
  const job: ScanJob = {
    id: randomUUID(),
    running: true,
    status: "running",
    started_at: now,
    updated_at: now,
    finished_at: 0,
    accounts_total: 0,
    accounts_done: 0,
    total: 0,
    done: 0,
    ok: 0,
    bad: 0,
    skipped: 0,
    skipped_accounts: 0,
    current: "读取账号与模型目录…",
    issues: [],
    error: "",
    ctrl: new AbortController(),
  };
  g.__wbModelScanJob = job;
  return job;
}

export function getModelScanSnapshot(): ModelScanSnapshot | null {
  const s = g.__wbModelScanJob;
  if (!s) return null;
  // 进程被杀/请求被平台中断时 running 会永久挂住；超过 15 分钟无更新视为停顿。
  if (s.running && Date.now() - s.updated_at > STALE_MS) {
    s.running = false;
    s.status = "error";
    s.error = "扫描已停顿超过 15 分钟（进程可能已重启）";
    s.finished_at = Date.now();
  }
  return {
    id: s.id,
    running: s.running,
    status: s.status,
    started_at: s.started_at,
    updated_at: s.updated_at,
    finished_at: s.finished_at,
    accounts_total: s.accounts_total,
    accounts_done: s.accounts_done,
    total: s.total,
    done: s.done,
    ok: s.ok,
    bad: s.bad,
    skipped: s.skipped,
    skipped_accounts: s.skipped_accounts,
    current: s.current,
    issues: s.issues.slice(),
    error: s.error,
  };
}

export function cancelModelScan(): boolean {
  const s = g.__wbModelScanJob;
  if (!s?.running) return false;
  s.ctrl.abort();
  return true;
}

// runModelScan 后台执行扫描；路由层通过 after() 保证响应返回后继续跑。
export async function runModelScan(job: ScanJob): Promise<void> {
  try {
    const cfg = await getConfig();
    const accounts = await prisma.account.findMany({
      include: { state: true, modelCooldowns: true },
      orderBy: { createdAt: "asc" },
    });
    job.accounts_total = accounts.length;

    const now = Date.now();
    const candidates: typeof accounts = [];
    for (const a of accounts) {
      if (job.ctrl.signal.aborted) break;
      if (a.accessToken === "") { job.accounts_done++; job.skipped_accounts++; continue; }
      if (a.state?.disabled) { job.accounts_done++; job.skipped_accounts++; continue; }
      if (Number(a.state?.cooldownUntil ?? 0) > now) {
        job.accounts_done++;
        job.skipped_accounts++;
        continue;
      }
      candidates.push(a);
    }

    // 先并发生成每个账号自己的模型目录（企业号目录可能不同），再统一扫描。
    const jobs: AccountJob[] = [];
    await mapLimit(candidates, ACCOUNT_CONCURRENCY, async (a) => {
      if (job.ctrl.signal.aborted) return;
      const realm = a.realm === "global" ? "global" : "cn";
      job.current = "读取目录 · " + (a.nickname || a.uid);
      job.updated_at = Date.now();
      try {
        const shape = authShapeOf(a);
        let models: string[];
        if (realm === "global") {
          const r = await fetchGlobalModelInfos(cfg, shape);
          models = r.names;
        } else {
          const infos = await fetchModelsFull(cfg, shape);
          models = infos.map((m) => m.id);
        }
        models = [...new Set(models.filter(Boolean))];
        if (models.length === 0) throw new Error("模型目录为空");

        const locks = new Map<string, number>();
        for (const c of a.modelCooldowns) locks.set(c.model, Number(c.until));
        const todo = models.filter((m) => {
          const until = locks.get(m) ?? 0;
          if (until > now) { job.skipped++; return false; }
          return true;
        });
        if (todo.length === 0) { job.accounts_done++; return; }
        job.total += todo.length;
        jobs.push({
          uid: a.uid,
          nickname: a.nickname,
          realm,
          shape,
          models: todo,
        });
      } catch (e) {
        job.accounts_done++;
        job.skipped_accounts++;
        job.bad++;
        const msg = e instanceof Error ? e.message : String(e);
        addIssue(job, {
          uid: a.uid, nickname: a.nickname, realm,
          model: "*", full_model: realm + ":*", status: 0,
          kind: "catalog", code: "catalog", label: "目录获取失败",
          message: msg,
        });
      }
      job.updated_at = Date.now();
    });

    if (job.ctrl.signal.aborted) {
      finish(job, "cancelled");
      return;
    }

    // 扫描阶段：账号之间并发，账号内逐个模型串行。
    job.current = "开始扫描…";
    job.updated_at = Date.now();
    await mapLimit(jobs, ACCOUNT_CONCURRENCY, async (acc) => {
      for (let i = 0; i < acc.models.length; i++) {
        if (job.ctrl.signal.aborted) return;
        const model = acc.models[i];
        job.current = (acc.nickname || acc.uid) + " · " + model;
        job.updated_at = Date.now();

        const r = await probeModel(cfg, acc.shape, model, job.ctrl.signal);
        if (r.cancelled) {
          const rest = acc.models.length - i;
          job.done += rest;
          job.skipped += rest;
          return;
        }
        job.done++;
        job.updated_at = Date.now();

        if (r.kind === "none" && r.status === 200) {
          job.ok++;
          await pool.blockModelClear(acc.uid, model);
          continue;
        }

        job.bad++;
        const meta = codeOf(r);
        addIssue(job, {
          uid: acc.uid, nickname: acc.nickname, realm: acc.realm,
          model, full_model: acc.realm + ":" + model,
          status: r.status, kind: r.kind, code: meta.code,
          label: meta.label, message: r.body,
        });
        runlog(
          "modelscan " + label(acc.uid, acc.nickname) + " · " + model + ": " +
          meta.label + " (http " + r.status + ")",
        );
        await applyOutcome(cfg, acc.uid, model, r);

        if (stopAccount(r)) {
          const rest = acc.models.length - i - 1;
          job.done += rest;
          job.skipped += rest;
          break;
        }
        await sleep(120);
      }
      job.accounts_done++;
      job.updated_at = Date.now();
    });

    finish(job, job.ctrl.signal.aborted ? "cancelled" : "done");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    job.error = msg;
    runlog("modelscan error: " + msg);
    finish(job, "error");
  } finally {
    job.ctrl.abort();
  }
}

function finish(job: ScanJob, status: "done" | "cancelled" | "error"): void {
  job.running = false;
  job.status = status;
  job.finished_at = Date.now();
  job.updated_at = job.finished_at;
  if (status === "done") {
    job.current = "";
    runlog(
      "modelscan 完成: " + job.ok + " 可用 / " + job.bad + " 异常 · " +
      "账号 " + job.accounts_done + "/" + job.accounts_total,
    );
  } else if (status === "cancelled") {
    job.current = "";
    runlog("modelscan 已取消: " + job.done + "/" + job.total);
  }
}

function addIssue(job: ScanJob, i: Omit<ScanIssue, "at">): void {
  // 上游 body 可能很长；只保留足够定位的片段，避免轮询快照过大。
  job.issues.push({
    ...i,
    message: i.message.slice(0, 400),
    at: Date.now(),
  });
}

// codeOf 把一次探测结果映射成面板可筛选的短码。
function codeOf(r: ProbeResult): { code: string; label: string } {
  if (isQueueWait(r.body) || r.kind === "soft_queue") {
    return { code: "6020", label: "6020 队列等待" };
  }
  if (isModelRateLimit(r.body)) return { code: "6004", label: "6004 模型限流" };
  if (r.status === 429) return { code: "429", label: "429 账号限流" };
  if (r.kind === "model_blocked") return { code: "11102", label: "11102 模型不可用" };
  switch (r.kind) {
    case "hard_credit": return { code: "402", label: "积分耗尽" };
    case "session_dead": return { code: "12153", label: "会话失效" };
    case "account_fault": return { code: "fault", label: "账号级故障" };
    case "waf_block": return { code: "waf", label: "WAF 拦截" };
    case "timeout": return { code: "timeout", label: "请求超时" };
    case "transport": return { code: "transport", label: "网络错误" };
    case "soft_rate": return { code: "rate", label: "上游限流" };
    case "server": return { code: "5xx", label: "上游 HTTP " + r.status };
    default:
      return {
        code: "error",
        label: r.status > 0 ? "HTTP " + r.status : "请求失败",
      };
  }
}

// stopAccount 账号级问题出现后不再继续扫该号剩余模型（继续打只会重复失败）。
function stopAccount(r: ProbeResult): boolean {
  // 队列等待时继续扫剩余模型只会把排队放大；本模型已落短冷却，先停本号。
  if (r.kind === "soft_queue") return true;
  if (r.kind === "soft_rate" && !isModelRateLimit(r.body)) return true;
  return (
    r.kind === "hard_credit" ||
    r.kind === "session_dead" ||
    r.kind === "account_fault" ||
    r.kind === "waf_block"
  );
}

// applyOutcome 与网关请求同口径落库，让模型锁池/账号状态立即可见。
async function applyOutcome(cfg: AppConfig, uid: string, model: string, r: ProbeResult): Promise<void> {
  switch (r.kind) {
    case "soft_rate":
    case "soft_queue":
    case "hard_credit":
    case "model_blocked":
    case "session_dead":
    case "account_fault":
    case "waf_block":
      await pool.applyErrorKind(cfg, uid, r.kind, r.body || r.kind, model, r.retryAfterMs);
      return;
    default:
      return;
  }
}

// probeModel 发一次最小请求；只读到首个有效帧/错误帧就取消，避免真实生成整段文本。
async function probeModel(
  cfg: AppConfig,
  shape: ReturnType<typeof authShapeOf>,
  model: string,
  scanSignal: AbortSignal,
): Promise<ProbeResult> {
  if (scanSignal.aborted) return cancelled();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("probe timeout", "TimeoutError")), PROBE_TIMEOUT_MS);
  const onCancel = () => ctrl.abort(new DOMException("scan cancelled", "AbortError"));
  scanSignal.addEventListener("abort", onCancel, { once: true });
  try {
    const res = await chatStream(
      cfg, shape,
      JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        stream: true,
        max_tokens: 8,
      }),
      "",
      {
        conversationID: "modelscan-" + randomUUID(),
        conversationRequestID: "modelscan:" + randomUUID(),
        traceID: "modelscan:" + randomUUID(),
      },
      ctrl.signal,
    );
    if (scanSignal.aborted) return cancelled();
    if (!res.ok || !res.body) {
      const body = res.respBody ?? "";
      let kind: ProbeKind = res.error?.kind ?? classify(res.status, body);
      // 6004 也可能以 HTTP 400 原文返回（classify 只认 429 兜底），显式归到模型限流。
      if (isModelRateLimit(body)) kind = "soft_rate";
      if (isQueueWait(body)) kind = "soft_queue";
      if (res.status >= 400 && kind === "none") kind = "client";
      return {
        status: res.status, kind, body,
        retryAfterMs: res.error?.retryAfterMs ?? 0, cancelled: false,
      };
    }
    const frame = await readProbeFrame(res.body, ctrl.signal);
    if (scanSignal.aborted) return cancelled();
    if (frame.kind === "none") {
      return { status: 200, kind: "none", body: "", retryAfterMs: 0, cancelled: false };
    }
    return { status: 200, kind: frame.kind, body: frame.body, retryAfterMs: 0, cancelled: false };
  } catch (e) {
    if (scanSignal.aborted) return cancelled();
    const timeout = e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError");
    return {
      status: 0,
      kind: timeout ? "timeout" : "transport",
      body: e instanceof Error ? e.message : String(e),
      retryAfterMs: 0,
      cancelled: false,
    };
  } finally {
    clearTimeout(timer);
    scanSignal.removeEventListener("abort", onCancel);
    ctrl.abort();
  }
}

function cancelled(): ProbeResult {
  return { status: 0, kind: "transport", body: "", retryAfterMs: 0, cancelled: true };
}

// readProbeFrame 只等首个有效帧：error/6004 → 返回错误；choices → 视为成功；
// 5s 内没有帧也按成功处理（思考型模型首帧可能较慢，且此类模型极少返回 6004）。
async function readProbeFrame(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<{ kind: ProbeKind; body: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException("probe timeout", "TimeoutError");
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const wait = new Promise<"wait">((resolve) => {
        waitTimer = setTimeout(() => resolve("wait"), FRAME_WAIT_MS);
      });
      const got = await Promise.race([reader.read(), wait]);
      if (waitTimer) clearTimeout(waitTimer);
      if (got === "wait") return { kind: "none", body: "" };
      if (got.done) {
        // 非 SSE 响应（上游忽略 stream 时返回整段 JSON）也要判一次，避免漏掉 6004/error。
        buf += decoder.decode();
        const end = frameResult(buf);
        return { kind: end.kind, body: end.body };
      }
      buf += decoder.decode(got.value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) {
          if (line.startsWith("{")) return frameResult(line);
          continue;
        }
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        const r = frameResult(data);
        if (r.done) return { kind: r.kind, body: r.body };
      }
    }
  } finally {
    try { await reader.cancel(); } catch { /* 已关闭 */ }
    try { reader.releaseLock(); } catch { /* 有未决读取时释放会抛，忽略 */ }
  }
}

// frameResult 解析一帧：6004/error/code → 错误；choices → 成功；其他帧 done=false 继续读。
function frameResult(data: string): { kind: ProbeKind; body: string; done: boolean } {
  if (isModelRateLimit(data)) return { kind: "soft_rate", body: data, done: true };
  const obj = parseShallow(data);
  if (!obj) return { kind: "none", body: "", done: false };
  const hasCode = typeof obj.code === "number" && obj.code !== 0;
  if (obj.error || hasCode) {
    const k = classify(400, data);
    return { kind: k === "none" ? "client" : k, body: data, done: true };
  }
  if (Array.isArray(obj.choices) && obj.choices.length > 0) {
    return { kind: "none", body: "", done: true };
  }
  return { kind: "none", body: "", done: false };
}

function parseShallow(data: string): { error?: unknown; code?: unknown; choices?: unknown[] } | null {
  try {
    return JSON.parse(data) as { error?: unknown; code?: unknown; choices?: unknown[] };
  } catch {
    return null;
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
