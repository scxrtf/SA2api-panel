import { isJSONObject } from "./request-validation";
import { CHAT_SSE_CONSUMED } from "./provider-observation";
import {
  badChatResponse, isResponseJson, MAX_RESPONSES_OUTPUT, mediaType, readResponseJson, responseArray, responseHeaders,
  responseObject, responseText, ResponsesError, responsesError, ResponseSseDecoder, sseHeaders, type ResponseObject as Obj,
} from "./responses-http";
import type { ResponseTool } from "./responses-input";
import { newResponseId, type ResponsesCodec } from "./responses-state";
import { bestUsageCacheHitTokens } from "./upstream/usage";

const MAX_TOOLS = 256;
type Outcome = "completed" | "incomplete" | "failed";
type Positioned = { index: number; item: Obj };
type ToolSlot = { name: string; callId: string; args: string; opened?: Positioned };

function tokenCount(raw: unknown) {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

function outputUsage(raw: Obj | null) {
    if (!raw) return null;
    const input = tokenCount(raw.prompt_tokens ?? raw.input_tokens);
    const output = tokenCount(raw.completion_tokens ?? raw.output_tokens);
    const nestedInput = responseObject(raw.input_tokens_details);
    const nestedOutput = responseObject(raw.output_tokens_details);
    return {
      input_tokens: input, output_tokens: output, total_tokens: tokenCount(raw.total_tokens) || input + output,
      input_tokens_details: { cached_tokens: bestUsageCacheHitTokens(raw) ?? tokenCount(nestedInput.cached_tokens) },
      output_tokens_details: { reasoning_tokens: tokenCount(responseObject(raw.completion_tokens_details ?? raw.output_tokens_details).reasoning_tokens
        ?? nestedOutput.reasoning_tokens) },
  };
}

class ResponseAssembler {
  private readonly root: Obj;
  private readonly output: Obj[] = [];
  private readonly tools = new Map<number, ToolSlot>();
  private events: string[] = [];
  private sequence = 0;
  private characters = 0;
  private seenChoice = false;
  private usage: Obj | null = null;
  private reason = "";
  private message?: Positioned;
  private reasoning?: Positioned;
  private reasoningText = "";
  private serviceTier?: string;
  private nextTool = 0;

  constructor(
    private readonly body: Obj,
    private readonly aliases: Map<string, ResponseTool>,
    private readonly codec: ResponsesCodec,
    private readonly stream: boolean,
  ) {
    this.root = {
      id: newResponseId("resp"), object: "response", created_at: Math.floor(Date.now() / 1000),
      model: body.model, background: false, store: body.store !== false,
      instructions: body.instructions ?? null, max_output_tokens: body.max_output_tokens ?? null,
      max_tool_calls: null, metadata: body.metadata ?? {}, parallel_tool_calls: body.parallel_tool_calls ?? true,
      previous_response_id: body.previous_response_id ?? null,
      prompt_cache_key: body.prompt_cache_key ?? null,
      reasoning: { effort: null, summary: null, ...responseObject(body.reasoning) },
      temperature: body.temperature ?? 1, tool_choice: body.tool_choice ?? "auto", tools: body.tools ?? [],
      top_p: body.top_p ?? 1, top_logprobs: body.top_logprobs ?? 0, truncation: body.truncation ?? "disabled",
      text: { format: { type: "text" }, ...responseObject(body.text) }, user: body.user ?? null,
      service_tier: body.service_tier ?? null, conversation: body.conversation ?? null, prompt: body.prompt ?? null,
      context_management: body.context_management ?? null,
      background_options: body.background_options ?? null, moderation: body.moderation ?? null, personality: body.personality ?? null,
    };
  }

  private envelope(status: "in_progress" | Outcome, error?: ResponsesError): Obj {
    return {
      ...this.root, status, service_tier: this.serviceTier ?? this.body.service_tier ?? "default",
      completed_at: status === "completed" || status === "incomplete" ? Math.floor(Date.now() / 1000) : null,
      output: status === "in_progress" ? [] : this.output,
      incomplete_details: status === "incomplete" ? { reason: this.reason === "length" ? "max_output_tokens" : "content_filter" } : null,
      error: error ? { code: error.code, message: error.message } : null,
      usage: status === "in_progress" ? null : outputUsage(this.usage),
    };
  }

  private emit(type: string, value: Obj) {
    if (!this.stream) return;
    this.events.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...value })}\n\n`);
  }

  drain() { const events = this.events; this.events = []; return events; }

  start() {
    const response = this.envelope("in_progress");
    this.emit("response.created", { response });
    this.emit("response.in_progress", { response });
  }

  private addItem(item: Obj): Positioned {
    const index = this.output.push(item) - 1;
    this.emit("response.output_item.added", { output_index: index, item });
    return { index, item };
  }

  private record(size: number) {
    this.characters += size;
    if (this.characters > MAX_RESPONSES_OUTPUT) throw badChatResponse();
  }

  private addText(text: string, refusal: boolean, annotations: unknown[] = [], logprobs: unknown[] = []) {
    if (!text && !annotations.length) return;
    this.record(text.length);
    for (const entry of [...annotations, ...logprobs]) this.record(JSON.stringify(entry).length);
    this.message ??= this.addItem({ id: newResponseId("msg"), type: "message", role: "assistant", content: [], status: "in_progress" });
    const { item, index } = this.message;
    const content = item.content as Obj[];
    const type = refusal ? "refusal" : "output_text";
    const field = refusal ? "refusal" : "text";
    const event = refusal ? "response.refusal" : "response.output_text";
    // Adjacent text/refusal parts share a delta stream. New kind => new content index.
    let part = content.at(-1);
    if (part?.type !== type) {
      part = refusal ? { type, refusal: "" } : { type, text: "", annotations: [], logprobs: [] };
      content.push(part);
      this.emit("response.content_part.added", { item_id: item.id, output_index: index, content_index: content.length - 1, part });
    }
    const contentIndex = content.length - 1;
    part[field] = responseText(part[field]) + text;
    if (text) {
      this.emit(`${event}.delta`, { item_id: item.id, output_index: index, content_index: contentIndex, delta: text,
        ...(refusal ? {} : { logprobs }) });
    }
    if (!refusal) {
      const saved = part.annotations as unknown[];
      (part.logprobs as unknown[]).push(...logprobs);
      for (const annotation of annotations) {
        // Chat Completions wraps URL citations, whereas Responses flattens them.
        const raw = responseObject(annotation);
        const value = raw.type === "url_citation" && isJSONObject(raw.url_citation) ? { ...raw.url_citation, type: raw.type } : raw;
        this.emit("response.output_text.annotation.added", {
          item_id: item.id, output_index: index, content_index: contentIndex, annotation_index: saved.length, annotation: value,
        });
        saved.push(value);
      }
    }
  }

  private addReasoning(text: string) {
    if (!text) return;
    this.record(text.length);
    this.reasoning ??= this.addItem({ id: newResponseId("rs"), type: "reasoning", summary: [], content: [], status: "in_progress" });
    this.reasoningText += text;
    this.emit("response.reasoning_text.delta", { item_id: this.reasoning.item.id, output_index: this.reasoning.index, content_index: 0, delta: text });
  }

  private openTool(slot: ToolSlot) {
    const tool = this.aliases.get(slot.name) ?? { name: slot.name, namespace: "", custom: false };
    slot.callId ||= newResponseId("call");
    slot.opened = this.addItem({ id: newResponseId(tool.custom ? "ctc" : "fc"), call_id: slot.callId,
      name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}), status: "in_progress",
      ...(tool.custom ? { type: "custom_tool_call", input: "" } : { type: "function_call", arguments: "" }) });
    if (!tool.custom && slot.args) this.toolDelta(slot.opened, slot.args);
  }

  private toolDelta(opened: Positioned, delta: string) {
    this.emit("response.function_call_arguments.delta", { output_index: opened.index, item_id: opened.item.id, delta });
  }

  private addTool(rawCall: unknown, fallback: number) {
    if (!isJSONObject(rawCall)) throw badChatResponse();
    const index = rawCall.index ?? fallback;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= MAX_TOOLS) throw badChatResponse();
    let slot = this.tools.get(index);
    if (!slot) { slot = { callId: "", name: "", args: "" }; this.tools.set(index, slot); }
    const fn = responseObject(rawCall.function);
    const id = responseText(rawCall.id);
    const name = responseText(fn.name);
    const args = responseText(fn.arguments);
    this.record(id.length + name.length + args.length);
    if (id && id !== slot.callId) {
      if (slot.opened) throw badChatResponse();
      slot.callId = id;
    }
    if (name && name !== slot.name) {
      if (slot.opened) throw badChatResponse();
      slot.name += name;
    }
    if (slot.name.length > 64 || slot.callId.length > 256) throw badChatResponse();
    slot.args += args;
    if (slot.opened && args && slot.opened.item.type === "function_call") this.toolDelta(slot.opened, args);
  }

  private openReadyTools() {
    // Parallel chunks may start arguments for a later call first. Keep the
    // original Chat tool order while waiting for fragmented names and IDs.
    for (;;) {
      const slot = this.tools.get(this.nextTool);
      if (!slot?.name || !slot.callId || !slot.args) return;
      this.openTool(slot);
      this.nextTool++;
    }
  }

  accept(frame: Obj) {
    if (frame.error != null || frame.type === "error") {
      const error = responseObject(frame.error ?? frame);
      throw new ResponsesError(502, responseText(error.code) || "upstream_error", responseText(error.message) || "The Chat upstream reported an error.");
    }
    if (isJSONObject(frame.usage)) this.usage = frame.usage;
    if (typeof frame.service_tier === "string") this.serviceTier = frame.service_tier;
    const choice = responseArray(frame.choices).find((value) => (responseObject(value).index ?? 0) === 0);
    if (!isJSONObject(choice)) return;
    this.seenChoice = true;
    this.reason = responseText(choice.finish_reason) || this.reason;
    const message = responseObject(choice.delta ?? choice.message);
    this.addReasoning(responseText(message.reasoning_content ?? message.reasoning ?? message.thinking));
    this.addText(responseText(message.content), false, responseArray(message.annotations), responseArray(responseObject(choice.logprobs).content));
    this.addText(responseText(message.refusal), true);
    const tools = responseArray(message.tool_calls);
    for (const [i, tool] of tools.entries()) this.addTool(tool, i);
    if (!tools.length && isJSONObject(message.function_call)) this.addTool({ function: message.function_call }, 0);
    if (tools.length || message.function_call) this.openReadyTools();
  }

  finish(terminated: boolean) {
    if (!this.seenChoice || (!terminated && !this.reason)) throw badChatResponse();
    const outcome = this.reason === "length" || this.reason === "content_filter" ? "incomplete" : "completed";
    // Validate before producing done events. Never mark a partial/invalid call executable.
    const customInputs = new Map<ToolSlot, string>();
    if (outcome === "completed") {
      for (const slot of this.tools.values()) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(slot.name)) throw badChatResponse();
        let raw: unknown;
        try { raw = JSON.parse(slot.args || "{}"); } catch { throw badChatResponse(); }
        if (!isJSONObject(raw)) throw badChatResponse();
        if (this.aliases.get(slot.name)?.custom) {
          if (typeof raw.input !== "string") throw badChatResponse();
          customInputs.set(slot, raw.input);
        }
      }
    }
    if (this.reasoning) {
      const { item, index } = this.reasoning;
      item.content = [{ type: "reasoning_text", text: this.reasoningText }];
      if (responseArray(this.body.include).includes("reasoning.encrypted_content")) {
        item.encrypted_content = this.codec.seal("reasoning", this.reasoningText);
      }
      this.emit("response.reasoning_text.done", { item_id: item.id, output_index: index, content_index: 0, text: this.reasoningText });
    }
    if (this.message) {
      const { item, index } = this.message;
      for (const [contentIndex, part] of (item.content as Obj[]).entries()) {
        const position = { item_id: item.id, output_index: index, content_index: contentIndex };
        if (part.type === "output_text") this.emit("response.output_text.done", { ...position, text: part.text, logprobs: part.logprobs });
        else this.emit("response.refusal.done", { ...position, refusal: part.refusal });
        this.emit("response.content_part.done", { ...position, part });
      }
    }
    for (const [, slot] of [...this.tools].sort(([a], [b]) => a - b)) {
      if (!slot.opened && outcome === "completed") this.openTool(slot);
      if (!slot.opened) continue;
      const { item, index } = slot.opened;
      const position = { item_id: item.id, output_index: index };
      if (item.type === "function_call") {
        item.arguments = slot.args || (outcome === "completed" ? "{}" : "");
        if (outcome === "completed") this.emit("response.function_call_arguments.done", { ...position, arguments: item.arguments, name: item.name });
      } else if (outcome === "completed") {
        const input = customInputs.get(slot)!;
        item.input = input;
        if (input) this.emit("response.custom_tool_call_input.delta", { ...position, delta: input });
        this.emit("response.custom_tool_call_input.done", { ...position, input });
      }
    }
    for (const [output_index, item] of this.output.entries()) {
      item.status = outcome;
      if (outcome === "completed" || (item.type !== "function_call" && item.type !== "custom_tool_call")) {
        this.emit("response.output_item.done", { output_index, item });
      }
    }
    return this.envelope(outcome);
  }

  terminal(response: Obj) { this.emit(`response.${response.status}`, { response }); }

  fail(error: ResponsesError) {
    // A client must not execute any tool on a failed response, even if it saw some deltas.
    for (const item of this.output) item.status = "incomplete";
    this.terminal(this.envelope("failed", error));
  }
}

export function chatResponseHeaders(source: Response) {
  const headers = new Headers();
  for (const name of ["retry-after", "retry-after-ms", "x-request-id", "openai-processing-ms",
    "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests",
    "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens"]) {
    const value = source.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export async function bridgeChatError(source: Response) {
  const data = await readResponseJson(source).catch(() => ({} as Obj));
  const error = responseObject(data.error);
  const status = source.status >= 400 && source.status <= 599 ? source.status : 502;
  const result = responsesError(new ResponsesError(status, responseText(error.code) || "upstream_error",
    responseText(error.message) || `The Chat gateway returned HTTP ${source.status}.`, responseText(error.param) || null), chatResponseHeaders(source));
  if (!error.gateway_hint) return result;
  const envelope = await result.json();
  envelope.error.gateway_hint = error.gateway_hint;
  return Response.json(envelope, { status, headers: result.headers });
}

// Downstream demand controls the reader. No buffering of the entire upstream SSE
// response, and no tee that could drain the stream after the caller disconnects.
export async function bridgeChatResponse(source: Response, body: Obj, aliases: Map<string, ResponseTool>, codec: ResponsesCodec,
  persist: (result: Obj) => Promise<void>): Promise<Response> {
  if (!source.ok) return bridgeChatError(source);
  const media = mediaType(source.headers);
  const stream = body.stream === true;
  const assembler = new ResponseAssembler(body, aliases, codec, stream);
  const headers = chatResponseHeaders(source);
  const reader = media === "text/event-stream" ? source.body?.getReader() : undefined;
  let cancelled = false;
  let released = false;
  const release = (reason?: symbol) => {
    if (!reader || released) return;
    released = true;
    void reader.cancel(reason).catch(() => undefined);
    reader.releaseLock();
  };

  async function* convert(): AsyncGenerator<string, Obj | undefined> {
    assembler.start();
    yield* assembler.drain();
    let terminated = false;
    try {
      if (reader) {
        const decoder = new ResponseSseDecoder();
        readLoop: while (!cancelled) {
          const { done, value } = await reader.read();
          if (cancelled) return;
          for (const frame of decoder.feed(value)) {
            if (frame.data.trim() === "[DONE]") { terminated = true; break readLoop; }
            let parsed: unknown;
            try { parsed = JSON.parse(frame.data); } catch { throw badChatResponse(); }
            if (!isJSONObject(parsed)) throw badChatResponse();
            assembler.accept(frame.event === "error" && !parsed.type ? { ...parsed, type: "error" } : parsed);
            yield* assembler.drain();
          }
          if (done) break;
        }
      } else if (isResponseJson(media)) {
        assembler.accept(await readResponseJson(source));
        terminated = true;
        yield* assembler.drain();
      } else {
        void source.body?.cancel().catch(() => undefined);
        throw badChatResponse();
      }
      if (cancelled) return;
      const response = assembler.finish(terminated);
      await persist(response);
      if (cancelled) return;
      assembler.terminal(response);
      yield* assembler.drain();
      return response;
    } catch (error) {
      if (cancelled) return;
      const failure = error instanceof ResponsesError ? error : badChatResponse();
      if (!stream) throw failure;
      assembler.drain();
      assembler.fail(failure);
      yield* assembler.drain();
    } finally { release(terminated ? CHAT_SSE_CONSUMED : undefined); }
  }

  const events = convert();
  if (!stream) {
    const result = await events.next();
    if (!result.done || !result.value) throw badChatResponse();
    return Response.json(result.value, { headers: responseHeaders(headers) });
  }
  const encoder = new TextEncoder();
  const outbound = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await events.next();
        if (cancelled) return;
        if (result.done) controller.close();
        else controller.enqueue(encoder.encode(result.value));
      } catch (error) { if (!cancelled) controller.error(error); release(); }
    },
    async cancel() {
      cancelled = true;
      release();
      if (!reader && !source.body?.locked) void source.body?.cancel().catch(() => undefined);
      await events.return(undefined);
    },
  });
  return new Response(outbound, { headers: sseHeaders(headers) });
}
