import { json, workspaceError, workspaceGuard } from "@/lib/workspace/http";
import { gatewayStore } from "@/lib/workspace/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const guard = await workspaceGuard(req);
    if (guard) return guard;
    const raw = new URL(req.url).searchParams.get("after") ?? req.headers.get("last-event-id") ?? "0";
    let cursor = Number(raw);
    if (!/^\d{1,15}$/.test(raw) || !Number.isSafeInteger(cursor)) return json({ error: "事件游标无效。" }, 400);
    const store = gatewayStore();
    store.reapGateway();
    const fence = store.cursor();
    if (cursor > fence) return json({ error: "事件历史已变更，请刷新。" }, 409);
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | undefined;
    let close: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const opened = Date.now();
        let lastHeartbeat = 0;
        let caughtUp = false;
        let closed = false;
        const clean = () => {
          if (timer) clearInterval(timer);
          req.signal.removeEventListener("abort", end);
        };
        const end = () => {
          if (closed) return;
          closed = true;
          clean();
          controller.close();
        };
        close = () => { closed = true; clean(); };
        const tick = () => {
          if (closed) return;
          if (req.signal.aborted || Date.now() - opened >= 55_000) { end(); return; }
          if ((controller.desiredSize ?? 0) <= 0) return;
          try {
            let text = "";
            const frame = (type: string, data: unknown, seq?: number) => {
              text += (seq ? `id: ${seq}\n` : "") + `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
            };
            const markLive = () => {
              if (!caughtUp) { caughtUp = true; frame("live", { cursor: fence }); }
            };
            if (cursor >= fence) markLive();
            for (const event of store.events(cursor, 48)) {
              if (event.seq > fence) markLive();
              frame("workspace", event, event.seq);
              cursor = event.seq;
            }
            if (cursor >= fence) markLive();
            if (Date.now() - lastHeartbeat >= 4000) {
              lastHeartbeat = Date.now();
              store.reapGateway();
              text += ": keepalive\n\n";
            }
            if (text) controller.enqueue(encoder.encode(text));
          } catch {
            end();
          }
        };
        req.signal.addEventListener("abort", end, { once: true });
        timer = setInterval(tick, 250);
        tick();
      },
      cancel() { close?.(); },
    });
    return new Response(stream, { headers: {
      "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "private, no-cache, no-store, no-transform",
      "X-Accel-Buffering": "no", "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return workspaceError(error); }
}
