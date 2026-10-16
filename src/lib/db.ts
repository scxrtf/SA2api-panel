// Prisma 单例：懒初始化 Proxy。
// 为什么不是模块加载即建连：Next build 的 page data 收集会 import 到本模块，
// 构建机上不需要也不该要求 DATABASE_URL；真正的校验推迟到运行期首次查询。
// Next dev 热重载会反复执行模块，挂在 globalThis 上避免连接池爆炸。
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForDb = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL 未配置（部署时由 Postgres 插件注入，或写入 .env）");
  }
  const adapter = new PrismaPg({ connectionString: url });
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
    const client = getClient() as unknown as Record<PropertyKey, unknown>;
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? (value as Function).bind(client) : value;
  },
});
