import { panelAuth, ok } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { listProbes } from "@/lib/modelprobe";
import { listModelHealth } from "@/lib/modelhealth";

// GET 模型探测历史（对齐 modelProbes 契约：{probes, exists, updated_at}）。
// Go 版读外部 output_probes.json（python 脚本写入）；Next.js 版改为落库
// ModelProbe（面板内一键探测 POST /api/panel/models/probe 写入），语义等价。
// health 独立返回真实最小聊天探测历史，供状态卡计算可用率与心跳。
export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const [probes, health] = await Promise.all([listProbes(), listModelHealth()]);
  return ok({ ...probes, health });
}
