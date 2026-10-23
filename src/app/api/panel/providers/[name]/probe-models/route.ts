// POST /api/panel/providers/{name}/probe-models — 用已存供应商的 base_url + key
// 探测上游模型列表，供「修改模型」编辑器勾选。key 原文只在服务端使用，不回显给前端。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { providerEndpoint } from "@/lib/provider-endpoint";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ name: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { name } = await ctx.params;
  const provider = await prisma.provider.findUnique({ where: { name } });
  if (!provider) return fail(404, "未找到供应商：" + name);
  try {
    const url = providerEndpoint(provider.baseUrl, "/models");
    const resp = await fetch(url, {
      headers: { Authorization: "Bearer " + provider.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      const raw = await resp.text();
      return fail(502, "upstream http " + resp.status + ": " + raw.slice(0, 200));
    }
    const data = (await resp.json()) as { data?: { id?: string }[] };
    const models = (data.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
    return ok({ models });
  } catch (e) {
    return fail(502, e instanceof Error ? e.message : "probe failed");
  }
}
