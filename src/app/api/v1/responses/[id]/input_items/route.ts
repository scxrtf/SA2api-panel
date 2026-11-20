import { forwardResponses } from "@/lib/responses-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return forwardResponses(request, "input_items", (await params).id);
}
