import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { sanitizeRequestLogData } from "./request-log-detail";

export async function createRequestLog(data: Prisma.RequestLogUncheckedCreateInput) {
  const clean = sanitizeRequestLogData(data);
  const create = (row: Prisma.RequestLogUncheckedCreateInput) => prisma.requestLog.create({ data: row, select: { id: true } });
  try {
    return await create(clean);
  } catch (error) {
    // During a staggered rollout preserve the flat audit row if the new column is missing.
    const message = error instanceof Error ? error.message : "";
    const code = (error as { code?: string } | null)?.code;
    if (!clean.sessionId || !message.includes("sessionId") || (code !== "P2022" && !message.includes("PGRST204"))) throw error;
    const legacy = { ...clean };
    delete legacy.sessionId;
    return create(legacy);
  }
}
