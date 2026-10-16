-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Account" (
    "uid" TEXT NOT NULL,
    "nickname" TEXT NOT NULL DEFAULT '',
    "realm" TEXT NOT NULL DEFAULT 'cn',
    "accessToken" TEXT NOT NULL DEFAULT '',
    "refreshToken" TEXT NOT NULL DEFAULT '',
    "expiresAt" BIGINT NOT NULL DEFAULT 0,
    "domain" TEXT NOT NULL DEFAULT '',
    "enterpriseId" TEXT NOT NULL DEFAULT '',
    "deviceToken" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("uid")
);

-- CreateTable
CREATE TABLE "AccountState" (
    "uid" TEXT NOT NULL,
    "credits" BIGINT NOT NULL DEFAULT 0,
    "total" BIGINT NOT NULL DEFAULT 0,
    "expiring" BIGINT NOT NULL DEFAULT 0,
    "earliestAt" BIGINT NOT NULL DEFAULT 0,
    "earliestRemain" BIGINT NOT NULL DEFAULT 0,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "disableReason" TEXT NOT NULL DEFAULT '',
    "disabledAt" BIGINT NOT NULL DEFAULT 0,
    "softStreak" INTEGER NOT NULL DEFAULT 0,
    "degradeUntil" BIGINT NOT NULL DEFAULT 0,
    "sessionDead" BOOLEAN NOT NULL DEFAULT false,
    "sessionStrikes" INTEGER NOT NULL DEFAULT 0,
    "cooldownUntil" BIGINT NOT NULL DEFAULT 0,
    "cooldownReason" TEXT NOT NULL DEFAULT '',
    "breakerFails" INTEGER NOT NULL DEFAULT 0,
    "breakerUntil" BIGINT NOT NULL DEFAULT 0,
    "lastUsed" BIGINT NOT NULL DEFAULT 0,
    "usedSeq" BIGINT NOT NULL DEFAULT 0,
    "lastCheckinDay" TEXT NOT NULL DEFAULT '',
    "balanceAt" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountState_pkey" PRIMARY KEY ("uid")
);

-- CreateTable
CREATE TABLE "ModelCooldown" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "until" BIGINT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelCooldown_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelCost" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "costPer1k" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tokens" INTEGER NOT NULL DEFAULT 0,
    "observedAt" BIGINT NOT NULL DEFAULT 0,
    "expiresAt" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ModelCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "realm" TEXT NOT NULL DEFAULT 'cn',
    "provider" TEXT NOT NULL DEFAULT '',
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTok" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "credit" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "errKind" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestLog" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "realm" TEXT NOT NULL DEFAULT '',
    "provider" TEXT NOT NULL DEFAULT '',
    "status" INTEGER NOT NULL DEFAULT 0,
    "errKind" TEXT NOT NULL DEFAULT '',
    "stream" BOOLEAN NOT NULL DEFAULT false,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "clientIp" TEXT NOT NULL DEFAULT '',
    "ua" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StickySession" (
    "key" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StickySession_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "LoginSession" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT '',
    "deviceCode" TEXT NOT NULL DEFAULT '',
    "userCode" TEXT NOT NULL DEFAULT '',
    "verifyUrl" TEXT NOT NULL DEFAULT '',
    "realm" TEXT NOT NULL DEFAULT 'cn',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "uid" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "expiresAt" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelCooldown_until_idx" ON "ModelCooldown"("until");

-- CreateIndex
CREATE UNIQUE INDEX "ModelCooldown_uid_model_key" ON "ModelCooldown"("uid", "model");

-- CreateIndex
CREATE UNIQUE INDEX "ModelCost_uid_model_key" ON "ModelCost"("uid", "model");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_name_key" ON "ApiKey"("name");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_key" ON "ApiKey"("key");

-- CreateIndex
CREATE UNIQUE INDEX "Provider_name_key" ON "Provider"("name");

-- CreateIndex
CREATE INDEX "UsageEvent_at_idx" ON "UsageEvent"("at");

-- CreateIndex
CREATE INDEX "UsageEvent_uid_at_idx" ON "UsageEvent"("uid", "at");

-- CreateIndex
CREATE INDEX "RequestLog_at_idx" ON "RequestLog"("at");

-- CreateIndex
CREATE INDEX "RequestLog_uid_at_idx" ON "RequestLog"("uid", "at");

-- CreateIndex
CREATE INDEX "StickySession_uid_idx" ON "StickySession"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "LoginSession_state_key" ON "LoginSession"("state");

-- AddForeignKey
ALTER TABLE "AccountState" ADD CONSTRAINT "AccountState_uid_fkey" FOREIGN KEY ("uid") REFERENCES "Account"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelCooldown" ADD CONSTRAINT "ModelCooldown_uid_fkey" FOREIGN KEY ("uid") REFERENCES "Account"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModelCost" ADD CONSTRAINT "ModelCost_uid_fkey" FOREIGN KEY ("uid") REFERENCES "Account"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_uid_fkey" FOREIGN KEY ("uid") REFERENCES "Account"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestLog" ADD CONSTRAINT "RequestLog_uid_fkey" FOREIGN KEY ("uid") REFERENCES "Account"("uid") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StickySession" ADD CONSTRAINT "StickySession_uid_fkey" FOREIGN KEY ("uid") REFERENCES "Account"("uid") ON DELETE CASCADE ON UPDATE CASCADE;

