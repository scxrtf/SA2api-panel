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
