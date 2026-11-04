// 面板机器码与建 Key 授权：机器码用 HttpOnly cookie 持久化，服务端记录授权。
import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { prisma } from "./db";

export const MACHINE_COOKIE = "wb2a_machine_id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function verifyMachinePassword(input: unknown): boolean {
  if (typeof input !== "string") return false;
  const actual = createHash("sha256").update(input, "utf8").digest();
  const expected = createHash("sha256").update("123456asd", "utf8").digest();
  return timingSafeEqual(actual, expected);
}

// 只在面板鉴权通过后调用，避免公开接口任意创建机器记录。
export async function getOrCreateMachineId(): Promise<{ id: string; isNew: boolean }> {
  const store = await cookies();
  const current = store.get(MACHINE_COOKIE)?.value ?? "";
  if (UUID_RE.test(current)) return { id: current, isNew: false };
  const id = randomUUID();
  store.set(MACHINE_COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 365 * 24 * 3600,
  });
  return { id, isNew: true };
}

export async function machineKeyAuthorized(machineId: string): Promise<boolean> {
  const row = await prisma.machineKeyAuthorization.findUnique({
    where: { machineId },
    select: { method: true, uid: true, account: { select: { uid: true } } },
  });
  return row?.method === "password" || (row?.method === "account" && !!row.account);
}

export async function authorizeMachineForAccount(machineId: string, uid: string): Promise<void> {
  const account = await prisma.account.findUnique({ where: { uid }, select: { uid: true } });
  if (!account) return;
  await prisma.machineKeyAuthorization.upsert({
    where: { machineId },
    create: { machineId, uid, method: "account" },
    update: { uid, method: "account" },
  });
}

export async function authorizeMachineByPassword(machineId: string): Promise<void> {
  // uid=null 表示独立密码授权；显式断开账号关系，防止旧外键残留。
  await prisma.machineKeyAuthorization.upsert({
    where: { machineId },
    create: { machineId, method: "password" },
    update: { method: "password", account: { disconnect: true } },
  });
}
