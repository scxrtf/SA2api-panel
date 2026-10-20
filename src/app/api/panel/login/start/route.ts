// POST /api/panel/login/start — 发起 WorkBuddy OAuth 设备授权（auth/state 拿授权 URL）。
// state 会话存 LoginSession 表（15 分钟 TTL），poll 同 realm 完成落库。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";
import { loginEndpoints, loginDoJSON } from "@/lib/login";
import { runlogAccount } from "@/lib/runlog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let realm = "cn";
  try {
    const body = (await req.json()) as { realm?: string };
    if (body.realm === "global") realm = "global";
  } catch {
    // 空 body 按 cn 处理（与 Go 一致）。
  }
  const ep = loginEndpoints(realm);
  let data: unknown;
  try {
    data = await loginDoJSON("POST", ep.state, "", "{}", ep.origin);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    runlogAccount("发起添加账号失败", "realm=" + realm + ": " + msg);
    return fail(502, "auth state: " + msg);
  }
  const st = data as { state?: string; authUrl?: string };
  if (!st?.state || !st?.authUrl) {
    runlogAccount("发起添加账号失败", "realm=" + realm + ": missing state or authUrl");
    return fail(502, "auth state: missing state or authUrl");
  }
  // 顺手回收过期会话（防"开弹窗走开"的 state 滞留）。
  await prisma.loginSession.deleteMany({
    where: { createdAt: { lt: new Date(Date.now() - 15 * 60_000) } },
  }).catch(() => undefined);
  await prisma.loginSession.upsert({
    where: { state: st.state },
    create: { id: st.state, state: st.state, verifyUrl: st.authUrl, realm },
    update: { realm, verifyUrl: st.authUrl },
  });
  runlogAccount("发起添加账号", "realm=" + realm + " state=" + st.state.slice(0, 8));
  return ok({ url: st.authUrl, state: st.state, realm });
}
