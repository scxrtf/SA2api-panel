import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

const COOKIE = "wb2a_local_panel";
const AGE_SECONDS = 30 * 60;
const loopback = (address?: string) => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
function localHost(host?: string | null) {
  const match = host && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::([1-9][0-9]{0,4}))?$/i.exec(host);
  return match && (!match[1] || Number(match[1]) <= 65535) ? match[0].toLowerCase() : null;
}
const methodHasOrigin = (method: string) => method !== "GET" && method !== "HEAD";

function signingKey() {
  if (process.env.NODE_ENV !== "development" || process.env.WB2_PANEL_LOCAL_ACCESS !== "1") return undefined;
  const value = process.env.WB2_PANEL_LOCAL_SESSION_SECRET;
  return value && /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : undefined;
}

export function localPanelEnabled() {
  return !!signingKey();
}

function matchingFetchSite(value?: string | null) {
  return !value || value === "same-origin" || value === "none";
}

export function isDirectLocalBootstrap({
  remoteAddress, localAddress, localPort, headers,
}: {
  remoteAddress?: string;
  localAddress?: string;
  localPort?: number;
  headers: IncomingHttpHeaders;
}) {
  if (!loopback(remoteAddress) || !loopback(localAddress)) return false;
  const host = localHost(headers.host);
  if (!host || typeof headers.origin !== "string" || headers.origin !== "http://" + host) return false;
  const port = Number(new URL("http://" + host).port || "80");
  if (port !== localPort || headers["x-wb2a-local-panel"] !== "1") return false;
  const site = headers["sec-fetch-site"];
  if (Array.isArray(site) || !matchingFetchSite(site)) return false;
  // Next fills the x-forwarded headers for direct requests. Disagreeing hints
  // or a proxy chain are not eligible for local session issuance.
  const forwarded = headers["x-forwarded-for"];
  return !headers.forwarded && !headers["x-real-ip"] && !headers.via &&
    (forwarded === undefined || typeof forwarded === "string" && loopback(forwarded)) &&
    (headers["x-forwarded-host"] === undefined || headers["x-forwarded-host"] === host) &&
    (headers["x-forwarded-proto"] === undefined || headers["x-forwarded-proto"] === "http");
}

const signature = (key: Buffer, host: string, expiry: number) =>
  createHmac("sha256", key).update(`wb2a-panel-v1:${host}:${expiry}`).digest("base64url");

export function issueLocalPanelCookie(hostHeader: string | undefined, now = Date.now()) {
  const key = signingKey();
  const host = localHost(hostHeader);
  if (!key || !host) return undefined;
  const expiry = Math.floor(now / 1000) + AGE_SECONDS;
  return `${COOKIE}=${expiry}.${signature(key, host, expiry)}; Path=/api; Max-Age=${AGE_SECONDS}; HttpOnly; SameSite=Strict`;
}

export function verifyLocalPanelSession(req: Request, now = Date.now()) {
  const key = signingKey();
  const host = localHost(req.headers.get("host"));
  if (!key || !host || !matchingFetchSite(req.headers.get("sec-fetch-site"))) return false;
  const origin = req.headers.get("origin");
  if ((origin || methodHasOrigin(req.method)) && origin !== "http://" + host) return false;
  const token = req.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
  if (!token || !/^\d{10,13}\.[\w-]{43}$/.test(token)) return false;
  const [raw, mac] = token.split(".");
  const expires = Number(raw);
  if (!Number.isSafeInteger(expires) || expires <= Math.floor(now / 1000) || expires > Math.floor(now / 1000) + AGE_SECONDS) return false;
  return timingSafeEqual(Buffer.from(mac), Buffer.from(signature(key, host, expires)));
}
