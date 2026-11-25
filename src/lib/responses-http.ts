import { isJSONObject } from "./request-validation";

export type ResponseObject = Record<string, unknown>;
export const MAX_RESPONSES_INPUT = 8 * 1024 * 1024;
export const MAX_RESPONSES_OUTPUT = 16 * 1024 * 1024;
export const responseObject = (value: unknown): ResponseObject => isJSONObject(value) ? value : {};
export const responseArray = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const responseText = (value: unknown): string => typeof value === "string" ? value : "";
export const isResponseId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value) && value !== "compact" && value !== "input_tokens";

export class ResponsesError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly param: string | null = null) {
    super(message);
  }
}

export function responseHeaders(extra?: HeadersInit) {
  const headers = new Headers(extra);
  headers.set("Cache-Control", "no-store, no-transform");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
}

export function responsesError(error: ResponsesError, extra?: HeadersInit) {
  const { status, code, message, param } = error;
  const type = status >= 500 ? "server_error" : status === 429 ? "rate_limit_error" : "invalid_request_error";
  return Response.json({ error: { message, type, param, code } }, { status, headers: responseHeaders(extra) });
}

export function invalidResponseRequest(message: string, param: string | null = null): never {
  throw new ResponsesError(400, "invalid_request", message, param);
}

export function unsupportedResponseParam(param: string): never {
  throw new ResponsesError(400, "unsupported_parameter", `${param} is not supported by this Chat-backed model.`, param);
}

export function missingResponse(id: string, previous = false): never {
  const param = previous ? "previous_response_id" : "response_id";
  throw new ResponsesError(404, previous ? "previous_response_not_found" : "response_not_found", `Response '${id}' was not found.`, param);
}

export function badChatResponse(): ResponsesError {
  return new ResponsesError(502, "invalid_upstream_response", "The Chat upstream returned an invalid or incomplete response.");
}

export async function readResponseJson(source: Request | Response): Promise<ResponseObject> {
  const inbound = source instanceof Request;
  const limit = inbound ? MAX_RESPONSES_INPUT : MAX_RESPONSES_OUTPUT;
  const reader = source.body?.getReader();
  const tooLarge = () => inbound ? new ResponsesError(413, "request_too_large", "The Responses request exceeds 8 MiB.") : badChatResponse();
  if (!reader) throw inbound ? new ResponsesError(400, "invalid_request", "A JSON request body is required.") : badChatResponse();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (Number(source.headers.get("content-length")) > limit) throw tooLarge();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw tooLarge();
      chunks.push(value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); } catch { /* handled below */ }
  if (!isJSONObject(value)) throw inbound ? new ResponsesError(400, "invalid_request", "The JSON body must be an object.") : badChatResponse();
  return value;
}

export function sseHeaders(headers?: HeadersInit): Headers {
  const result = responseHeaders(headers);
  result.set("Content-Type", "text/event-stream; charset=utf-8");
  result.set("X-Accel-Buffering", "no");
  return result;
}

export const mediaType = (headers: Headers) => (headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
export const isResponseJson = (type: string) => type === "application/json" || /^application\/[\w.+-]+\+json$/.test(type);

// Incremental SSE reader: UTF-8 and CR/LF can be split over HTTP chunks, and
// a single event may contain several data lines. Heartbeats stay out of the model output.
export class ResponseSseDecoder {
  private readonly decoder = new TextDecoder();
  private rest = "";
  private fields: string[] = [];
  private size = 0;
  private event = "";

  *feed(chunk?: Uint8Array): Generator<{ event: string; data: string }> {
    this.rest += chunk ? this.decoder.decode(chunk, { stream: true }) : this.decoder.decode() + "\n\n";
    const lineBreak = /\r\n|\n|\r(?!$)/g;
    let position = 0;
    for (let match: RegExpExecArray | null; (match = lineBreak.exec(this.rest));) {
      const line = this.rest.slice(position, match.index);
      position = lineBreak.lastIndex;
      this.size += line.length + 1;
      if (this.size > MAX_RESPONSES_OUTPUT) throw badChatResponse();
      if (!line) {
        if (this.fields.length) yield { event: this.event, data: this.fields.join("\n") };
        this.fields = [];
        this.event = "";
        this.size = 0;
      } else {
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") this.fields.push(value);
        if (field === "event") this.event = value;
      }
    }
    this.rest = this.rest.slice(position);
    if (this.rest.length + this.size > MAX_RESPONSES_OUTPUT) throw badChatResponse();
  }
}
