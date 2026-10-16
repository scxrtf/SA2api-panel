import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET 模型探测历史（对齐 modelProbes）。
// Go 版读探测结果文件（模型探针外部工具写入）；Next.js 版无该文件机制，
// 返回空集合作兼容占位（前端「探测历史」区块显示为空而非报错）。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  return ok({ probes: {}, exists: false });
}
