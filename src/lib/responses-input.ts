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
  custom_tool_call_output: "ctco", reasoning: "rs", compaction: "cmp", web_search_call: "ws", tool_search_call: "ts",
  tool_search_output: "tso", file_search_call: "fs", computer_call: "cc", code_interpreter_call: "ci", image_generation_call: "ig",
  local_shell_call: "ls", mcp_call: "mcp", mcp_approval_request: "mcpar", mcp_approval_response: "mcprs", mcp_list_tools: "mcplt",
  tool_search_tool_call: "tstc", tool_search_tool_output: "tsto", tool_search_tool_result: "tstr", tool_search_result: "tsr",
  shell_call: "sh", shell_call_output: "sho", apply_patch_call: "ap", apply_patch_call_output: "apo",
  computer_call_output: "cco", local_shell_call_output: "lso", mcp_call_output: "mcpo", custom_tool_call_output_item: "ctoi" };
const selectedFields = ["temperature", "top_p", "top_logprobs", "parallel_tool_calls", "prompt_cache_key",
  "prompt_cache_retention", "safety_identifier", "user"] as const;
const selectedFieldSet = new Set<string>(selectedFields);

const specified = (value: unknown) => value !== undefined && value !== null;
const hostedWebSearchTypes = new Set<unknown>(["web_search", "web_search_preview", "web_search_preview_2025_03_11"]);
const hostedWebSearchIncludes = new Set<unknown>(["web_search_call.action.sources", "web_search_call.results"]);
const supportedIncludes = new Set<unknown>([...hostedWebSearchIncludes, "reasoning.encrypted_content", "message.output_text.logprobs",
  "code_interpreter_call.outputs", "computer_call_output.output_url_safety_check", "file_search_call.results", "message.input_image.image_url",
  "tool_search_call.output", "web_search_call.action.sources", "web_search_call.results"]);
const hostedDiscoveryTypes = new Set<unknown>(["tool_search", "file_search", "computer_use_preview", "code_interpreter", "image_generation", "local_shell", "mcp"]);
const hostedHistoryTypes = new Set<unknown>(["web_search_call", "tool_search_call", "file_search_call", "computer_call", "code_interpreter_call",
  "image_generation_call", "local_shell_call", "mcp_call", "mcp_approval_request", "mcp_approval_response", "mcp_list_tools", "tool_search_output",
  "tool_search_tool_call", "tool_search_tool_output", "tool_search_tool_result", "tool_search_result", "shell_call", "apply_patch_call",
  "computer_call_output", "local_shell_call_output", "shell_call_output", "apply_patch_call_output", "mcp_call_output",
  "custom_tool_call_output_item"]);
const callableToolTypes = new Set<unknown>(["function", "custom", "namespace"]);

// Responses keeps adding hosted item/tool variants. They are not executable over
// Chat Completions, but they are valid protocol values and must not be reported
// as an unsupported model dependency.
const hostedToolType = (type: unknown) => typeof type === "string" && type.length > 0 && !callableToolTypes.has(type);
const hostedTool = (tool: Obj) => hostedWebSearchTypes.has(tool.type) || hostedDiscoveryTypes.has(tool.type) || hostedToolType(tool.type);

function omitOptionalWebSearch(request: Obj) {
  if (!Array.isArray(request.tools)) return { body: request, omittedWebSearch: false, omittedTools: [] };
  const omittedTools = new Set<string>();
  function declarations(values: unknown[]): Obj[] {
    return values.map(responseObject).map((tool) => {
      const hosted = hostedTool(tool);
      if (hosted) omittedTools.add(responseText(tool.type));
      return hosted ? null : tool.type === "namespace" ? { ...tool, tools: declarations(responseArray(tool.tools)) } : tool;
    }).filter((tool): tool is Obj => tool !== null);
  }
  const tools = declarations(request.tools);
  if (!omittedTools.size) return { body: request, omittedWebSearch: false, omittedTools: [] };
  // Codex advertises this hosted capability even on ordinary coding turns.
  // The Chat bridge cannot execute it; keep the real client tools and don't
  // forward the declaration or advertise it back in Responses metadata.
  const body: Obj = { ...request, tools };
  if (Array.isArray(request.include)) body.include = request.include.filter((key) => !hostedWebSearchIncludes.has(key));
  return { body, omittedWebSearch: true, omittedTools: [...omittedTools] };
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
      const prefix = Object.hasOwn(prefixes, type) ? prefixes[type] : "item";
      result.push({ ...raw, id: responseText(raw.id) || newResponseId(prefix), type });
    }
    known.set(result.at(-1)!.id, result.at(-1)!);
  }
  return result;
}

function hostedSearchText(item: Obj) {
  const raw = JSON.stringify(item);
  const data = raw.length <= 100_000 ? raw : raw.slice(0, 100_000) + "…";
  return `Hosted ${responseText(item.type)} from an earlier turn:\n${data}`;
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
      if (!responseText(part.image_url) || part.file_id != null) invalidResponseRequest("An image needs an image_url or inline file_data.", path);
      const image = { type: "image_url", image_url: { url: part.image_url, ...(part.detail == null ? {} : { detail: part.detail }) } };
      if (role === "tool") {
        // Chat Completions only permits multimodal content on user messages.
        // Keep this image as an explicit continuation of the tool result below.
        toolImages.push(image);
        return null;
      }
      if (role !== "user") {
        toolImages.push({ type: "text", text: `Image attached to the preceding ${role} message:` }, image);
        return null;
      }
      return image;
    }
    if (part.type === "input_file" || part.type === "input_audio") invalidResponseRequest("The attachment must contain file_data or a supported file_url.", path);
    if (typeof part.text === "string") return { type: "text", text: part.text };
    const encoded = JSON.stringify(part);
    return { type: "text", text: `Unsupported content part preserved as context:\n${encoded.length > 100_000 ? encoded.slice(0, 100_000) + "…" : encoded}` };
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
    if (hostedTool(tool)) continue;
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
    const selected = responseArray(choice.tools).map(responseObject);
    if (choice.mode !== "auto" && choice.mode !== "none" && choice.mode !== "required") unsupportedResponseParam("tool_choice.mode");
    if (selected.some((tool) => !responseText(tool.type))) {
      invalidResponseRequest("Invalid tool type in tool_choice.", "tool_choice.tools");
    }
    if (choice.mode === "required" && selected.length === 0) {
      invalidResponseRequest("tool_choice.tools must not be empty when mode is required.", "tool_choice.tools");
    }
    if (choice.mode === "none") return "none";
    if (choice.mode === "required" && (selected.length !== 1 || selected[0].type === "namespace")) return "required";
    if (selected.length !== 1) return "auto";
    const tool = selected[0];
    if (hostedTool(tool)) return "auto";
    if (tool.type === "namespace") return "auto";
    const alias = toolAlias(toolName(tool.name, "tool_choice.tools[0].name"), responseText(tool.namespace));
    if (tools.get(alias)?.custom !== (tool.type === "custom")) invalidResponseRequest("The requested tool was not declared.", "tool_choice");
    return { type: "function", function: { name: alias } };
  }
  if (choice.type === "namespace") return "auto";
  if (hostedTool(choice)) return "auto";
  if (choice.type !== "function" && choice.type !== "custom") invalidResponseRequest("Invalid tool_choice type.", "tool_choice.type");
  const alias = toolAlias(toolName(choice.name, "tool_choice.name"), responseText(choice.namespace));
  if (tools.get(alias)?.custom !== (choice.type === "custom")) invalidResponseRequest("The requested tool was not declared.", "tool_choice");
  return { type: "function", function: { name: alias } };
}

function filterToolDeclarations(raw: unknown, choice: unknown, aliases: Map<string, ResponseTool>) {
  const selected = responseObject(choice);
  if (selected.type !== "allowed_tools") return responseArray(raw);
  const declared = responseArray(selected.tools).map(responseObject);
  const namespaces = new Set(declared.filter((tool) => tool.type === "namespace").map((tool) => responseText(tool.name)));
  const declaredNamespaces = new Set(responseArray(raw).map(responseObject).filter((tool) => tool.type === "namespace").map((tool) => responseText(tool.name)));
  for (const namespace of namespaces) {
    if (!declaredNamespaces.has(namespace)) invalidResponseRequest("An allowed namespace was not declared.", "tool_choice.tools");
  }
  const allowed = new Set(declared.filter((tool) => tool.type === "function" || tool.type === "custom").map((tool) =>
    toolAlias(toolName(tool.name, "tool_choice.tools.name"), responseText(tool.namespace))));
  for (const name of allowed) if (!aliases.has(name)) invalidResponseRequest("An allowed tool was not declared.", "tool_choice.tools");
  return responseArray(raw).map(responseObject).flatMap((tool): Obj[] => {
    if (tool.type === "namespace") {
      const namespace = responseText(tool.name);
      if (namespaces.has(namespace)) return [tool];
      const children = responseArray(tool.tools).map(responseObject).filter((child) =>
        allowed.has(toolAlias(toolName(child.name, "tools.name"), namespace)));
      return children.length ? [{ ...tool, tools: children }] : [];
    }
    return allowed.has(toolAlias(toolName(tool.name, "tools.name"), responseText(tool.namespace))) ? [tool] : [];
  });
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
      if (!pending.size) emitToolImages();
      const encrypted = responseText(item.encrypted_content);
      const reasoning = encrypted ? codec.open("reasoning", encrypted) : responseArray(item.content).map((part) => responseText(responseObject(part).text)).join("");
      if (reasoning) {
        if (pending.size) { emitAssistant(); requireToolResults(); }
        assistant ??= { role: "assistant", content: null };
        assistant.reasoning_content = responseText(assistant.reasoning_content) + reasoning;
      }
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      if (!pending.size) emitToolImages();
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
      if (item.call_id !== undefined && typeof item.call_id !== "string") invalidResponseRequest("call_id must be a string.", `${path}.call_id`);
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
      if (!role) {
        emitAssistant();
        requireToolResults();
        messages.push({ role: "assistant", content: hostedSearchText(item) });
        continue;
      }
      const images: Obj[] = [];
      const content = chatContent(item.content, role, `${path}.content`, images);
      if (role === "assistant") {
        if (assistant?.content != null || (!assistant && pending.size)) { emitAssistant(); requireToolResults(); }
        assistant ??= { role: "assistant", content: null };
        const empty = typeof content === "string" ? !content : content.length === 0;
        assistant.content = empty && images.length ? "[Image attached in the following user message.]" : content;
        if (images.length) toolImages.push(images);
      } else {
        emitAssistant();
        requireToolResults();
        messages.push({ role: role === "developer" ? "system" : role, content });
        if (images.length) toolImages.push(images);
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
  const { body, omittedWebSearch, omittedTools } = omitOptionalWebSearch(request);
  // Provider-only settings do not alter the Chat message/function conversion.
  if (specified(body.instructions) && typeof body.instructions !== "string") invalidResponseRequest("instructions must be a string.", "instructions");
  if (specified(body.model) && typeof body.model !== "string") invalidResponseRequest("model must be a string.", "model");
  if (specified(body.previous_response_id) && typeof body.previous_response_id !== "string") invalidResponseRequest("previous_response_id must be a string.", "previous_response_id");
  if (specified(body.include) && !Array.isArray(body.include)) invalidResponseRequest("include must be an array.", "include");
  for (const key of [...selectedFieldSet, "service_tier", "max_output_tokens", "truncation", "conversation", "prompt", "context_management",
    "max_tool_calls", "background_options", "moderation", "personality"]) {
    if (specified(body[key]) && !isJSONObject(body[key]) && !Array.isArray(body[key]) && !["string", "number", "boolean"].includes(typeof body[key])) {
      invalidResponseRequest(`${key} has an invalid value.`, key);
    }
  }
  const include = responseArray(body.include);
  for (const key of include) if (!supportedIncludes.has(key)) invalidResponseRequest(`Unsupported include value: ${String(key)}.`, "include");
  const rawInput = [...history, ...normalizeResponseInput(body.input, history)].map((item) => hostedHistoryTypes.has(item.type)
    ? { id: item.id, type: "message", role: "assistant", content: [{ type: "output_text", text: hostedSearchText(item) }], status: "completed" } : item);
  const input = await expandAttachments(rawInput);
  if (input.length > 10_000 || Buffer.byteLength(JSON.stringify(input)) > MAX_RESPONSES_INPUT) {
    throw new ResponsesError(400, "context_length_exceeded", "The Responses replay window is too large. Compact or shorten the input.", "input");
  }
  const instructions = responseText(body.instructions);
  const { messages } = chatMessages(input, compact ? "" : instructions, codec);
  if (!messages.length) invalidResponseRequest("An input item or instructions is required.", "input");
  const chat: Obj = { model: body.model, messages, stream: !compact && body.stream === true };
  const { aliases } = toolDefinitions(compact ? undefined : body.tools);
  const result = { chat, aliases, input, offset: history.length, effectiveBody: body, omittedWebSearch, omittedTools };
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
  const permitted = filterToolDeclarations(body.tools, body.tool_choice, aliases);
  const permittedTools = toolDefinitions(permitted).chat;
  if (permittedTools.length) chat.tools = permittedTools;
  if (specified(body.tool_choice)) {
    const rawChoice = responseObject(body.tool_choice);
    const choice = hostedWebSearchTypes.has(rawChoice.type) || hostedDiscoveryTypes.has(rawChoice.type) ? "auto" : toChatToolChoice(body.tool_choice, aliases);
    if (permittedTools.length || choice === "none") chat.tool_choice = choice;
    // With no callable tools, forcing hosted search degrades to an ordinary
    // response; auto/none are likewise omitted for strict Chat providers.
  }
  if (include.includes("message.output_text.logprobs") || specified(body.top_logprobs)) chat.logprobs = true;
  if (chat.stream) chat.stream_options = { include_usage: true };
  return result;
}
