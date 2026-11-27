"use client";

export class WorkspaceHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function requestWorkspace(path = "", init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch("/api/workspace" + path, { cache: "no-store", ...init, headers });
  if (!response.ok) {
    const body: { error?: string } = await response.json().catch(() => ({}));
    throw new WorkspaceHttpError(body.error ?? `工作区请求失败（${response.status}）`, response.status);
  }
  return response;
}

export async function readWorkspaceStream(response: Response, consume: (type: string, value: unknown) => void) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("未收到工作区事件流。");
  let pending = "";
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 8 * 1024 * 1024) throw new Error("工作区事件过大。");
      let end = -1;
      while ((end = pending.indexOf("\n\n")) >= 0) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const lines = frame.split("\n");
        const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
        const data = lines.filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
        if (event && data) consume(event, JSON.parse(data));
      }
    }
  } finally { reader.releaseLock(); }
}
