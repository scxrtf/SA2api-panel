-- 日志身份是快照而非池账号外键：供应商槽位和选号前失败都没有 Account。
-- 保留全部历史行/UID，不伪造账号，也不重写历史路由。
ALTER TABLE "UsageEvent" DROP CONSTRAINT IF EXISTS "UsageEvent_uid_fkey";
ALTER TABLE "RequestLog" DROP CONSTRAINT IF EXISTS "RequestLog_uid_fkey";
