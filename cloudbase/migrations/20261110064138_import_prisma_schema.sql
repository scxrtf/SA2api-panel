-- >>> prisma migration 20261016000000_init
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

-- >>> prisma migration 20261016092932_taskqueue
-- CreateTable
CREATE TABLE "TaskQueueItem" (
    "id" TEXT NOT NULL,
    "uid" TEXT NOT NULL,
    "taskCode" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "mp" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskQueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskQueueItem_status_createdAt_idx" ON "TaskQueueItem"("status", "createdAt");

-- CreateIndex
CREATE INDEX "TaskQueueItem_uid_idx" ON "TaskQueueItem"("uid");

-- >>> prisma migration 20261016170459_provider_models
-- AlterTable
ALTER TABLE "Provider" ADD COLUMN     "models" TEXT NOT NULL DEFAULT '';

-- >>> prisma migration 20261019000000_model_probes
-- CreateTable
CREATE TABLE "ModelProbe" (
    "key" TEXT NOT NULL,
    "claimed" INTEGER,
    "measured" INTEGER,
    "verdict" TEXT NOT NULL DEFAULT 'inconclusive',
    "note" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'panel-probe',
    "testedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelProbe_pkey" PRIMARY KEY ("key")
);

-- >>> prisma migration 20261020025502_usage_fields
-- UsageEvent：缓存命中观测 / 延迟 / 速率 / 密钥归属 / 积分倍率 / credit 观测标记
ALTER TABLE "UsageEvent" ADD COLUMN "hasCredit" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UsageEvent" ADD COLUMN "cacheHitTok" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UsageEvent" ADD COLUMN "cacheMissTok" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UsageEvent" ADD COLUMN "latencyMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UsageEvent" ADD COLUMN "tps" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "UsageEvent" ADD COLUMN "keyName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "UsageEvent" ADD COLUMN "modelRate" TEXT NOT NULL DEFAULT '';
CREATE INDEX "UsageEvent_model_at_idx" ON "UsageEvent"("model", "at");

-- RequestLog：TTFB / 尝试次数 / token / 积分 / 缓存观测 / 密钥槽位
ALTER TABLE "RequestLog" ADD COLUMN "ttfbMs" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "promptTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "completionTok" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "totalTokens" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "credit" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "hasCredit" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RequestLog" ADD COLUMN "cacheHitTok" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "cacheMissTok" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "RequestLog" ADD COLUMN "keyName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "RequestLog" ADD COLUMN "slot" TEXT NOT NULL DEFAULT '';

-- >>> prisma migration 20261020051436_request_log_machine_id
-- AlterTable
ALTER TABLE "RequestLog" ADD COLUMN     "machineId" TEXT NOT NULL DEFAULT '';

-- >>> prisma migration 20261020120000_api_key_provider_access
-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "providers" TEXT NOT NULL DEFAULT '';

-- 既有密钥保持原有可用性（可调用全部供应商）；新建密钥默认未授权任何供应商。
UPDATE "ApiKey" SET "providers" = '*' WHERE "providers" = '';

-- >>> prisma migration 20261023010000_provider_log_identity
-- 日志身份是快照而非池账号外键：供应商槽位和选号前失败都没有 Account。
-- 保留全部历史行/UID，不伪造账号，也不重写历史路由。
ALTER TABLE "UsageEvent" DROP CONSTRAINT IF EXISTS "UsageEvent_uid_fkey";
ALTER TABLE "RequestLog" DROP CONSTRAINT IF EXISTS "RequestLog_uid_fkey";

-- >>> prisma migration 20261023093000_request_log_err_msg
-- 请求日志补「报错内容」列：失败请求的上游响应正文摘要（单行、截断 1000 字符）。
-- 只写错误路径；成功请求留空，避免日志表无谓膨胀。默认空串保证历史行可读。
ALTER TABLE "RequestLog" ADD COLUMN IF NOT EXISTS "errMsg" TEXT NOT NULL DEFAULT '';

-- >>> prisma migration 20261023120000_keepalive_last_success
-- 记录最近一次成功续期时间，避免每次 cron 都无条件刷新仍有较长有效期的 token。
ALTER TABLE "AccountState" ADD COLUMN "lastKeepaliveAt" BIGINT NOT NULL DEFAULT 0;

-- >>> prisma migration 20261023120000_model_health_checks
-- CreateTable
CREATE TABLE "ModelHealthCheck" (
    "id" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "status" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "errorKind" TEXT NOT NULL DEFAULT '',
    "detail" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'scheduler',
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelHealthCheck_modelKey_checkedAt_idx" ON "ModelHealthCheck"("modelKey", "checkedAt");

-- CreateIndex
CREATE INDEX "ModelHealthCheck_checkedAt_idx" ON "ModelHealthCheck"("checkedAt");

-- >>> prisma migration 20261023143000_request_log_details
-- AlterTable
ALTER TABLE "RequestLog"
ADD COLUMN     "requestMessages" JSONB,
ADD COLUMN     "responseMessage" JSONB,
ADD COLUMN     "errorDetail" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "parameterOverrides" JSONB,
ADD COLUMN     "attemptDetails" JSONB;

-- >>> prisma migration 20261023153000_model_health_metrics
-- ModelHealthCheck：记录真实最小聊天请求的输出 token 与生成吞吐。
ALTER TABLE "ModelHealthCheck"
ADD COLUMN "completionTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "tokensPerSecond" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- >>> prisma migration 20261104093000_machine_key_authorization
-- 以面板浏览器机器码记录创建网关 Key 的授权；账号删除时级联撤销账号授权。
CREATE TABLE "MachineKeyAuthorization" (
    "machineId" TEXT NOT NULL,
    "uid" TEXT,
    "method" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MachineKeyAuthorization_pkey" PRIMARY KEY ("machineId")
);

ALTER TABLE "MachineKeyAuthorization"
    ADD CONSTRAINT "MachineKeyAuthorization_uid_fkey"
    FOREIGN KEY ("uid") REFERENCES "Account"("uid")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- >>> prisma migration 20261104120000_egress_indexes
-- Egress 优化：面板日志页按状态/错误类型/模型/密钥过滤时走复合索引，
-- 避免对 RequestLog 全表扫描后再回表（Supabase 免费档 Egress 主要来源之一）。
-- 手工在 Supabase SQL Editor 执行；不要用 prisma migrate dev（会连生产库做 shadow）。
CREATE INDEX IF NOT EXISTS "RequestLog_status_at_idx" ON "RequestLog"("status","at");
CREATE INDEX IF NOT EXISTS "RequestLog_errKind_at_idx" ON "RequestLog"("errKind","at");
CREATE INDEX IF NOT EXISTS "RequestLog_model_at_idx" ON "RequestLog"("model","at");
CREATE INDEX IF NOT EXISTS "RequestLog_keyName_at_idx" ON "RequestLog"("keyName","at");

-- >>> prisma migration 20261104130000_strip_request_log_dialog
-- 兜底：无论跑的是哪个版本的应用（含尚未重新部署、仍带 REQUEST_LOG_DIALOG=1
-- 的线上实例），都不允许把对话正文写进 RequestLog。
--
-- 背景：requestMessages / responseMessage 是 JSONB TOAST 大字段，单行 80-145 KB。
-- 应用层已在 src/lib/request-log-detail.ts 默认关闭，但部署滞后期间旧实例仍会写。
-- 这里加库级保险，写入即剥离；只有会话显式 SET app.request_log_dialog='1' 才放行。

create or replace function public.strip_request_log_dialog()
returns trigger
language plpgsql
as $$
begin
  if current_setting('app.request_log_dialog', true) is distinct from '1' then
    new."requestMessages" := null;
    new."responseMessage" := null;
  end if;
  return new;
end;
$$;

drop trigger if exists "requestlog_strip_dialog" on "RequestLog";

create trigger "requestlog_strip_dialog"
before insert or update of "requestMessages", "responseMessage" on "RequestLog"
for each row
execute function public.strip_request_log_dialog();

-- >>> prisma migration 20261105120000_disable_request_log_dialog
-- 对话正文永久禁写：旧应用即使设置 REQUEST_LOG_DIALOG=1 或
-- app.request_log_dialog=1，数据库也会同时剥离请求与助手回复。
create or replace function public.strip_request_log_dialog()
returns trigger
language plpgsql
as $$
begin
  new."requestMessages" := null;
  new."responseMessage" := null;
  return new;
end;
$$;

drop trigger if exists "requestlog_strip_dialog" on "RequestLog";
create trigger "requestlog_strip_dialog"
before insert or update of "requestMessages", "responseMessage" on "RequestLog"
for each row execute function public.strip_request_log_dialog();

-- 清理历史遗留正文，只保留统计、错误诊断、参数改写和尝试明细。
update "RequestLog"
   set "requestMessages" = null, "responseMessage" = null
 where "requestMessages" is not null or "responseMessage" is not null;
