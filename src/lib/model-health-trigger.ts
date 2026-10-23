import type { Prisma } from "@prisma/client";
import { getConfig } from "./config";
import { prisma } from "./db";
import { runlog } from "./runlog";

export interface ModelCallRoute {
  realm: string;
  provider: string;
  bare: string;
}

interface TriggerState {
  running: Set<string>;
}

const g = globalThis as unknown as { __wbModelHealthTriggers?: TriggerState };
const state: TriggerState = g.__wbModelHealthTriggers ?? (g.__wbModelHealthTriggers = {
  running: new Set(),
});

export function modelHealthKey(route: ModelCallRoute): string {
  if (route.provider) return route.provider + ":" + route.bare;
  return (route.realm || "cn") + ":" + route.bare;
}

// maybeProbeAfterModelCall 在该模型自上次健康检查后的真实调用数达到阈值时，
// 异步触发一次最小聊天探测。RequestLog 必须已成功落库后再调用本函数。
export async function maybeProbeAfterModelCall(route: ModelCallRoute): Promise<void> {
  const modelKey = modelHealthKey(route);
  if (!route.bare || state.running.has(modelKey)) return;

  state.running.add(modelKey);
  try {
    const cfg = await getConfig();
    const every = cfg.schedule_model_health_every_calls;
    if (!Number.isInteger(every) || every <= 0) return;

    const latest = await prisma.modelHealthCheck.findFirst({
      where: { modelKey },
      orderBy: { checkedAt: "desc" },
      select: { checkedAt: true },
    });
    const models = [...new Set([
      route.bare,
      route.provider
        ? route.provider + ":" + route.bare
        : route.realm + ":" + route.bare,
    ])];
    const where: Prisma.RequestLogWhereInput = {
      model: { in: models },
      ...(latest ? { at: { gt: latest.checkedAt } } : {}),
      ...(route.provider
        ? { provider: route.provider }
        : { realm: route.realm || "cn" }),
    };
    const calls = await prisma.requestLog.count({ where });
    if (calls < every) return;

    runlog(
      "[probe] " + modelKey + " 调用计数达到 " + calls + "/" + every +
      "，触发 call-count 探测",
    );
    const { runModelHealthProbe } = await import("./modelhealth");
    await runModelHealthProbe("call-count", modelKey);
  } catch (e) {
    runlog("WARN: call-count probe trigger " + modelKey + ": " + errMsg(e));
  } finally {
    state.running.delete(modelKey);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
