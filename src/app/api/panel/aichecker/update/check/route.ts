import { panelAuth, jsonify } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 自动更新检查不适用于面板集成版（文件随站点构建部署，不支持自更新），
// 返回「已是最新」形态，前端更新弹窗自然不触发。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  return jsonify({
    current: "2.6.1",
    latest: "2.6.1",
    has_update: false,
    update_available: false,
    integrated: true,
    detail: "面板集成版不支持自更新，跟随站点部署升级",
  });
}
