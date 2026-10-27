-- 请求日志补「报错内容」列：失败请求的上游响应正文摘要（单行、截断 1000 字符）。
-- 只写错误路径；成功请求留空，避免日志表无谓膨胀。默认空串保证历史行可读。
ALTER TABLE "RequestLog" ADD COLUMN IF NOT EXISTS "errMsg" TEXT NOT NULL DEFAULT '';
