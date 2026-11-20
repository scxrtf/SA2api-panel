import { identifier, json, workspaceError, workspaceGuard } from "@/lib/workspace/http";
import { gatewayStore } from "@/lib/workspace/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const guard = await workspaceGuard(req);
    if (guard) return guard;
    const session = identifier(new URL(req.url).searchParams.get("session") ?? undefined, true);
    const store = gatewayStore();
    store.reapGateway();
    return json(store.gatewaySnapshot(session));
  } catch (error) { return workspaceError(error); }
}
