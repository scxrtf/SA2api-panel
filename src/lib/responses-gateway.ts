import { extractToken, identifyKeyIdentity, providerAllowed, type KeyIdentity } from "@/lib/auth-guard";
import { handleChat, resolveModel } from "@/lib/chat";
import { getConfig } from "@/lib/config";
import { observeGateway } from "@/lib/workspace/gateway-observer";
import {
  invalidResponseRequest, isResponseId, missingResponse, readResponseJson, responseArray, responseHeaders, responseObject,
  responseText, ResponsesError, responsesError, unsupportedResponseParam, type ResponseObject as Obj,
} from "./responses-http";
import { prepareBridgeInput } from "./responses-input";
import {
  nativeAllowed, nativeModel, nativeResponsesConfig, nativeResponsesInput, relayNativeResponses, requireNativeQueryStream,
  type ResponsesOperation,
} from "./responses-native";
import { bridgeChatResponse } from "./responses-output";
import {
  bridgeBackend, fetchStoredResponse, forgetResponse, newResponseId, readBridgeSnapshot, rememberResponse,
  responseDigest, responsesCodec,
} from "./responses-state";

export { responsesEndpoint } from "./responses-native";

function bridgeAllowed(model: string, identity: KeyIdentity) {
  const { provider, bare } = resolveModel(model);
  if (!bare.trim() || model.startsWith(":")) invalidResponseRequest("A model name is required after its prefix.", "model");
  return !provider || identity.unrestricted || providerAllowed(identity.providers, provider);
}

function listInputItems(items: Obj[], query: URLSearchParams) {
  const rawLimit = query.get("limit") ?? "20";
  const limit = Number(rawLimit);
  if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    invalidResponseRequest("limit must be an integer between 1 and 100.", "limit");
  }
  const order = query.get("order") ?? "desc";
  if (order !== "asc" && order !== "desc") invalidResponseRequest("order must be asc or desc.", "order");
  const sorted = order === "asc" ? items : items.slice().reverse();
  const after = query.get("after");
  const cursor = after === null ? -1 : sorted.findIndex((item) => item.id === after);
  if (after !== null && cursor === -1) invalidResponseRequest("The pagination cursor does not identify an input item.", "after");
  const data = sorted.slice(cursor + 1, cursor + 1 + limit);
  return Response.json({ object: "list", data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null,
    has_more: cursor + 1 + data.length < sorted.length }, { headers: responseHeaders() });
}

async function routeStored(req: Request, operation: ResponsesOperation, id: string, owner: string, identity: KeyIdentity, mainKey: string) {
  if (!isResponseId(id)) invalidResponseRequest("Invalid response ID.", "response_id");
  const stored = await fetchStoredResponse(owner, id);
  if (!stored) missingResponse(id);
  const query = new URL(req.url).searchParams;
  if (operation === "retrieve") requireNativeQueryStream(query);
  if (stored.backend !== bridgeBackend) {
    const cfg = nativeResponsesConfig();
    if (!mainKey || !cfg || cfg.backend !== stored.backend || !cfg.models.has(stored.model) || !nativeAllowed(cfg, identity)) missingResponse(id);
    const response = await relayNativeResponses(req, cfg, operation, owner, stored.model, undefined, id);
    if (operation === "delete" && (response.ok || response.status === 404)) await forgetResponse(owner, id);
    return response;
  }
  if (!bridgeAllowed(stored.model, identity)) missingResponse(id);
  if (operation === "delete") {
    if (!await forgetResponse(owner, id)) missingResponse(id);
    return Response.json({ id, object: "response.deleted", deleted: true }, { headers: responseHeaders() });
  }
  if (operation === "cancel") throw new ResponsesError(400, "response_not_cancellable", "Only background responses can be cancelled.");
  const snapshot = readBridgeSnapshot(stored.snapshot);
  if (operation === "input_items") return listInputItems(snapshot.input.slice(snapshot.offset), query);
  if (query.get("stream") === "true" || query.has("starting_after")) unsupportedResponseParam("stream resume");
  return Response.json(snapshot.response, { headers: responseHeaders() });
}

function validateCommon(body: Obj) {
  for (const field of ["stream", "store", "background"]) {
    if (body[field] != null && typeof body[field] !== "boolean") invalidResponseRequest(`${field} must be a boolean.`, field);
  }
  if (body.previous_response_id != null && !isResponseId(body.previous_response_id)) {
    invalidResponseRequest("Invalid previous response ID.", "previous_response_id");
  }
  if (body.previous_response_id != null && body.conversation != null) {
    invalidResponseRequest("previous_response_id and conversation are mutually exclusive.", "previous_response_id");
  }
}

async function dispatch(req: Request, operation: ResponsesOperation, id?: string) {
  const app = await getConfig();
  const identity = await identifyKeyIdentity(req);
  if (!identity) throw new ResponsesError(401, "invalid_api_key", "Invalid or missing API key.");
  const token = extractToken(req);
  // Scope by the credential rather than the display name, which can be reused or changed.
  const owner = responseDigest("gateway-key", token);
  if (id !== undefined) return routeStored(req, operation, id, owner, identity, app.api_key);
  if (operation !== "responses" && operation !== "compact" && operation !== "input_tokens") {
    throw new ResponsesError(405, "invalid_request", "This method requires a response ID.");
  }

  const body = await readResponseJson(req);
  validateCommon(body);
  if (operation === "compact" && body.stream === true) invalidResponseRequest("The compact endpoint does not stream.", "stream");
  const cfg = nativeResponsesConfig();
  const previousId = responseText(body.previous_response_id);
  const previous = previousId ? await fetchStoredResponse(owner, previousId) : null;
  if (previousId && !previous) missingResponse(previousId, true);
  const model = body.model ?? previous?.model;
  if (typeof model !== "string" || !model.trim()) invalidResponseRequest("A model is required.", "model");
  const upstreamModel = nativeModel(cfg, model);
  if (cfg && upstreamModel) {
    if (!app.api_key) throw new ResponsesError(503, "responses_auth_not_configured", "Configure gateway authentication before enabling native Responses.");
    if (!token) throw new ResponsesError(401, "invalid_api_key", "Invalid or missing API key.");
    if (!nativeAllowed(cfg, identity)) throw new ResponsesError(403, "provider_not_allowed", "This key does not have permission to use the Responses provider.");
    if (previous && (previous.backend !== cfg.backend || !cfg.models.has(previous.model))) missingResponse(previousId, true);
    nativeResponsesInput(body, identity);
    const send = () => relayNativeResponses(req, cfg, operation, owner, upstreamModel, { ...body, model: upstreamModel });
    return operation === "input_tokens" ? send() : observeGateway(req, { ...body, model }, operation, identity, send);
  }
  if (previous && (previous.backend !== bridgeBackend || !bridgeAllowed(previous.model, identity))) missingResponse(previousId, true);
  if (cfg && model.startsWith(cfg.provider + ":")) {
    throw new ResponsesError(404, "model_not_found", "The model is not configured for native Responses.", "model");
  }
  if (operation === "input_tokens") unsupportedResponseParam("input_tokens");

  const local = { ...body, model };
  const codec = responsesCodec(owner, app.api_key);
  const last = previous && readBridgeSnapshot(previous.snapshot);
  const history = last ? [...last.input, ...responseArray(last.response.output).map(responseObject).filter((item) =>
    item.status !== "incomplete" || (item.type !== "function_call" && item.type !== "custom_tool_call"))] : [];
  const input = prepareBridgeInput(local, history, codec, operation === "compact");
  return observeGateway(req, local, operation, identity, async () => {
    const result = await handleChat({ body: input.chat, sessionBody: local, req,
      inboundHeaders: req.headers, clientIP: (req.headers.get("x-forwarded-for") ?? req.headers.get("x-real-ip") ?? "").split(",", 1)[0].trim(),
      ua: req.headers.get("user-agent") ?? "", path: operation === "compact" ? "/v1/responses/compact" : "/v1/responses" });
    const responseBody = operation === "compact" ? { model, store: false } : input.effectiveBody;
    const converted = await bridgeChatResponse(result, responseBody, input.aliases, codec, async (response) => {
      if (operation !== "compact" && body.store !== false) {
        await rememberResponse(owner, responseText(response.id), bridgeBackend, model, { response, input: input.input, offset: input.offset });
      }
    });
    if (input.omittedWebSearch) converted.headers.set("X-WB2A-Omitted-Tools", "web_search");
    if (operation !== "compact" || !converted.ok) return converted;
    const completion = await converted.json() as Obj;
    const summary = responseArray(completion.output).flatMap((item) => responseArray(responseObject(item).content))
      .map(responseObject).filter((part) => part.type === "output_text").map((part) => responseText(part.text)).join("");
    if (!summary.trim() || completion.status !== "completed") {
      throw new ResponsesError(502, "compaction_failed", "The model did not finish a compaction summary.");
    }
    const output = input.input.filter((item) => item.type === "message" && item.role === "user");
    output.push({ type: "compaction", id: newResponseId("cmp"), encrypted_content: codec.seal("compaction", summary) });
    return Response.json({ id: newResponseId("resp"), object: "response.compaction", created_at: completion.created_at,
      output, usage: completion.usage }, { headers: converted.headers });
  });
}

export async function forwardResponses(req: Request, operation: ResponsesOperation, id?: string) {
  try { return await dispatch(req, operation, id); }
  catch (error) {
    if (req.signal.aborted) return responsesError(new ResponsesError(499, "client_closed_request", "The client closed the request."));
    if (error instanceof ResponsesError) return responsesError(error);
    return responsesError(new ResponsesError(500, "responses_request_failed", "The gateway could not process the Responses request."));
  }
}
