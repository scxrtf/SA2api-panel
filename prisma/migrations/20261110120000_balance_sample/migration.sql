-- BalanceSample 余额采样表；与 prisma/schema.prisma 保持一致。
CREATE TABLE IF NOT EXISTS "BalanceSample" (
  "id" TEXT NOT NULL,
  "uid" TEXT NOT NULL,
  "credits" BIGINT NOT NULL,
  "day" TEXT NOT NULL DEFAULT '',
  "first" BIGINT NOT NULL DEFAULT 0,
  "consumed" BIGINT NOT NULL DEFAULT 0,
  "gained" BIGINT NOT NULL DEFAULT 0,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BalanceSample_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "BalanceSample_uid_at_idx" ON "BalanceSample"("uid", "at");
CREATE INDEX IF NOT EXISTS "BalanceSample_at_idx" ON "BalanceSample"("at");
