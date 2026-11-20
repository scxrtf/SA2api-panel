// HTTP JSON 边界：类型断言不会校验运行期的 null / 数组 / 标量。
export function isJSONObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function chatRequestError(body: Record<string, unknown>): string | null {
  if (typeof body.model !== "string" || !body.model.trim()) return "model is required";
  if (!Array.isArray(body.messages) || body.messages.length === 0) return "messages must be a non-empty array";
  if (body.messages.some((message) => !isJSONObject(message) || typeof message.role !== "string" || !message.role.trim())) {
    return "each message must be an object with a role";
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") return "stream must be a boolean";
  return null;
}
