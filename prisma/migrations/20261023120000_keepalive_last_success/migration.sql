-- 记录最近一次成功续期时间，避免每次 cron 都无条件刷新仍有较长有效期的 token。
ALTER TABLE "AccountState" ADD COLUMN "lastKeepaliveAt" BIGINT NOT NULL DEFAULT 0;
