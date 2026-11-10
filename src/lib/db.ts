// Prisma 单例：懒初始化 Proxy。
// 为什么不是模块加载即建连：Next build 的 page data 收集会 import 到本模块，
// 构建机上不需要也不该要求 DATABASE_URL；真正的校验推迟到运行期首次查询。
// Next dev 热重载会反复执行模块，挂在 globalThis 上避免连接池爆炸。
//
// 双通道：USE_CLOUDBASE_REST=1 时 prisma 实为 CloudBase PostgREST DAL（dal.ts），
// 既有调用点零改动切流；不支持的形态（$queryRaw）在该通道下抛错，由调用方
// 保留 Prisma 直连。USE_CLOUDBASE_REST 缺省/为 0 时维持原 Prisma 直连 Supabase。
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { dal } from "./dal";
import { isCloudbaseRestEnabled } from "./cloudbase-rest";

const globalForDb = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL 未配置（部署时由 Postgres 插件注入，或写入 .env）");
  }
  // Supabase 免费档按连接数计费/限额，且连接池过大会放大 pg 侧往返与内存。
  // 单容器语义下 3 条足够（面板 + 网关 + 调度器各占一条为主）。
  const adapter = new PrismaPg({ connectionString: url, max: 3 });
  return new PrismaClient({ adapter });
}

function getClient(): PrismaClient {
  if (!globalForDb.prisma) {
    globalForDb.prisma = createClient();
  }
  return globalForDb.prisma;
}

// Proxy 转发所有属性访问到真实 client；build 期无人解引用则不触发建连。
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    if (isCloudbaseRestEnabled()) {
      const d = (dal as unknown as Record<PropertyKey, unknown>)[prop];
      if (d !== undefined) return d;
    }
    const client = getClient() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(client) : value;
  },
});
