import { panelAuth, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 面板集成版不提供自更新（对齐 serve_update_apply 的路径占位）。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  return fail(400, "面板集成版不支持自更新，请通过部署升级");
}
