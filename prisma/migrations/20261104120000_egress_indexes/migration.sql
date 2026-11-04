-- Egress 优化：面板日志页按状态/错误类型/模型/密钥过滤时走复合索引，
-- 避免对 RequestLog 全表扫描后再回表（Supabase 免费档 Egress 主要来源之一）。
-- 手工在 Supabase SQL Editor 执行；不要用 prisma migrate dev（会连生产库做 shadow）。
CREATE INDEX IF NOT EXISTS "RequestLog_status_at_idx" ON "RequestLog"("status","at");
CREATE INDEX IF NOT EXISTS "RequestLog_errKind_at_idx" ON "RequestLog"("errKind","at");
CREATE INDEX IF NOT EXISTS "RequestLog_model_at_idx" ON "RequestLog"("model","at");
CREATE INDEX IF NOT EXISTS "RequestLog_keyName_at_idx" ON "RequestLog"("keyName","at");
