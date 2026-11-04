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
