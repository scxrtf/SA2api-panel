import { panelAuth, jsonify } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 集成版本固定为原项目 v2.6.1 快照（对齐 start.py /api/version）。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  return jsonify({ version: "2.6.1" });
}
