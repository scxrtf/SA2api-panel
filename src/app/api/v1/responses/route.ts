import { forwardResponses } from "@/lib/responses-gateway";
import { ResponsesError, responsesError } from "@/lib/responses-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) { return forwardResponses(request, "responses"); }

// The collection is not a listing endpoint. Return a protocol-shaped hint
// instead of Next's empty 405; never convert a GET or a probe into generation.
const allowedMethods = "POST, OPTIONS";

export function GET(request: Request) {
  const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  return responsesError(new ResponsesError(
    405,
    websocket ? "responses_websocket_unsupported" : "method_not_allowed",
    websocket
      ? 'Use HTTP POST with stream:true for Responses streaming. In Codex set supports_websockets = false.'
      : "Create a response with POST /api/v1/responses. Set the SDK Base URL to /api/v1 and use GET /api/v1/models to list models.",
  ), { Allow: allowedMethods });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: { Allow: allowedMethods } });
}
