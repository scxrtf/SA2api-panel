import { panelAuth, ok } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST 立即把内存中的用量桶落盘（对齐 usageSave）。
// Next.js 版用量直接写库（UsageEvent），无内存桶概念——返回 ok 作兼容占位。
export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  return ok();
}
