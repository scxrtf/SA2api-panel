import { forwardResponses } from "@/lib/responses-gateway";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) { return forwardResponses(request, "retrieve", (await params).id); }
export async function DELETE(request: Request, { params }: Context) { return forwardResponses(request, "delete", (await params).id); }
