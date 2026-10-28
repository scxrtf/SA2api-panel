// 配置保存类型回归（离线，无网络）。
import assert from "node:assert/strict";
import { saveConfig } from "../src/lib/config.ts";

const globalWithDb = globalThis as typeof globalThis & { prisma?: unknown };
const oldPrisma = globalWithDb.prisma;
let saved = "";

try {
  globalWithDb.prisma = {
    setting: {
      findUnique: async () => null,
      upsert: async ({ create, update }: {
        create: { value: string }; update: { value: string };
      }) => {
        saved = update.value || create.value;
        return { key: "config", value: saved };
      },
    },
  };
  const cfg = await saveConfig({
    model_fallback: { " cn:model-a ": "model-b" },
    pool_wait_ms: 15_000,
    pool_wait_poll_ms: 200,
  });
  assert.deepEqual(cfg.model_fallback, { "cn:model-a": "model-b" });
  assert.deepEqual(JSON.parse(saved).model_fallback, { "cn:model-a": "model-b" });
  await assert.rejects(saveConfig({ model_fallback: { "model-a": 123 } }),
    /非空字符串/);
  console.log("PASS model_fallback object saves correctly and rejects invalid values");
} finally {
  if (oldPrisma === undefined) delete globalWithDb.prisma;
  else globalWithDb.prisma = oldPrisma;
}
