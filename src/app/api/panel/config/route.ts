// GET/POST /api/panel/config — 配置读写（saveConfig 校验 + 热生效，Setting 表落盘）。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { getConfig, saveConfig, DEFAULT_CONFIG } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const cfg = await getConfig();
  return ok({ config: cfg, defaults: DEFAULT_CONFIG });
}

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return fail(400, "invalid json body");
  }
  try {
    const cfg = await saveConfig(raw);
    return ok({ config: cfg });
  } catch (e) {
    return fail(400, e instanceof Error ? e.message : String(e));
  }
}
