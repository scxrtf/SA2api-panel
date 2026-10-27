// 面板取数的账号会话自愈层。
//
// 背景：面板各视图直接拿 DB 里的 accessToken 快照调上游，而该快照会早于上游失效
// （上游 28 天轮换一次；保活任务未跑、或别处已刷新但本进程读到旧行时都会落后）。
// 上游对失效 token 的答复是网关层 HTML 401（openresty/APISIX），不是业务信封，
// 调用方既不能靠 classify 判出「会话失效」，也会把这坨 HTML 原样铺到 UI 上。
//
// 本模块做三件事：
//   1. 取数前按 refresh_skew_sec 预刷新；遇到 401 再刷新一次重试（一次为限）。
//   2. 同一 uid 的刷新做单飞（single-flight），避免并发刷新重复消费 refresh token。
//   3. 把上游错误归一成可直接展示的文案 + 稳定原因码（session_dead / auth_rejected /
//      upstream_error），面板据此区分「真的 0」与「取不到数」。
import { prisma } from "./db";
import type { AppConfig } from "./config";
import { needsRefresh, refreshToken, type AuthShape } from "./upstream/client";
import { UpstreamError } from "./upstream/errors";

// SessionFailReason 面板取数失败的稳定原因码（前端据此选文案，不解析原文）。
export type SessionFailReason = "session_dead" | "auth_rejected" | "upstream_error";

// reHtmlLike 判定上游答复是否为网关 HTML 页（APISIX/openresty 401/403 的典型形态）。
const reHtmlLike = /<\s*(?:html|head|body|center|!doctype)\b/i;
const reTitle = /<\s*title\s*>([\s\S]*?)<\s*\/\s*title\s*>/i;

// sanitizeUpstreamMessage 把上游错误归一成单行可读文案。
// HTML 形态只保留 <title>（「401 Authorization Required」）并剥标签、收空白；
// 纯文案形态原样收敛空白。超长截断——UI 只展示摘要，完整定位靠运行日志。
export function sanitizeUpstreamMessage(raw: string, limit = 200): string {
  if (!raw) return "";
  let s = raw;
  if (reHtmlLike.test(s)) {
    const title = (reTitle.exec(s)?.[1] ?? "").replace(/<[^>]*>/g, " ").trim();
    const text = s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ");
    // 网关页里 title / h1 / body 常是同一句话：按词去重，只留一份可读摘要。
    const seen = new Set<string>();
    const words = (title + " " + text)
      .split(/\s+/)
      .filter((w) => {
        if (!w) return false;
        const k = w.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    s = words.join(" ");
  }
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= limit) return s;
  return s.slice(0, limit - 1) + "…";
}

// classifySessionError 判失败原因：12153/refresh 失效 → session_dead（需重登）；
// 401 无业务信封（网关 HTML）→ auth_rejected（可能需重登）；其余归 upstream_error。
export function classifySessionError(e: unknown): SessionFailReason {
  if (e instanceof UpstreamError) {
    if (e.kind === "session_dead") return "session_dead";
    if (e.status === 401) return "auth_rejected";
    return "upstream_error";
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("12153") || msg.includes("refresh_failed")) return "session_dead";
  return "upstream_error";
}

// isRefreshableAuthFailure 只有「换新 token 可能救回」的失败才值得刷新重试；
// 网关 HTML 401 与 12153 都算（DB 快照落后于上游时刷新有效）。
function isRefreshableAuthFailure(e: unknown): boolean {
  if (e instanceof UpstreamError) {
    if (e.kind === "session_dead") return true;
    return e.status === 401;
  }
  return false;
}

// 单飞表：同 uid 并发刷新共用一次上游调用，避免 refresh token 被重复消费。
const inFlightRefresh = new Map<string, Promise<AuthShape>>();

// SESSION_DEAD_TTL_MS 会话已死的负缓存窗口。积分构成页 60s 轮询 + 多视图并发，
// 死号如果每次都走一次「401 → 刷新 → 12153」，24 个死号就是每分钟 24 次无效
// 上游调用（还可能触发风控）。TTL 内的结论直接复用；重新登录成功后自然清空。
const SESSION_DEAD_TTL_MS = 5 * 60_000;
const deadUntil = new Map<string, number>();

function deadCached(uid: string): boolean {
  const until = deadUntil.get(uid) ?? 0;
  if (until === 0) return false;
  if (Date.now() >= until) {
    deadUntil.delete(uid);
    return false;
  }
  return true;
}

// refreshShared 刷新并落库；失败向上抛（12153 会带 session_dead 语义）。
async function refreshShared(cfg: AppConfig, a: AuthShape): Promise<AuthShape> {
  const running = inFlightRefresh.get(a.uid);
  if (running) return running;
  const job = (async (): Promise<AuthShape> => {
    const patch = await refreshToken(cfg, a);
    await prisma.account.update({
      where: { uid: a.uid },
      data: {
        accessToken: patch.accessToken ?? a.accessToken,
        refreshToken: patch.refreshToken ?? a.refreshToken,
        domain: patch.domain ?? a.domain,
        ...(patch.expiresAt && patch.expiresAt > 0 ? { expiresAt: BigInt(patch.expiresAt) } : {}),
      },
    });
    return {
      ...a,
      accessToken: patch.accessToken ?? a.accessToken,
      refreshToken: patch.refreshToken ?? a.refreshToken,
      domain: patch.domain ?? a.domain,
      expiresAt: patch.expiresAt && patch.expiresAt > 0 ? patch.expiresAt : a.expiresAt,
    };
  })();
  inFlightRefresh.set(a.uid, job);
  try {
    return await job;
  } finally {
    inFlightRefresh.delete(a.uid);
  }
}

// latestShape 取 DB 最新凭证覆盖快照（并发刷新后旧快照的 refresh token 已作废）。
async function latestShape(a: AuthShape): Promise<AuthShape> {
  const row = await prisma.account.findUnique({
    where: { uid: a.uid },
    select: { accessToken: true, refreshToken: true, domain: true, expiresAt: true },
  });
  if (!row) return a;
  return {
    ...a,
    accessToken: row.accessToken || a.accessToken,
    refreshToken: row.refreshToken || a.refreshToken,
    domain: row.domain || a.domain,
    expiresAt: Number(row.expiresAt) || a.expiresAt,
  };
}

// withFreshAuth 带会话自愈地调用上游：临近过期先刷新；401 时刷新后重试一次。
// 返回最终生效的凭证快照（调用方如需二次调用可复用，避免再次读旧 token）。
export async function withFreshAuth<T>(
  cfg: AppConfig,
  a: AuthShape,
  call: (auth: AuthShape) => Promise<T>,
): Promise<T> {
  // 负缓存命中：同一死号在 TTL 内直接给出结论，不重复打上游。
  if (deadCached(a.uid)) {
    throw new UpstreamError(
      "session_dead",
      401,
      "会话已失效（" + SESSION_DEAD_TTL_MS / 60_000 + " 分钟内不重复请求上游），需重新登录",
    );
  }
  try {
    const value = await runWithRefresh(cfg, a, call);
    deadUntil.delete(a.uid); // 恢复正常即清负缓存
    return value;
  } catch (e) {
    if (classifySessionError(e) === "session_dead") {
      deadUntil.set(a.uid, Date.now() + SESSION_DEAD_TTL_MS);
    }
    throw e;
  }
}

async function runWithRefresh<T>(
  cfg: AppConfig,
  a: AuthShape,
  call: (auth: AuthShape) => Promise<T>,
): Promise<T> {
  let cur = a;
  let refreshed = false;

  if (cur.refreshToken && needsRefresh(cur, cfg.refresh_skew_sec)) {
    cur = await refreshShared(cfg, cur);
    refreshed = true;
  }

  try {
    return await call(cur);
  } catch (e) {
    // 已经刷过、没有 refresh token、或失败与鉴权无关 → 原样抛给调用方归类。
    if (refreshed || !cur.refreshToken || !isRefreshableAuthFailure(e)) throw e;
    cur = await refreshShared(cfg, await latestShape(cur));
    return await call(cur);
  }
}
