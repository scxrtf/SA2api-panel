@echo off
rem ROLLBACK-PROVIDER-DELETE：撤销「供应商删除需超级密码 + 联动清理密钥授权」修复
cd /d %~dp0
git checkout -- "src\app\api\panel\providers\[name]\route.ts" src\app\panel\views\gateway.tsx
echo rollback done.
