@echo off
REM 回滚「上游 401 自愈 + 请求级 4xx 快速透传」改动：把 4 个文件还原为 FIX-401-503.diff 之前的字节。
REM 注意：本改动只动代码，不动数据库。已隔离的死号在回滚后仍是 disabled 状态，
REM       如需恢复请在面板「账号」页点「复活」，或重新登录（登录成功会自动 revive）。
REM 用法：在仓库根执行 ROLLBACK-401-503.cmd
setlocal
cd /d "%~dp0"

git apply -R --check FIX-401-503.diff
if errorlevel 1 (
  echo [FAIL] 反向补丁校验不通过，改用 git checkout 还原。
  git checkout -- src/lib/chat.ts src/lib/pool.ts src/lib/modelscan.ts src/lib/upstream/errors.ts
  goto :verify
)

git apply -R FIX-401-503.diff
if errorlevel 1 (
  echo [FAIL] git apply -R 失败。
  exit /b 1
)

:verify
echo [OK] 已还原。校验：
git diff --stat -- src/lib/chat.ts src/lib/pool.ts src/lib/modelscan.ts src/lib/upstream/errors.ts
echo （chat.ts 若仍有输出，属 FIX-KEY-AUTH 的未提交注释改动，与本次修复无关）
endlocal
