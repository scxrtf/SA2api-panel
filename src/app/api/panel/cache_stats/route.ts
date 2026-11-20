import { ok, panelAuth } from "@/lib/panel-auth";
import { readCacheStatus } from "@/lib/cache-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await panelAuth(req);
  if (auth) return auth;

  const response = ok({ ...readCacheStatus() });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
