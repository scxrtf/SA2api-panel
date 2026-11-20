import { providerAllowlist, type KeyIdentity } from "./auth-guard";
import { isJSONObject } from "./request-validation";
import {
  invalidResponseRequest, isResponseId, isResponseJson, mediaType, readResponseJson, responseArray,
  responseHeaders, responseObject, ResponsesError, responsesError, ResponseSseDecoder, type ResponseObject as Obj,
} from "./responses-http";
import { chatResponseHeaders } from "./responses-output";
import { rememberResponse, responseDigest } from "./responses-state";

export type ResponsesOperation = "responses" | "compact" | "input_tokens" | "retrieve" | "delete" | "cancel" | "input_items";

// A configured base can itself be a pasted API endpoint. Only strip known
// terminal segments; a custom prefix (including earlier /responses) is part
// of the provider's address and must not be reinterpreted.
export function responsesCollectionPath(pathname: string, defaultBase = "/v1"): string {
  const path = pathname.replace(/\/+$/, "");
  const collection = path.replace(/(\/responses)(?:(?:\/v1)?\/responses)*(?:\/(?:compact|input_tokens))?$/, "$1");
  if (collection.endsWith("/responses")) return collection;
  if (path.endsWith("/chat/completions")) return path.slice(0, -"/chat/completions".length) + "/responses";
  return (path || defaultBase) + "/responses";
}

export function responsesEndpoint(base: string, operation: ResponsesOperation, id?: string) {
  const url = new URL(base);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash) throw new Error("Invalid Responses upstream");
  url.pathname = responsesCollectionPath(url.pathname);
  switch (operation) {
    case "responses": break;
    case "compact": case "input_tokens": url.pathname += "/" + operation; break;
    default:
      if (!isResponseId(id)) throw new Error("Invalid response ID");
      url.pathname += "/" + id;
      if (operation === "cancel" || operation === "input_items") url.pathname += "/" + operation;
  }
  return url;
}

export function nativeResponsesConfig() {
  const base = process.env.WB2A_RESPONSES_UPSTREAM?.trim() ?? "";
  const secret = process.env.WB2A_RESPONSES_KEY?.trim() ?? "";
  const models = new Set((process.env.WB2A_RESPONSES_MODELS ?? "").split(",").map((model) => model.trim()).filter(Boolean));
  const provider = process.env.WB2A_RESPONSES_PROVIDER?.trim() || "openai-responses";
  if (!models.size) return null;
  let canonical: string | null = null;
  try { canonical = responsesEndpoint(base, "responses").href; } catch { /* reported only when selected */ }
  return { base, secret, models, provider, canonical, backend: "native:" + responseDigest(canonical ?? base, secret, provider) };
}

type NativeConfig = NonNullable<ReturnType<typeof nativeResponsesConfig>>;

export function nativeModel(cfg: NativeConfig | null, model: string) {
  if (!cfg) return null;
  if (cfg.models.has(model)) return model;
  const prefix = cfg.provider + ":";
  return model.startsWith(prefix) && cfg.models.has(model.slice(prefix.length)) ? model.slice(prefix.length) : null;
}

export function nativeAllowed(cfg: NativeConfig, identity: KeyIdentity) {
  const grants = providerAllowlist(identity);
  return grants === null || grants.has(cfg.provider);
}

export function nativeResponsesModels(identity: KeyIdentity, authenticated: boolean) {
  const cfg = nativeResponsesConfig();
  if (!authenticated || !cfg?.canonical || !cfg.secret || !nativeAllowed(cfg, identity)) return [];
  return [...cfg.models].map((id) => ({ id, object: "model", created: 1753600000, owned_by: cfg.provider }));
}

export function nativeResponsesInput(body: Obj, identity: KeyIdentity) {
  // These are IDs of objects stored directly in the shared upstream project, not
  // gateway-scoped response IDs. External project references are for the master key.
  if (identity.unrestricted) return;
  for (const field of ["conversation", "prompt"]) {
    if (body[field] != null) throw new ResponsesError(403, "native_resource_not_allowed", "External upstream project references require the gateway main key.", field);
  }
  if (responseArray(body.input).some((item) => responseObject(item).type === "item_reference")) {
    throw new ResponsesError(403, "native_resource_not_allowed", "Use full input items or a gateway response ID for continuation.", "input");
  }
}

function registerNativeStream(source: ReadableStream<Uint8Array>, remember: (value: Obj) => Promise<void>) {
  const decoder = new ResponseSseDecoder();
  const reader = source.getReader();
  let closed = false;
  const release = (reason?: unknown) => {
    if (closed) return;
    closed = true;
    void reader.cancel(reason).catch(() => undefined);
    reader.releaseLock();
  };
  async function inspect(bytes?: Uint8Array) {
    for (const frame of decoder.feed(bytes)) {
      // Only parse lifecycle envelopes; token/tool events stay byte-for-byte untouched.
      if (frame.event && !["response.created", "response.queued", "response.in_progress", "response.completed", "response.incomplete", "response.failed"].includes(frame.event)) continue;
      let data: unknown;
      try { data = JSON.parse(frame.data); } catch { continue; }
      if (isJSONObject(data) && isJSONObject(data.response) && !closed) await remember(data.response);
    }
  }
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (closed) return;
        await inspect(value);
        if (closed) return;
        if (done) { release(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { if (!closed) { release(error); controller.error(error); } }
    },
    cancel: release,
  });
}

export async function relayNativeResponses(req: Request, cfg: NativeConfig, operation: ResponsesOperation,
  owner: string, model: string, body?: Obj, id?: string): Promise<Response> {
  if (!cfg.base || !cfg.secret) throw new ResponsesError(503, "responses_not_configured", "The native Responses provider configuration is incomplete.");
  let endpoint: URL;
  try { endpoint = responsesEndpoint(cfg.base, operation, id); }
  catch { throw new ResponsesError(503, "invalid_responses_upstream", "Invalid Responses upstream address."); }
  if (id) endpoint.search = new URL(req.url).search;
  const stream = body?.stream === true || (operation === "retrieve" && endpoint.searchParams.get("stream") === "true");
  const method = operation === "delete" ? "DELETE" : operation === "retrieve" || operation === "input_items" ? "GET" : "POST";
  const headers = new Headers({ Authorization: "Bearer " + cfg.secret, Accept: stream ? "text/event-stream" : "application/json" });
  if (body) headers.set("Content-Type", "application/json");
  const requestId = req.headers.get("x-client-request-id");
  if (requestId && /^[\x21-\x7e]{1,512}$/.test(requestId)) headers.set("X-Client-Request-Id", requestId);
  const timeout = AbortSignal.timeout(290_000);
  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual", cache: "no-store",
      signal: AbortSignal.any([req.signal, timeout]),
    });
  } catch {
    if (req.signal.aborted) throw new ResponsesError(499, "client_closed_request", "The client closed the request.");
    if (timeout.aborted) throw new ResponsesError(504, "responses_timeout", "The Responses provider timed out.");
    throw new ResponsesError(502, "responses_unreachable", "The Responses provider could not be reached.");
  }
  const safeHeaders = chatResponseHeaders(upstream);
  const cancelBody = () => { void upstream.body?.cancel().catch(() => undefined); };
  if (upstream.status === 405) {
    cancelBody();
    return responsesError(new ResponsesError(502, "responses_upstream_method_not_allowed",
      `The native Responses provider returned HTTP 405 for ${method}. Verify WB2A_RESPONSES_UPSTREAM supports the requested Responses operation.`), safeHeaders);
  }
  if ((upstream.status >= 300 && upstream.status < 400) || upstream.status === 401 || upstream.status === 403) {
    cancelBody();
    return responsesError(new ResponsesError(502, "responses_upstream_configuration", "The Responses provider rejected the gateway configuration."), safeHeaders);
  }
  const contentType = mediaType(upstream.headers);
  if (operation === "delete" && !upstream.body && [204, 205].includes(upstream.status)) {
    return new Response(null, { status: upstream.status, headers: responseHeaders(safeHeaders) });
  }
  const sse = contentType === "text/event-stream";
  if (upstream.ok && (!upstream.body || sse !== stream)) {
    cancelBody();
    return responsesError(new ResponsesError(502, stream ? "invalid_responses_stream" : "invalid_responses_json", stream ?
      "The provider did not return a Responses SSE stream." : "The provider did not return a Responses JSON object."), safeHeaders);
  }
  if (!isResponseJson(contentType) && !sse) {
    cancelBody();
    return responsesError(new ResponsesError(upstream.ok ? 502 : upstream.status, "responses_provider_error", "The Responses provider returned an unexpected content type."), safeHeaders);
  }
  safeHeaders.set("Content-Type", upstream.headers.get("content-type")!);
  if (sse) safeHeaders.set("X-Accel-Buffering", "no");
  const output = responseHeaders(safeHeaders);
  if (operation !== "responses" || body?.store === false || !upstream.ok) {
    return new Response(upstream.body, { status: upstream.status, headers: output });
  }

  let claimed = "";
  const remember = async (value: Obj) => {
    if (!isResponseId(value.id) || value.store === false || claimed) return;
    await rememberResponse(owner, value.id, cfg.backend, model);
    claimed = value.id;
  };
  if (sse) return new Response(registerNativeStream(upstream.body!, remember), { status: upstream.status, headers: output });
  let result: Obj;
  try { result = await readResponseJson(upstream); }
  catch {
    throw new ResponsesError(timeout.aborted ? 504 : 502, "invalid_responses_json", "The Responses provider returned invalid JSON.");
  }
  await remember(result);
  return Response.json(result, { status: upstream.status, headers: output });
}

export function requireNativeQueryStream(query: URLSearchParams) {
  const stream = query.get("stream");
  if (stream !== null && stream !== "true" && stream !== "false") invalidResponseRequest("stream must be a boolean.", "stream");
}
