// GET/POST /api/panel/config — 配置读写（saveConfig 校验 + 热生效，Setting 表落盘）。
// POST 为配置级操作：必须携带超级密码二次确认。
import { panelAuth, verifySuperPassword, ok, fail } from "@/lib/panel-auth";
import { getConfig, saveConfig, DEFAULT_CONFIG } from "@/lib/config";
import { reconfigure } from "@/lib/scheduler";

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
  const superPassword = (raw as Record<string, unknown> | null)?.["super_password"];
  if (!verifySuperPassword(superPassword)) {
    return fail(403, "超级密码错误");
  }
  // 从待保存体中剔除超级密码字段，避免被写入 Setting 表。
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const { super_password: _omit, ...rest } = raw as Record<string, unknown>;
    raw = rest;
  }
  try {
    const cfg = await saveConfig(raw);
    // 排程参数（schedule_*）可能已变：通知调度器主循环/余额循环重算时点与间隔。
    reconfigure();
    return ok({ config: cfg });
  } catch (e) {
    return fail(400, e instanceof Error ? e.message : String(e));
  }
}
