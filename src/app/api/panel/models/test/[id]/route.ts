import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { cancelTest } from "@/lib/modeltest";

// DELETE 取消进行中的测试（幂等：未知 id 也返回 ok；对齐 modelTestCancel）。
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { id } = await ctx.params;
  cancelTest(id);
  return ok();
}
