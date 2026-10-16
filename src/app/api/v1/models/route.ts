// GET /api/v1/models —— 聚合模型目录（池账号目录 ∪ 供应商目录，带 realm/provider 前缀）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { verifyAny } from "@/lib/auth-guard";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { fetchModels, type AuthShape } from "@/lib/upstream/client";
import { providerModels } from "@/lib/provider";

export async function GET(req: Request): Promise<Response> {
  if (!(await verifyAny(req))) {
    return Response.json(
      { error: { message: "invalid or missing api key", type: "invalid_api_key" } },
      { status: 401 },
    );
  }
  const cfg = await getConfig();
  const accounts = await prisma.account.findMany({
    where: { state: { is: { disabled: false } } },
    take: 2, // 目录探针最多取 2 个号（域名各异代表两域）
  });
  const seen = new Set<string>();
  const data: { id: string; object: string; owned_by: string }[] = [];
  const push = (id: string, owner: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      data.push({ id, object: "model", owned_by: owner });
    }
  };
  for (const a of accounts) {
    const shape: AuthShape = {
      uid: a.uid, nickname: a.nickname, realm: a.realm,
      accessToken: a.accessToken, refreshToken: a.refreshToken,
      expiresAt: Number(a.expiresAt), domain: a.domain,
      enterpriseId: a.enterpriseId, deviceToken: a.deviceToken,
    };
    try {
      const models = await fetchModels(cfg, shape);
      const prefix = a.realm === "global" ? "global:" : "";
      for (const m of models) push(prefix + m.id, a.realm);
    } catch {
      // 单号目录失败不影响整体。
    }
  }
  for (const m of await providerModels()) push(m.id, m.owned_by);
  return Response.json({ object: "list", data });
}
