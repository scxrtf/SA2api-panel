-- 请求日志的对话记录是面板诊断功能，不再由数据库触发器无条件剥离。
-- 历史已被清空的正文没有副本，本迁移只恢复此后新请求的完整记录。
drop trigger if exists "requestlog_strip_dialog" on "RequestLog";
drop function if exists public.strip_request_log_dialog();
