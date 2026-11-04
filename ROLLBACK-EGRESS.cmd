@echo off
REM ============================================================================
REM ROLLBACK-EGRESS.cmd - 还原 2026-11-04 Supabase Egress 优化前的文件。
REM 备份目录：backup-egress-20261104（原文件加 .bak 后缀，扁平命名）。
REM 用法：在项目根目录（含 package.json 的那层）双击或执行本文件。
REM 只会覆盖下列 34 个文件，不触碰其它改动。
REM 更彻底回退（回到本次优化之前的更早快照）手工使用 .bak2：
REM      backup-egress-20261104\src__app__api__panel__keys__route.ts.bak2
REM      backup-egress-20261104\src__lib__config.ts.bak2
REM      backup-egress-20261104\src__lib__pool.ts.bak2
REM 这三个 .bak2 是第二十六段改动之前的原始版。
REM ============================================================================
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"
if not exist "backup-egress-20261104" (
  echo [ERR] 找不到 backup-egress-20261104，未做任何改动。
  exit /b 1
)

call :restore "prisma__schema.prisma" "prisma\schema.prisma"
call :restore "src__app__api__panel__keys__route.ts" "src\app\api\panel\keys\route.ts"
call :restore "src__app__api__panel__logs__route.ts" "src\app\api\panel\logs\route.ts"
call :restore "src__app__api__panel__models__route.ts" "src\app\api\panel\models\route.ts"
call :restore "src__app__api__panel__overview__route.ts" "src\app\api\panel\overview\route.ts"
call :restore "src__app__api__panel__packages__route.ts" "src\app\api\panel\packages\route.ts"
call :restore "src__app__api__panel__request_logs__[id]__route.ts" "src\app\api\panel\request_logs\[id]\route.ts"
call :restore "src__app__api__panel__request_logs__route.ts" "src\app\api\panel\request_logs\route.ts"
call :restore "src__app__api__panel__usage__route.ts" "src\app\api\panel\usage\route.ts"
call :restore "src__app__panel__components__modelscan.tsx" "src\app\panel\components\modelscan.tsx"
call :restore "src__app__panel__lib.ts" "src\app\panel\lib.ts"
call :restore "src__app__panel__page.tsx" "src\app\panel\page.tsx"
call :restore "src__app__panel__views__taskscenter.tsx" "src\app\panel\views\taskscenter.tsx"
call :restore "src__app__panel__views__analytics.tsx" "src\app\panel\views\analytics.tsx"
call :restore "src__app__panel__views__logs.tsx" "src\app\panel\views\logs.tsx"
call :restore "src__app__panel__views__usage.tsx" "src\app\panel\views\usage.tsx"
call :restore "src__lib__config.ts" "src\lib\config.ts"
call :restore "src__lib__db.ts" "src\lib\db.ts"
call :restore "src__lib__pool.ts" "src\lib\pool.ts"
call :restore "src__lib__request-log-detail.ts" "src\lib\request-log-detail.ts"
call :restore "src__lib__scheduler.ts" "src\lib\scheduler.ts"
call :restore "src__lib__status-log.ts" "src\lib\status-log.ts"
call :restore "scripts__verify-usage-parity.mts" "scripts\verify-usage-parity.mts"
call :restore "src__lib__auth-guard.ts" "src\lib\auth-guard.ts"
call :restore "src__lib__provider.ts" "src\lib\provider.ts"
call :restore "src__lib__modelprobe.ts" "src\lib\modelprobe.ts"
call :restore "src__lib__modelhealth.ts" "src\lib\modelhealth.ts"
call :restore "src__lib__session.ts" "src\lib\session.ts"
call :restore "src__app__api__v1__models__route.ts" "src\app\api\v1\models\route.ts"
call :restore "src__app__api__panel__providers__route.ts" "src\app\api\panel\providers\route.ts"
call :restore "src__app__api__panel__providers__[name]__route.ts" "src\app\api\panel\providers\[name]\route.ts"
call :restore "src__app__api__panel__keys__[name]__route.ts" "src\app\api\panel\keys\[name]\route.ts"
call :restore "r39__chat.ts" "src\lib\chat.ts"
call :restore "r41__official-client-hello.test.mts" "scripts\official-client-hello.test.mts"

echo.
echo [OK] 34 个文件已还原。新增文件需手工删除：
echo      prisma\migrations\20261104120000_egress_indexes\
echo      src\app\api\cron\retention\
echo      src\lib\usage-query.ts
echo      src\lib\usage-legacy.ts
echo      src\lib\usage-aggregation.ts
echo      src\lib\usage-cache.ts
echo      src\lib\retention.ts
echo      scripts\usage-aggregation.test.mts
echo      scripts\verify-usage-sql.mts
echo      scripts\official-egress.test.mts
echo      scripts\prune-logs.cjs
echo      scripts\db-ping.cjs
echo      scripts\db-write-test.cjs
echo      scripts\db-readonly-bypass.cjs
echo      scripts\db-truncate.mjs
echo      scripts\db-restore.mjs
echo      scripts\db-export-scalar.mjs
echo      scripts\db-slim.mjs
echo      scripts\db-vacuum-full.mjs
echo      scripts\requestlog-scalar-24h.ndjson
echo      scripts\_sseout\
echo      ROLLBACK-EGRESS.cmd
echo      prisma\migrations\20261104130000_strip_request_log_dialog\
echo      scripts\egress-guard.cjs
echo      scripts\egress-audit.cjs
echo      scripts\egress-slim.cjs
echo      VERIFICATION-EGRESS.txt
echo      backup-egress-20261104\r39__chat.ts.bak
echo 数据库索引如需回退，在 Supabase SQL Editor 执行：
echo      DROP INDEX IF EXISTS "RequestLog_status_at_idx";
echo      DROP INDEX IF EXISTS "RequestLog_errKind_at_idx";
echo      DROP INDEX IF EXISTS "RequestLog_model_at_idx";
echo      DROP INDEX IF EXISTS "RequestLog_keyName_at_idx";
echo      DROP INDEX IF EXISTS "RequestLog_uid_at_idx";
echo 数据库触发器如需回退，在 Supabase SQL Editor 执行：
echo      DROP TRIGGER IF EXISTS "requestlog_strip_dialog" ON "RequestLog";
echo      DROP FUNCTION IF EXISTS public.strip_request_log_dialog();
exit /b 0

:restore
set "SRC=backup-egress-20261104\%~1.bak"
set "DST=%~2"
if not exist "%SRC%" (
  echo [SKIP] 备份缺失：%SRC%
  exit /b 0
)
copy /Y "%SRC%" "%DST%" >nul
if errorlevel 1 (
  echo [FAIL] 还原失败：%DST%
) else (
  echo [DONE] %DST%
)
exit /b 0
