import assert from "node:assert/strict";
import test from "node:test";
import { isDirectLocalBootstrap, issueLocalPanelCookie, verifyLocalPanelSession } from "../src/lib/panel-local-session";

const host = "127.0.0.1:3291";
const origin = "http://" + host;
const socket = {
  remoteAddress: "::ffff:127.0.0.1", localAddress: "::ffff:127.0.0.1", localPort: 3291,
  headers: { host, origin, "x-wb2a-local-panel": "1", "sec-fetch-site": "same-origin", "x-forwarded-for": "::ffff:127.0.0.1", "x-forwarded-host": host },
};

test("local session issuance uses the actual peer, direct Host and same origin", () => {
  assert.equal(isDirectLocalBootstrap(socket), true);
  assert.equal(isDirectLocalBootstrap({ ...socket, remoteAddress: "192.168.1.99" }), false);
  assert.equal(isDirectLocalBootstrap({ ...socket, localAddress: "::" }), false);
  assert.equal(isDirectLocalBootstrap({ ...socket, localPort: 80 }), false);
  assert.equal(isDirectLocalBootstrap({ ...socket, headers: { ...socket.headers, host: "127.0.0.1:99999" } }), false);
  assert.equal(isDirectLocalBootstrap({ ...socket, headers: { ...socket.headers, origin: "http://localhost:4000" } }), false);
  assert.equal(isDirectLocalBootstrap({ ...socket, headers: { ...socket.headers, "sec-fetch-site": "cross-site" } }), false);
  assert.equal(isDirectLocalBootstrap({ ...socket, headers: { ...socket.headers, "x-forwarded-for": "127.0.0.1, 192.168.1.99" } }), false);
  assert.equal(isDirectLocalBootstrap({ ...socket, headers: { ...socket.headers, via: "proxy" } }), false);
});

test("panel cookie is development-only, expiring, authenticated and bound to origin", (t) => {
  const env = { NODE_ENV: "development", WB2_PANEL_LOCAL_ACCESS: "1", WB2_PANEL_LOCAL_SESSION_SECRET: "35".repeat(32) };
  for (const [key, value] of Object.entries(env)) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  }
  const now = 1_800_000_000_000;
  const issued = issueLocalPanelCookie(host, now);
  assert.match(issued ?? "", /Path=\/api; Max-Age=1800; HttpOnly; SameSite=Strict/);
  const cookie = issued!.split(";")[0];
  const req = (method = "GET", headers: HeadersInit = { host, cookie }) => new Request(origin + "/api/workspace", { method, headers });
  assert.equal(verifyLocalPanelSession(req(), now), true);
  assert.equal(verifyLocalPanelSession(req("POST", { host, cookie, origin }), now), true);
  assert.equal(verifyLocalPanelSession(req("POST"), now), false);
  assert.equal(verifyLocalPanelSession(req("POST", { host, cookie, origin: "http://127.0.0.1:4444" }), now), false);
  assert.equal(verifyLocalPanelSession(req("GET", { host: "127.0.0.1:4444", cookie }), now), false);
  assert.equal(verifyLocalPanelSession(req("GET", { host, cookie: cookie.replace(/.$/, cookie.endsWith("A") ? "B" : "A") }), now), false);
  assert.equal(verifyLocalPanelSession(req(), now + 1_800_000), false);
  process.env["NODE_ENV"] = "production";
  assert.equal(issueLocalPanelCookie(host, now), undefined);
  assert.equal(verifyLocalPanelSession(req(), now), false);
});
