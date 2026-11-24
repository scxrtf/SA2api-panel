import { isJSONObject } from "./request-validation";
import {
  invalidResponseRequest, MAX_RESPONSES_INPUT, responseArray, responseObject, responseText,
  ResponsesError, unsupportedResponseParam, type ResponseObject as Obj,
} from "./responses-http";
import { newResponseId, responseDigest, type ResponsesCodec } from "./responses-state";
import { expandAttachments } from "./responses-attachments";

export type ResponseTool = { name: string; namespace: string; custom: boolean };
const functionName = /^[A-Za-z0-9_-]{1,64}$/;
const prefixes: Record<string, string> = { function_call: "fc", function_call_output: "fco", custom_tool_call: "ctc",
  custom_tool_call_output: "ctco", reasoning: "rs", compaction: "cmp", web_search_call: "ws" };
const selectedFields = ["temperature", "top_p", "top_logprobs", "parallel_tool_calls", "prompt_cache_key",
  "prompt_cache_retention", "safety_identifier", "user"] as const;

const specified = (value: unknown) => value !== undefined && value !== null;
const hostedWebSearchTypes = new Set<unknown>(["web_search", "web_search_preview", "web_search_preview_2025_03_11"]);
const hostedWebSearchIncludes = new Set<unknown>(["web_search_call.action.sources", "web_search_call.results"]);

function omitOptionalWebSearch(request: Obj) {
  if (!Array.isArray(request.tools)) return { body: request, omittedWebSearch: false };
  const tools = request.tools.filter((tool) => !hostedWebSearchTypes.has(responseObject(tool).type));
  if (tools.length === request.tools.length) return { body: request, omittedWebSearch: false };
  // Codex advertises this hosted capability even on ordinary coding turns.
  // The Chat bridge cannot execute it; keep the real client tools and don't
  // forward the declaration or advertise it back in Responses metadata.
  const body: Obj = { ...request, tools };
  if (Array.isArray(request.include)) body.include = request.include.filter((key) => !hostedWebSearchIncludes.has(key));
  return { body, omittedWebSearch: true };
}

export function normalizeResponseInput(input: unknown, previous: Obj[]): Obj[] {
  if (input == null) return [];
  if (typeof input === "string") input = [{ role: "user", content: input }];
  if (!Array.isArray(input)) invalidResponseRequest("input must be a string or an array of items.", "input");
  const result: Obj[] = [];
  const known = new Map(previous.map((item) => [item.id, item]));
  for (const [index, raw] of input.entries()) {
    const param = `input[${index}]`;
    if (!isJSONObject(raw)) invalidResponseRequest("Each input item must be an object.", param);
    const type = raw.type ?? (raw.role ? "message" : "");
    if (type === "item_reference") {
      const item = known.get(raw.id);
      if (!item) invalidResponseRequest("The referenced item was not found in this response chain.", `${param}.id`);
      result.push({ ...item });
      continue;
    }
    if (type === "message") {
      if (!["system", "developer", "user", "assistant"].includes(responseText(raw.role))) {
        invalidResponseRequest("Invalid message role.", `${param}.role`);
      }
      const content = typeof raw.content === "string" ? (raw.role === "assistant"
        ? [{ type: "output_text", text: raw.content, annotations: [] }]
        : [{ type: "input_text", text: raw.content }]) : raw.content;
      if (!Array.isArray(content)) invalidResponseRequest("Message content must be a string or an array.", `${param}.content`);
      result.push({ ...raw, id: responseText(raw.id) || newResponseId("msg"), type, status: raw.status ?? "completed", content });
    } else {
      if (typeof type !== "string" || !type) invalidResponseRequest("An input item type is required.", `${param}.type`);
      const prefix = Object.hasOwn(prefixes, type) ? prefixes[type] : undefined;
      if (!prefix) unsupportedResponseParam(`${param}.type (${type})`);
      result.push({ ...raw, id: responseText(raw.id) || newResponseId(prefix), type });
    }
    known.set(result.at(-1)!.id, result.at(-1)!);
  }
  return result;
}

function hostedSearchText(item: Obj) {
  const action = responseObject(item.action);
  const results = responseArray(item.results).slice(0, 20).map((entry) => {
    const result = responseObject(entry);
    return { title: responseText(result.title), url: responseText(result.url), snippet: responseText(result.snippet ?? result.text).slice(0, 4000) };
  });
  const sources = responseArray(item.sources).slice(0, 20).map((entry) => responseText(responseObject(entry).url));
  return "Hosted web search from an earlier turn:\n" + JSON.stringify({ action, results, sources });
}

function chatContent(raw: unknown, role: string, param: string, toolImages: Obj[] = []) {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) invalidResponseRequest("Expected a string or an array of content parts.", param);
  const parts = raw.map((value, index): Obj | null => {
    const part = responseObject(value);
    const path = `${param}[${index}]`;
    if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      return { type: "text", text: part.text };
    }
    if (part.type === "refusal" && typeof part.refusal === "string") return { type: "text", text: part.refusal };
    if (part.type === "input_image") {
      if (!responseText(part.image_url) || part.file_id != null) unsupportedResponseParam(`${path} (image file_id)`);
      const image = { type: "image_url", image_url: { url: part.image_url, ...(part.detail == null ? {} : { detail: part.detail }) } };
      if (role === "tool") {
        // Chat Completions only permits multimodal content on user messages.
        // Keep this image as an explicit continuation of the tool result below.
        toolImages.push(image);
        return null;
      }
      if (role !== "user") unsupportedResponseParam(`${path} (image with role ${role})`);
      return image;
    }
    if (part.type === "input_file") unsupportedResponseParam(path);
    return invalidResponseRequest("Invalid content part for a Chat-backed model.", path);
  }).filter((part): part is Obj => part !== null);
  return parts.every((item) => item.type === "text") ? parts.map((part) => part.text).join("") : parts;
}

function toolAlias(name: string, namespace: string) {
  return namespace ? `${name.slice(0, 36)}_${responseDigest(namespace, name).slice(0, 24)}` : name;
}

function toolName(name: unknown, param: string) {
  if (typeof name !== "string" || !functionName.test(name)) invalidResponseRequest("Invalid tool name.", param);
  return name;
}

function toolDefinitions(raw: unknown) {
  if (specified(raw) && !Array.isArray(raw)) invalidResponseRequest("tools must be an array.", "tools");
  const chat: Obj[] = [];
  const aliases = new Map<string, ResponseTool>();
  const push = (tool: Obj, namespace: string, path: string, namespaceDescription = "") => {
    if (tool.type !== "function" && tool.type !== "custom") unsupportedResponseParam(`${path}.type (${responseText(tool.type)})`);
    const name = toolName(tool.name, `${path}.name`);
    const alias = toolAlias(name, namespace);
    if (aliases.has(alias)) invalidResponseRequest("Duplicate tool name.", `${path}.name`);
    const custom = tool.type === "custom";
    const description = [namespace ? `${namespace}.${name}: ${namespaceDescription}` : "", responseText(tool.description)].filter(Boolean).join("\n");
    if (custom && specified(tool.format) && responseObject(tool.format).type !== "text" && responseObject(tool.format).type !== "grammar") {
      invalidResponseRequest("Invalid custom tool format.", `${path}.format`);
    }
    const format = responseObject(tool.format);
    const grammar = custom && format.type === "grammar" ? `\nInput syntax (${responseText(format.syntax)}):\n${responseText(format.definition)}` : "";
    aliases.set(alias, { name, namespace, custom });
    chat.push({ type: "function", function: custom ? {
      name: alias, description: description + grammar, strict: true,
      parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
    } : {
      name: alias, ...(description ? { description } : {}), parameters: tool.parameters ?? { type: "object", properties: {} },
      ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
    } });
  };
  for (const [i, rawTool] of responseArray(raw).entries()) {
    const tool = responseObject(rawTool);
    const path = `tools[${i}]`;
    if (hostedWebSearchTypes.has(tool.type)) continue;
    if (tool.type === "namespace") {
      const namespace = toolName(tool.name, `${path}.name`);
      if (!Array.isArray(tool.tools)) invalidResponseRequest("Namespace tools must be an array.", `${path}.tools`);
      for (const [j, child] of tool.tools.entries()) push(responseObject(child), namespace, `${path}.tools[${j}]`, responseText(tool.description));
    } else push(tool, "", path);
  }
  return { chat, aliases };
}

function toChatToolChoice(raw: unknown, tools: Map<string, ResponseTool>): unknown {
  if (raw === "auto" || raw === "none" || raw === "required") return raw;
  const choice = responseObject(raw);
  if (choice.type === "allowed_tools") {
    const selected = responseArray(choice.tools).map(responseObject).filter((tool) => tool.type === "function" || tool.type === "custom");
    if (choice.mode !== "auto" && choice.mode !== "none" && choice.mode !== "required") unsupportedResponseParam("tool_choice.mode");
    if (selected.length !== 1) return choice.mode === "none" ? "none" : choice.mode === "required" && selected.length ? "required" : "auto";
    const tool = selected[0];
    const alias = toolAlias(toolName(tool.name, "tool_choice.tools[0].name"), responseText(tool.namespace));
    if (tools.get(alias)?.custom !== (tool.type === "custom")) invalidResponseRequest("The requested tool was not declared.", "tool_choice");
    return { type: "function", function: { name: alias } };
  }
  if (choice.type !== "function" && choice.type !== "custom") unsupportedResponseParam("tool_choice");
  const alias = toolAlias(toolName(choice.name, "tool_choice.name"), responseText(choice.namespace));
  if (tools.get(alias)?.custom !== (choice.type === "custom")) invalidResponseRequest("The requested tool was not declared.", "tool_choice");
  return { type: "function", function: { name: alias } };
}

function toChatFormat(raw: unknown) {
  const format = responseObject(raw);
  if (format.type === "text" || format.type === "json_object") return { type: format.type };
  if (format.type !== "json_schema" || !responseText(format.name) || !isJSONObject(format.schema)) {
    invalidResponseRequest("Invalid text.format.", "text.format");
  }
  const { type, ...schema } = format;
  return { type, json_schema: schema };
}

function chatMessages(input: Obj[], instructions: string, codec: ResponsesCodec) {
  const messages: Obj[] = instructions ? [{ role: "system", content: instructions }] : [];
  let assistant: Obj | undefined;
  const pending = new Set<string>();
  const emitAssistant = () => {
    if (assistant) messages.push(assistant);
    assistant = undefined;
  };
  const requireToolResults = () => {
    if (!pending.size) return;
    for (const callId of pending) messages.push({ role: "tool", tool_call_id: callId, content: "[Tool result unavailable: the previous turn was interrupted.]" });
    pending.clear();
  };
  const toolImages: Obj[][] = [];
  const emitToolImages = () => {
    if (!toolImages.length) return;
    messages.push({ role: "user", content: toolImages.flat() });
    toolImages.length = 0;
  };
  for (const [i, item] of input.entries()) {
    const path = `input[${i}]`;
    if (item.type === "reasoning") {
      emitToolImages();
      const encrypted = responseText(item.encrypted_content);
      const reasoning = encrypted ? codec.open("reasoning", encrypted) : responseArray(item.content).map((part) => responseText(responseObject(part).text)).join("");
      if (reasoning) {
        if (pending.size) { emitAssistant(); requireToolResults(); }
        assistant ??= { role: "assistant", content: null };
        assistant.reasoning_content = responseText(assistant.reasoning_content) + reasoning;
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      emitToolImages();
      const callId = responseText(item.call_id);
      const custom = item.type === "custom_tool_call";
      const args = custom && typeof item.input === "string" ? JSON.stringify({ input: item.input }) : item.arguments;
      if (!callId || typeof args !== "string" || pending.has(callId)) invalidResponseRequest("Invalid or duplicate tool call in the input.", path);
      assistant ??= { role: "assistant", content: null };
      const calls = assistant.tool_calls as Obj[] | undefined;
      const call = { id: callId, type: "function", function: { name: toolAlias(toolName(item.name, `${path}.name`), responseText(item.namespace)), arguments: args } };
      if (calls) calls.push(call);
      else assistant.tool_calls = [call];
      pending.add(callId);
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      emitAssistant();
      const callId = responseText(item.call_id);
      if (!pending.delete(callId)) continue;
      const images: Obj[] = [];
      let content = chatContent(item.output, "tool", `${path}.output`, images);
      if (typeof content === "string" ? !content : content.length === 0) {
        content = images.length ? "[Image-only tool result. See the following message.]" : "[Tool completed without text output.]";
      }
      messages.push({ role: "tool", tool_call_id: callId, content });
      for (const [index, image] of images.entries()) toolImages.push([
        { type: "text", text: `Image ${index + 1} from tool result ${callId}:` }, image,
      ]);
    } else if (item.type === "compaction") {
      emitToolImages();
      emitAssistant();
      requireToolResults();
      const summary = codec.open("compaction", responseText(item.encrypted_content));
      messages.push({ role: "assistant", content: "Conversation summary from an earlier window:\n" + summary });
    } else {
      emitToolImages();
      const role = responseText(item.role);
      const content = chatContent(item.content, role, `${path}.content`);
      if (role === "assistant") {
        if (assistant?.content != null || (!assistant && pending.size)) { emitAssistant(); requireToolResults(); }
        assistant ??= { role: "assistant", content: null };
        assistant.content = content;
      } else {
        emitAssistant();
        requireToolResults();
        messages.push({ role: role === "developer" ? "system" : role, content });
      }
    }
  }
  emitAssistant();
  requireToolResults();
  // Images follow the entire tool result group, never interrupting its pairing.
  emitToolImages();
  return { messages, pending };
}

export async function prepareBridgeInput(request: Obj, history: Obj[], codec: ResponsesCodec, compact = false) {
  const { body, omittedWebSearch } = omitOptionalWebSearch(request);
  for (const key of ["conversation", "prompt", "context_management", "max_tool_calls", "background_options", "moderation", "personality"]) {
    if (specified(body[key]) && !(Array.isArray(body[key]) && body[key].length === 0)) unsupportedResponseParam(key);
  }
  if (specified(body.truncation) && body.truncation !== "disabled") unsupportedResponseParam("truncation");
  if (specified(body.instructions) && typeof body.instructions !== "string") invalidResponseRequest("instructions must be a string.", "instructions");
  if (specified(body.include) && !Array.isArray(body.include)) invalidResponseRequest("include must be an array.", "include");
  const include = responseArray(body.include);
  for (const key of include) if (!hostedWebSearchIncludes.has(key) && !["reasoning.encrypted_content", "message.output_text.logprobs"].includes(responseText(key))) unsupportedResponseParam(`include (${String(key)})`);
  const rawInput = [...history, ...normalizeResponseInput(body.input, history)].map((item) => item.type === "web_search_call"
    ? { id: item.id, type: "message", role: "assistant", content: [{ type: "output_text", text: hostedSearchText(item) }], status: "completed" } : item);
  const input = await expandAttachments(rawInput);
  if (input.length > 10_000 || Buffer.byteLength(JSON.stringify(input)) > MAX_RESPONSES_INPUT) {
    throw new ResponsesError(400, "context_length_exceeded", "The Responses replay window is too large. Compact or shorten the input.", "input");
  }
  const instructions = responseText(body.instructions);
  const { messages } = chatMessages(input, compact ? "" : instructions, codec);
  if (!messages.length) invalidResponseRequest("An input item or instructions is required.", "input");
  const chat: Obj = { model: body.model, messages, stream: !compact && body.stream === true };
  const { chat: tools, aliases } = toolDefinitions(compact ? undefined : request.tools);
  const result = { chat, aliases, input, offset: history.length, effectiveBody: body, omittedWebSearch };
  if (compact) {
    const task = "Summarize the conversation for another assistant continuing it. Keep key decisions, current state, user constraints, relevant tool findings and remaining work. Write only the handoff summary.";
    messages.unshift({ role: "system", content: instructions ? task + "\nAdditional summary instructions:\n" + instructions : task });
    messages.push({ role: "user", content: "Produce the handoff summary now." });
    chat.max_completion_tokens = 3072;
    return result;
  }
  for (const key of selectedFields) if (specified(body[key])) chat[key] = body[key];
  if (specified(body.max_output_tokens)) {
    if (!Number.isSafeInteger(body.max_output_tokens) || Number(body.max_output_tokens) < 1) invalidResponseRequest("max_output_tokens must be a positive integer.", "max_output_tokens");
    chat.max_completion_tokens = body.max_output_tokens;
  }
  const reasoning = responseObject(body.reasoning);
  if (typeof reasoning.effort === "string") chat.reasoning_effort = reasoning.effort;
  const outputText = responseObject(body.text);
  if (outputText.format != null) chat.response_format = toChatFormat(outputText.format);
  if (typeof outputText.verbosity === "string") chat.verbosity = outputText.verbosity;
  if (tools.length) chat.tools = tools;
  if (specified(body.tool_choice)) {
    const rawChoice = responseObject(body.tool_choice);
    const choice = hostedWebSearchTypes.has(rawChoice.type) ? "auto" : toChatToolChoice(body.tool_choice, aliases);
    if (tools.length) chat.tool_choice = choice;
    // With no callable tools, forcing hosted search degrades to an ordinary
    // response; auto/none are likewise omitted for strict Chat providers.
  }
  if (include.includes("message.output_text.logprobs") || specified(body.top_logprobs)) chat.logprobs = true;
  if (chat.stream) chat.stream_options = { include_usage: true };
  return result;
}
