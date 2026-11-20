import { forwardResponses } from "@/lib/responses-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) { return forwardResponses(request, "compact"); }
