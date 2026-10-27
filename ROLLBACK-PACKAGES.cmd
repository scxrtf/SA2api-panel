@echo off
setlocal
cd /d "%~dp0"
if not exist "backup-packages\route.ts.bak" (
  echo [ROLLBACK] backup-packages missing, abort
  exit /b 1
)
copy /Y "backup-packages\route.ts.bak"      "src\app\api\panel\packages\route.ts" >nul
copy /Y "backup-packages\packages.tsx.bak"  "src\app\panel\views\packages.tsx" >nul
del /Q "src\lib\accountSession.ts" 2>nul
echo [ROLLBACK] restored 2 files; removed src/lib/accountSession.ts
endlocal
