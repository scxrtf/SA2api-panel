import assert from "node:assert/strict";
import { Socket } from "node:net";
import test from "node:test";
import { prisma } from "../src/lib/db.ts";
import { officialEgress } from "../src/lib/upstream/official-egress.ts";

const isolated = process.env.WB2API_OFFLINE_TEST === "1";

test("离线测试兜底拦截未打桩的外网 fetch 与官方出口", { skip: !isolated }, async () => {
  await assert.rejects(fetch("https://example.invalid/"), /offline test blocked network/);
  await assert.rejects(officialEgress("https://example.invalid/"), /offline test blocked network/);
});

test("离线测试拦截底层 TCP 外连，不进入 DNS 或连接阶段", { skip: !isolated }, () => {
  const socket = new Socket();
  try {
    assert.throws(() => socket.connect(443, "example.invalid"), /offline test blocked TCP connection/);
  } finally {
    socket.destroy();
  }
});

test("离线测试未提供数据库夹具时故障关闭", { skip: !isolated }, async () => {
  await assert.rejects(prisma.account.findMany(), /offline test requires DB fixture/);
});
