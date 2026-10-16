// Prisma 单例：Next.js dev 热重载会反复执行模块，挂在 globalThis 上避免连接池爆炸。
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForDb = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL 未配置");
  }
  const adapter = new PrismaPg({ connectionString: url });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForDb.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForDb.prisma = prisma;
}
