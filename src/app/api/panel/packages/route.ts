// GET /api/panel/packages — 全部账号积分包构成（并发上限 3；单号失败不拖垮整页）。
import { panelAuth, ok } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { creditPackages, type AuthShape } from "@/lib/upstream/client";

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
        remain: 0, size: 0, packages: [],
      };
      if (!a.accessToken) {
        row.error = "account not loaded";
      } else {
        const shape: AuthShape = {
          uid: a.uid, nickname: a.nickname, realm: a.realm,
          accessToken: a.accessToken, refreshToken: a.refreshToken,
          expiresAt: Number(a.expiresAt), domain: a.domain,
          enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
        };
        try {
          const r = await creditPackages(cfg, shape);
          row.packages = r.packages;
          row.remain = r.remain;
          row.size = r.size;
        } catch (e) {
          row.error = e instanceof Error ? e.message : String(e);
        }
      }
      out[i] = row;
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  // 余额降序：多的在前。
  out.sort((x, y) => y.remain - x.remain);
  return ok({ accounts: out, detail_limit: cfg.package_detail_limit });
}
