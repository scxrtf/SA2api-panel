import { enabled, WorkspaceError } from "./settings";

export const json = (value: unknown, status = 200) => Response.json(value, {
  status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
});
export async function workspaceGuard(req: Request) {
  void req;
  if (!enabled()) return json({ error: "工作区尚未在服务端启用。" }, 404);
  return null;
}
export function workspaceError(error: unknown) {
  if (error instanceof WorkspaceError) return json({ error: error.message }, error.status);
  console.error("[workspace]", error instanceof Error ? error.name : "UnknownError");
  return json({ error: "工作区读写失败，请查看服务端日志。" }, 500);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
export async function readJson(req: Request, limit = 96 * 1024) {
  const reader = req.body?.getReader();
  if (!reader) throw new WorkspaceError("请求正文为空。");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new WorkspaceError("请求超过大小上限。", 413);
      }
      chunks.push(value);
    }
    try {
      const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return object(parsed);
    } catch {
      throw new WorkspaceError("请求正文不是有效 JSON。");
    }
  } finally { reader.releaseLock(); }
}
export function identifier(value: unknown, optional = false) {
  if (optional && (value === undefined || value === "")) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_:-]{1,160}$/.test(value)) throw new WorkspaceError("标识无效。");
  return value;
}
