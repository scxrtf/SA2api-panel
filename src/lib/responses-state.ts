import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "./db";
import { MAX_RESPONSES_OUTPUT, ResponsesError, type ResponseObject } from "./responses-http";

export const bridgeBackend = "chat";
export const newResponseId = (prefix: string) => `${prefix}_wb2a_${randomUUID().replaceAll("-", "")}`;
export const responseDigest = (...parts: string[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const recordKey = (owner: string, id: string) => responseDigest("wb2a-response-v1", owner, id);
const retentionMs = 30 * 24 * 60 * 60 * 1000;
let lastPurge = 0;

export interface BridgeSnapshot {
  response: ResponseObject;
  input: ResponseObject[];
  // input is the full replay window. This index marks the items submitted on this turn.
  offset: number;
}

function storeFailure(): ResponsesError {
  return new ResponsesError(503, "responses_storage_unavailable", "Responses storage is unavailable. Apply the gateway migration, or send store:false for stateless requests.");
}

export async function fetchStoredResponse(owner: string, id: string) {
  try {
    return await prisma.gatewayResponse.findFirst({ where: {
      id: recordKey(owner, id), createdAt: { gte: new Date(Date.now() - retentionMs) },
    }, select: { backend: true, model: true, snapshot: true } });
  } catch { throw storeFailure(); }
}

export async function rememberResponse(owner: string, id: string, backend: string, model: string, snapshot?: BridgeSnapshot) {
  const data = { id: recordKey(owner, id), backend, model, snapshot: snapshot ? JSON.stringify(snapshot) : "" };
  if (Buffer.byteLength(data.snapshot) > MAX_RESPONSES_OUTPUT) {
    throw new ResponsesError(400, "context_length_exceeded", "This Responses history is too large to store. Compact it or replay a shorter window with store:false.", "input");
  }
  try {
    const select = { id: true };
    if (snapshot) await prisma.gatewayResponse.create({ data, select });
    else await prisma.gatewayResponse.upsert({ where: { id: data.id }, create: data, update: { backend, model }, select });
  } catch { throw storeFailure(); }
  if (Date.now() - lastPurge > 3_600_000) {
    lastPurge = Date.now();
    void prisma.gatewayResponse.deleteMany({ where: { createdAt: { lt: new Date(lastPurge - retentionMs) } } }).catch(() => undefined);
  }
}

export async function forgetResponse(owner: string, id: string) {
  try { return (await prisma.gatewayResponse.deleteMany({ where: { id: recordKey(owner, id) } })).count > 0; }
  catch { throw storeFailure(); }
}

export function readBridgeSnapshot(snapshot: string): BridgeSnapshot {
  try { return JSON.parse(snapshot) as BridgeSnapshot; }
  catch { throw storeFailure(); }
}

const runtime = globalThis as typeof globalThis & { wb2aResponsesCipherKey?: Buffer };
const blobPrefix = "wb2a1_";

// Self-contained chat-bridge state; store:false never needs a database write.
// The owner and item purpose are authenticated so blobs cannot cross keys or item types.
export function responsesCodec(owner: string, mainKey: string) {
  const secret = process.env.WB2A_RESPONSES_STATE_SECRET?.trim() || mainKey ||
    (runtime.wb2aResponsesCipherKey ??= randomBytes(32));
  const key = createHmac("sha256", secret).update("wb2a-responses-state-v1\0" + owner).digest();
  return {
    seal(purpose: "reasoning" | "compaction", text: string) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(purpose));
      const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return blobPrefix + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
    },
    open(purpose: "reasoning" | "compaction", value: string) {
      try {
        if (!value.startsWith(blobPrefix) || !/^[A-Za-z0-9_-]+$/.test(value.slice(blobPrefix.length))) throw new Error();
        const buf = Buffer.from(value.slice(blobPrefix.length), "base64url");
        if (buf.byteLength < 28) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
        decipher.setAAD(Buffer.from(purpose));
        decipher.setAuthTag(buf.subarray(12, 28));
        return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
      } catch {
        throw new ResponsesError(400, "invalid_encrypted_content", `This ${purpose} item cannot be replayed by this gateway key.`, "input");
      }
    },
  };
}

export type ResponsesCodec = ReturnType<typeof responsesCodec>;
