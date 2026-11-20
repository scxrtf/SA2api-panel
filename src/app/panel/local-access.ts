"use client";

let attempt: Promise<boolean> | undefined;
let validUntil = 0;
let retryAfter = 0;

function inLocalBrowser() {
  if (typeof window === "undefined") return false;
  const location = window.location;
  return location?.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname);
}

function ensureLocalPanelSession(force = false) {
  if (!inLocalBrowser()) return Promise.resolve(false);
  if (attempt) return attempt;
  const now = Date.now();
  if (!force && now < validUntil) return Promise.resolve(true);
  if (now < retryAfter) return Promise.resolve(false);
  attempt = fetch("/api/panel-local-session", {
    method: "POST", headers: { "X-WB2A-Local-Panel": "1" }, credentials: "same-origin",
    cache: "no-store", signal: AbortSignal.timeout(3000),
  }).then((response) => {
    if (response.status !== 204) { retryAfter = Date.now() + 60_000; return false; }
    validUntil = Date.now() + 25 * 60_000;
    return true;
  }).catch(() => {
    retryAfter = Date.now() + 8000;
    return false;
  }).finally(() => { attempt = undefined; });
  return attempt;
}

export async function panelFetch(path: string, init?: RequestInit) {
  const local = await ensureLocalPanelSession();
  const response = await fetch(path, init);
  const method = init?.method ?? "GET";
  if (local && !init?.signal?.aborted && (method === "GET" || method === "HEAD") && response.status === 401 && await ensureLocalPanelSession(true)) {
    await response.body?.cancel().catch(() => undefined);
    return fetch(path, init);
  }
  return response;
}
