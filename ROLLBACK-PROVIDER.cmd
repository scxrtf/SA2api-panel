@echo off
setlocal
cd /d "%~dp0"
if not exist "backup-provider\src\lib\provider.ts.bak" (
  echo [ROLLBACK] backup-provider missing, abort
  exit /b 1
)
copy /Y "backup-provider\src\lib\provider.ts.bak"                         "src\lib\provider.ts" >nul
copy /Y "backup-provider\src\lib\aichecker.ts.bak"                        "src\lib\aichecker.ts" >nul
copy /Y "backup-provider\src\app\api\panel\providers\probe\route.ts.bak"  "src\app\api\panel\providers\probe\route.ts" >nul
copy /Y "backup-provider\src\app\api\panel\models\route.ts.bak"            "src\app\api\panel\models\route.ts" >nul
copy /Y "backup-provider\src\app\api\panel\models\test\route.ts.bak"       "src\app\api\panel\models\test\route.ts" >nul
copy /Y "backup-provider\src\app\api\panel\models\probe\route.ts.bak"      "src\app\api\panel\models\probe\route.ts" >nul
copy /Y "backup-provider\src\app\panel\views\gateway.tsx.bak"              "src\app\panel\views\gateway.tsx" >nul
copy /Y "backup-provider\src\app\panel\views\models.tsx.bak"               "src\app\panel\views\models.tsx" >nul
del /Q "src\lib\provider-endpoint.ts" 2>nul
del /Q "scripts\provider-endpoint.test.mts" 2>nul
git reset -q -- src/lib/provider-endpoint.ts scripts/provider-endpoint.test.mts 2>nul
echo [ROLLBACK] restored 8 files; removed 2 added files
.\node_modules\.bin\tsc.cmd --noEmit
echo [ROLLBACK] tsc exit=%ERRORLEVEL%
endlocal
