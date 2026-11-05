// GET /api/panel/request_logs/[id] — 按需读取诊断详情，不读取对话正文。
import { fail, ok, panelAuth } from "@/lib/panel-auth";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Egress guard: this endpoint is the only one that returns the heavy Json columns.
// Keep the shape the panel expects, but never ship an unbounded body.
const MAX_TEXT = 64_000;
const MAX_JSON_STRING = 8_000;
const MAX_JSON_DEPTH = 8;
const MAX_JSON_ARRAY = 200;
const MAX_ERROR_DETAIL = 8_000;
const MAX_ATTEMPT_ERROR = 2_000;

const DETAIL_SELECT = {
  id: true,
  at: true,
  uid: true,
  model: true,
  realm: true,
  provider: true,
  status: true,
  errKind: true,
  errMsg: true,
  stream: true,
  durationMs: true,
  ttfbMs: true,
  attempts: true,
  promptTokens: true,
  completionTok: true,
  totalTokens: true,
  credit: true,
  hasCredit: true,
  cacheHitTok: true,
  cacheMissTok: true,
  clientIp: true,
  ua: true,
  keyName: true,
  slot: true,
  machineId: true,
  path: true,
  errorDetail: true,
  parameterOverrides: true,
  attemptDetails: true,
} as const;

function clipText(value: string, max: number): string {
  if (!value) return value;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…[truncated ${value.length - max} chars]`;
}

// Recursively bound Json columns. Strings are the egress risk (base64 images,
// long tool payloads, upstream HTML errors); arrays are capped to keep a single
// log expansion from returning megabytes.
function clipJson(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return clipText(value, MAX_JSON_STRING);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_JSON_DEPTH) return "[truncated: depth]";
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_JSON_ARRAY).map((item) => clipJson(item, depth + 1));
    if (value.length > MAX_JSON_ARRAY) out.push(`[truncated ${value.length - MAX_JSON_ARRAY} items]`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = clipJson(item, depth + 1);
  }
  return out;
}

function clipAttempts(value: unknown): unknown {
  if (!Array.isArray(value)) return clipJson(value);
  return value.slice(0, MAX_JSON_ARRAY).map((item) => {
    const row = clipJson(item);
    if (row && typeof row === "object" && !Array.isArray(row) && typeof (row as Record<string, unknown>).error === "string") {
      const rec = row as Record<string, unknown>;
      rec.error = clipText(rec.error as string, MAX_ATTEMPT_ERROR);
    }
    return row;
  });
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await panelAuth(req);
  if (auth) return auth;

  const { id } = await ctx.params;
  if (!id) return fail(404, "request_log_not_found");

  const entry = await prisma.requestLog.findUnique({
    where: { id },
    select: DETAIL_SELECT,
  });
  if (!entry) return fail(404, "request_log_not_found");
  return ok({
    entry: {
      ...entry,
      errMsg: clipText(entry.errMsg, MAX_TEXT),
      errorDetail: clipText(entry.errorDetail, MAX_ERROR_DETAIL),
      parameterOverrides: clipJson(entry.parameterOverrides),
      attemptDetails: clipAttempts(entry.attemptDetails),
    },
  });
}
