import { responseArray, responseObject, responseText } from "./responses-http";
import { encode } from "gpt-tokenizer";

// A documented local estimate: Responses input_tokens remains callable without a
// native tokenizer, while generation usage continues to report upstream totals.
function textTokens(text: string) {
  return text ? encode(text).length : 0;
}

function contentTokens(content: unknown) {
  if (typeof content === "string") return textTokens(content);
  return responseArray(content).map(responseObject).reduce((sum, part) => {
    const image = part.image_url;
    const url = typeof image === "string" ? image : responseText(responseObject(image).url);
    return sum + textTokens(responseText(part.text ?? part.refusal)) + (url ? (part.detail === "low" ? 85 : 765) : 0);
  }, 0);
}

export function estimateResponseTokens(input: unknown, instructions: string, tools: unknown) {
  const items = typeof input === "string" ? [{ role: "user", content: input }] : responseArray(input).map(responseObject);
  let total = textTokens(instructions);
  for (const item of items) {
    total += 4 + textTokens(responseText(item.role ?? item.type));
    total += contentTokens(item.content ?? item.output ?? item.input ?? item.arguments);
    if (item.type !== "message") total += textTokens(JSON.stringify(item));
  }
  for (const tool of responseArray(tools).map(responseObject)) {
    total += 8 + textTokens(responseText(tool.name)) + textTokens(responseText(tool.description));
    total += textTokens(JSON.stringify(tool.parameters ?? tool.format ?? {}));
    if (tool.type === "namespace") {
      for (const child of responseArray(tool.tools)) total += textTokens(JSON.stringify(child));
    }
  }
  return Math.max(0, total);
}
