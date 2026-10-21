@echo off
REM 还原 sticky-gc 修复前的两个文件（从 .bak 副本恢复，并校验 hash）。
setlocal
set ROOT=%~dp0
copy /Y "%ROOT%src\lib\cron.ts.bak" "%ROOT%src\lib\cron.ts" >nul
copy /Y "%ROOT%src\app\api\panel\overview\route.ts.bak" "%ROOT%src\app\api\panel\overview\route.ts" >nul
certutil -hashfile "%ROOT%src\lib\cron.ts" SHA256 | findstr /I "109BD32CA42A9E1EB4EB3079B305A4959F69B464BB049C35689A94AF4D088B17" >nul && echo cron.ts OK || echo cron.ts HASH MISMATCH
certutil -hashfile "%ROOT%src\app\api\panel\overview\route.ts" SHA256 | findstr /I "08A1BCE98C0C7AA5525453230F30BE01E433F017A8A926C498860259D16B7D34" >nul && echo route.ts OK || echo route.ts HASH MISMATCH
