@echo off
setlocal
cd /d "%~dp0"
if not exist "backup-6020\errors.ts.bak" (
  echo [ROLLBACK] backup-6020 missing, abort
  exit /b 1
)
copy /Y "backup-6020\errors.ts.bak"  "src\lib\upstream\errors.ts" >nul
copy /Y "backup-6020\pool.ts.bak"    "src\lib\pool.ts" >nul
copy /Y "backup-6020\chat.ts.bak"    "src\lib\chat.ts" >nul
copy /Y "backup-6020\modelscan.ts.bak" "src\lib\modelscan.ts" >nul
copy /Y "backup-6020\client.ts.bak"  "src\lib\upstream\client.ts" >nul
del /Q "scripts\queue-6020.test.mts" 2>nul
git reset -q -- scripts/queue-6020.test.mts 2>nul
echo [ROLLBACK] restored 5 files; removed scripts/queue-6020.test.mts
endlocal
