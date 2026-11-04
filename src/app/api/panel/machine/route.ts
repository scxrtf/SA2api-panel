// GET /api/panel/machine — 读取当前面板机器码及建 Key 授权状态。
// POST /api/panel/machine — 用独立建 Key 密码授权当前机器。
import { panelAuth, ok, fail } from "@/lib/panel-auth";
import {
  authorizeMachineByPassword,
  getOrCreateMachineId,
  machineKeyAuthorized,
  verifyMachinePassword,
} from "@/lib/machine-key";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const machine = await getOrCreateMachineId();
  return ok({ machine_id: machine.id, authorized: await machineKeyAuthorized(machine.id) });
}

export async function POST(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  let body: { password?: unknown };
  try {
    body = (await req.json()) as { password?: unknown };
  } catch {
    return fail(400, "invalid json body");
  }
  if (!verifyMachinePassword(body.password)) return fail(403, "密码错误");
  const machine = await getOrCreateMachineId();
  await authorizeMachineByPassword(machine.id);
  return ok({ machine_id: machine.id, authorized: true });
}
