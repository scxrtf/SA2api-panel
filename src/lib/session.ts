// 会话粘性路由 + 会话/轮级键派生（移植 internal/session/ids.go + session.go）。
//
// 差异：Go 是内存 Router + redisstore 镜像；本实现持久化到 StickySession 表
//（DB 即权威，TTL 30m 滚动续期，惰性过期）。双段分配（空闲账号优先 → 全池哈希）
// 与 ResolveForModel 语义保持一致。
import { createHash } from "crypto";
import { prisma } from "./db";
import { availableUIDsForModel } from "./pool";
import { requestIDForKey } from "./upstream/client";

const STICKY_TTL_MS = 30 * 60_000;

type Obj = Record<string, unknown>;

function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// ─── 键提取（ids.go ExtractKey / ResolveConversationID / TurnKey） ────────

// resolveConversationID 只认 conversationId（snake/camel），绝不回落 user_id。
export function resolveConversationID(body: Obj): string {
  const meta = body["metadata"];
  if (meta && typeof meta === "object") {
    const m = meta as Obj;
    if (strOrEmpty(m["conversation_id"])) return strOrEmpty(m["conversation_id"]);
    if (strOrEmpty(m["conversationId"])) return strOrEmpty(m["conversationId"]);
  }
  if (strOrEmpty(body["conversation_id"])) return strOrEmpty(body["conversation_id"]);
  return strOrEmpty(body["conversationId"]);
}

// contentSignature 消息 content 的确定性签名（G1 修复口径）：
// string → 原文；数组 → 文本 part 无缝拼接 + 非文本 part "[type:sha256前8hex]"。
export function contentSignature(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  let b = "";
  let hasNonText = false;
  for (const pr of raw) {
    if (!pr || typeof pr !== "object") return "";
    const p = pr as Obj;
    const t = strOrEmpty(p["type"]);
    if (t === "" || t === "text") {
      b += strOrEmpty(p["text"]);
      continue;
    }
    hasNonText = true;
    const sum = createHash("sha256").update(JSON.stringify(pr), "utf8").digest("hex");
    b += `\n[${t}:${sum.slice(0, 8)}]\n`;
  }
  return hasNonText ? b.trim() : b;
}

// turnKey 派生轮级聚合键：最后一条 user 消息的「序号 + 内容签名」。
export function turnKey(body: Obj): string {
  const msgs = body["messages"];
  if (!Array.isArray(msgs)) return "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || typeof m !== "object") continue;
    if ((m as Obj)["role"] !== "user") continue;
    const sig = contentSignature((m as Obj)["content"]);
    if (sig === "") return ""; // 不往前找：位置恒定，往前会让键漂移
    return `u${i}:${sig}`;
  }
  return "";
}

// extractKey 会话粘性键（优先级：metadata.conversation_id > conversationId >
// 顶层同名 > prompt_cache_key > 派生 d-<hash>；带 user_id 不派生）。
export function extractKey(body: Obj): string {
  const convID = resolveConversationID(body);
  if (convID) return convID;
  if (strOrEmpty(body["prompt_cache_key"])) return strOrEmpty(body["prompt_cache_key"]);
  // 派生回退闸：带 user 维度标识的请求不派生。
  const meta = body["metadata"];
  if (meta && typeof meta === "object" && strOrEmpty((meta as Obj)["user_id"])) return "";
  if (strOrEmpty(body["user_id"])) return "";
  return deriveKey(body);
}

// deriveKey SHA-256(system 文本 + 首条 user 签名) 前 16 字节 hex，前缀 d-。
export function deriveKey(body: Obj): string {
  const msgs = body["messages"];
  if (!Array.isArray(msgs) || msgs.length === 0) return "";
  let systemText = "";
  let firstUserText = "";
  for (const m of msgs) {
    if (!m || typeof m !== "object") continue;
    const msg = m as Obj;
    const role = strOrEmpty(msg["role"]);
    if ((role === "system" || role === "developer") && systemText === "") {
      const c = msg["content"];
      systemText = typeof c === "string" ? c : contentSignature(c);
    } else if (role === "user" && firstUserText === "") {
      firstUserText = contentSignature(msg["content"]);
    }
  }
  if (firstUserText === "") return "";
  const sum = createHash("sha256").update(systemText + "|" + firstUserText, "utf8").digest("hex");
  return "d-" + sum.slice(0, 32);
}

// ─── 粘性绑定（Router.ResolveForModel / Bind / Unbind） ───────────────────

// hashIndex sha256(key) 前 8 字节对 n 取模（Go hashIndex 同语义）。
function hashIndex(key: string, n: number): number {
  const sum = createHash("sha256").update(key, "utf8").digest();
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(sum[i]);
  return Number(v % BigInt(n));
}

// resolveSticky 返回会话 key 在该模型上应绑定的 uid；绑定号不可用则重分配
//（双段：空闲号优先，其次全池哈希）。无可用 → null。
export async function resolveSticky(key: string, model: string, realm = ""): Promise<string | null> {
  if (!key) return null;
  const now = Date.now();
  const avail = new Set(await availableUIDsForModel(model, realm));
  const existing = await prisma.stickySession.findUnique({ where: { key } });
  if (
    existing &&
    now - existing.updatedAt.getTime() < STICKY_TTL_MS &&
    avail.has(existing.uid)
  ) {
    // 命中 + 可用 → 滚动续期（空 set 触发 @updatedAt）。
    await prisma.stickySession.update({ where: { key }, data: { uid: existing.uid } });
    return existing.uid;
  }
  if (existing) {
    await prisma.stickySession.delete({ where: { key } }).catch(() => undefined);
  }
  const uids = [...avail].sort();
  if (uids.length === 0) return null;
  // 双段策略：未被任何会话绑定的可用号优先。
  const boundRows = await prisma.stickySession.findMany({ select: { uid: true } });
  const bound = new Set(boundRows.map((r) => r.uid));
  const idle = uids.filter((u) => !bound.has(u));
  const pool2 = idle.length > 0 ? idle : uids;
  const uid = pool2[hashIndex(key, pool2.length)];
  await prisma.stickySession.upsert({
    where: { key },
    create: { key, uid },
    update: { uid },
  });
  return uid;
}

// bindSticky 显式绑定（幂等覆盖）；粘性跟随最终成功号。
export async function bindSticky(key: string, uid: string): Promise<void> {
  if (!key || !uid) return;
  await prisma.stickySession.upsert({
    where: { key },
    create: { key, uid },
    update: { uid },
  });
}

// unbindSticky 解除绑定（请求失败时调用）。
export async function unbindSticky(key: string): Promise<void> {
  if (!key) return;
  await prisma.stickySession.delete({ where: { key } }).catch(() => undefined);
}

// gcSticky 清理过期绑定（cron 调用）。
export async function gcSticky(): Promise<number> {
  const cutoff = new Date(Date.now() - STICKY_TTL_MS);
  const r = await prisma.stickySession.deleteMany({ where: { updatedAt: { lt: cutoff } } });
  return r.count;
}

// 轮级聚合 ID 复用 upstream/client 的派生实现（同盐同口径）。
export { requestIDForKey };
