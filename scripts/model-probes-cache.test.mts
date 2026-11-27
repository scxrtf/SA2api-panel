import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { panelCacheDel } from "../src/lib/panel-cache.ts";

const model = "cn:offline";
const at = new Date("2026-01-01T00:00:00Z");
let row = { key: model, claimed: 12, measured: 8, verdict: "clamped", note: "", source: "offline", testedAt: at, updatedAt: at };
let probeReads = 0;
let healthReads = 0;
mock.module(new URL("../src/lib/db.ts", import.meta.url).href, {
  namedExports: { prisma: { modelProbe: {
    findMany: async () => { probeReads++; return [row]; },
    upsert: async ({ update }: { update: Partial<typeof row> }) => { row = { ...row, ...update }; },
  } } },
});
mock.module(new URL("../src/lib/modelhealth.ts", import.meta.url).href, {
  namedExports: { listModelHealth: async () => { healthReads++; return {}; } },
});
mock.module(new URL("../src/lib/panel-auth.ts", import.meta.url).href, {
  namedExports: { ok: (data: Record<string, unknown>) => Response.json(data) },
});

const { GET } = await import("../src/app/api/panel/model_probes/route.ts");
const { saveProbe } = await import("../src/lib/modelprobe.ts");
const get = (refresh = false) => GET(new Request("http://localhost/api/panel/model_probes" + (refresh ? "?refresh=1" : "")));

test("model probes share one snapshot and refresh or write invalidation reads fresh rows", async (t) => {
  t.after(() => panelCacheDel("model_probes"));
  const cold = await Promise.all([get(), get(), get()]);
  for (const response of cold) assert.equal((await response.json()).probes[model].measured, 8);
  assert.equal(probeReads, 1);
  assert.equal(healthReads, 1);

  row = { ...row, measured: 9 };
  const cached = await (await get()).json();
  assert.equal(cached.cached, true);
  assert.equal(cached.probes[model].measured, 8);
  assert.equal((await (await get(true)).json()).probes[model].measured, 9);
  assert.equal(probeReads, 2);

  await saveProbe(model, 12, { measured: 10, verdict: "clamped", note: "offline", elapsed_s: 1 });
  const updated = await (await get()).json();
  assert.equal(updated.cached, undefined);
  assert.equal(updated.probes[model].measured, 10);
  assert.equal(probeReads, 3);
  assert.equal(healthReads, 3);
});
