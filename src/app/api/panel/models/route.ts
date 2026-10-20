// GET /api/panel/models — 池账号实时模型目录 + 供应商目录（某域失败独立容错）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { getConfig } from "@/lib/config";
import { fetchModelsFull, fetchGlobalModelInfos } from "@/lib/upstream/modelCatalog";
import { providerModels } from "@/lib/provider";
import { authShapeOf } from "@/lib/login";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const cfg = await getConfig();
  const out: Record<string, unknown>[] = [];
  const fetchErrs: string[] = [];

  // 池通道：CN / global 各取一个可用账号探测（某域无账号则整域跳过）。
  const accounts = await prisma.account.findMany({ include: { state: true } });
  const usable = accounts.filter(
    (a) => !(a.state?.disabled ?? false) && !(a.state?.paused ?? false) && a.accessToken !== "",
  );
  for (const realm of ["cn", "global"]) {
    const acct = usable.find((a) => a.realm === realm);
    if (!acct) continue;
    try {
      const shape = authShapeOf(acct);
      if (realm === "global") {
        // global 域纯动态四路探测（v3 三路 UA + 企业端点补缺），拉不出即空名单。
        const { names, infos } = await fetchGlobalModelInfos(cfg, shape);
        for (const id of names) {
          const mi = infos?.find((x) => x.id === id);
          out.push({ id: realm + ":" + id, name: mi?.name ?? id, credits: mi?.credits ?? "" });
        }
      } else {
        const infos = await fetchModelsFull(cfg, shape);
        for (const mi of infos) {
          out.push({ id: realm + ":" + mi.id, name: mi.name ?? mi.id, credits: mi.credits ?? "" });
        }
      }
    } catch (e) {
      fetchErrs.push(realm + ": " + (e instanceof Error ? e.message : String(e)));
    }
  }

  // 供应商通道：name:model 前缀入库（与路由口径一致）。
  try {
    for (const m of await providerModels()) {
      const name = m.owned_by;
      const bare = m.id.startsWith(name + ":") ? m.id.slice(name.length + 1) : m.id;
      out.push({ id: m.id, name: bare, vendor: name, provider: true });
    }
  } catch (e) {
    fetchErrs.push("providers: " + (e instanceof Error ? e.message : String(e)));
  }

  if (out.length === 0) {
    if (fetchErrs.length > 0) return fail(502, "fetch models: " + fetchErrs.join("; "));
    return fail(503, "没有可用账号：请先在面板添加账号再查询");
  }
  return ok({ models: out });
}
