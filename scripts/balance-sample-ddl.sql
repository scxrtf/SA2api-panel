-- BalanceSample 建表（prisma db push 会因无关的 errMsg 漂移告警而阻塞，故直接执行本 DDL）。
CREATE TABLE IF NOT EXISTS "BalanceSample" (
  "id" TEXT NOT NULL,
  "uid" TEXT NOT NULL DEFAULT '',
  "credits" BIGINT NOT NULL DEFAULT 0,
  "day" TEXT NOT NULL DEFAULT '',
  "first" BIGINT NOT NULL DEFAULT 0,
  "consumed" BIGINT NOT NULL DEFAULT 0,
  "gained" BIGINT NOT NULL DEFAULT 0,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BalanceSample_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BalanceSample_uid_at_idx" ON "BalanceSample"("uid", "at");
CREATE INDEX IF NOT EXISTS "BalanceSample_at_idx" ON "BalanceSample"("at");
