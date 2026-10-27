@echo off
REM 回滚「新建 key 默认无供应商授权」改动：把 6 个文件还原为 FIX-KEY-AUTH.diff 之前的原始字节。
REM 用法：在仓库根执行 ROLLBACK-KEY-AUTH.cmd
setlocal
cd /d "%~dp0"

git apply -R --check FIX-KEY-AUTH.diff
if errorlevel 1 (
  echo [FAIL] 反向补丁校验不通过，改用 git checkout 还原。
  git checkout -- README.md src/lib/auth-guard.ts src/lib/chat.ts src/app/api/panel/keys/route.ts "src/app/api/panel/keys/[name]/route.ts" src/app/panel/views/gateway.tsx
  goto :verify
)

git apply -R FIX-KEY-AUTH.diff
if errorlevel 1 (
  echo [FAIL] git apply -R 失败。
  exit /b 1
)

:verify
echo [OK] 已还原。校验：
git diff --stat -- README.md src/lib/auth-guard.ts src/lib/chat.ts src/app/api/panel/keys/route.ts "src/app/api/panel/keys/[name]/route.ts" src/app/panel/views/gateway.tsx
echo （上面无输出 = 工作区与 HEAD 一致，回滚成功）
endlocal
