// GET /api/panel/packages — 全部账号积分包构成（并发上限 3；单号失败不拖垮整页）。
//
// 取数走 withFreshAuth：token 临近过期先刷、401 刷一次重试，避免「DB 快照过期 →
// 上游 401 → 面板显示 0/0」的假象。失败行带 ok=false + reason，前端据此展示
// 「取数失败」而不是 0，并把上游 HTML 401 归一成单行文案。
import { panelAuth, ok } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { creditPackages, type AuthShape } from "@/lib/upstream/client";
import {
  classifySessionError,
  sanitizeUpstreamMessage,
  withFreshAuth,
  type SessionFailReason,
} from "@/lib/accountSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const cfg = await getConfig();
  const accounts = await prisma.account.findMany({ orderBy: { createdAt: "asc" } });

  type Row = {
    uid: string; nickname: string; realm: string;
    remain: number; size: number;
    packages: unknown[];
    ok: boolean;
    reason?: SessionFailReason;
    error?: string;
  };
  const out: Row[] = new Array(accounts.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= accounts.length) return;
      const a = accounts[i];
      const row: Row = {
        uid: a.uid, nickname: a.nickname, realm: a.realm,
        remain: 0, size: 0, packages: [], ok: false,
      };
      if (!a.accessToken) {
        row.reason = "session_dead";
        row.error = "账号未登录（无 access token），需重新登录";
      } else {
        const shape: AuthShape = {
          uid: a.uid, nickname: a.nickname, realm: a.realm,
          accessToken: a.accessToken, refreshToken: a.refreshToken,
          expiresAt: Number(a.expiresAt), domain: a.domain,
          enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
        };
        try {
          const r = await withFreshAuth(cfg, shape, (s) => creditPackages(cfg, s));
          row.packages = r.packages;
          row.remain = r.remain;
          row.size = r.size;
          row.ok = true;
        } catch (e) {
          row.reason = classifySessionError(e);
          row.error =
            sanitizeUpstreamMessage(e instanceof Error ? e.message : String(e)) ||
            "上游返回空错误";
        }
      }
      out[i] = row;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  // 取数成功的按余额降序在前；失败行沉底（仍可见，不静默吞掉）。
  out.sort((x, y) => {
    if (x.ok !== y.ok) return x.ok ? -1 : 1;
    return y.remain - x.remain;
  });
  const failed = out.filter((r) => !r.ok).length;
  return ok({
    accounts: out,
    detail_limit: cfg.package_detail_limit,
    failed,
    total: out.length,
  });
}
