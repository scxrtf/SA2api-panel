@echo off
rem ROLLBACK-ANALYTICS：撤销数据看板 tab（还原 nav/page/css，删除新视图文件）
cd /d %~dp0
git checkout -- src\app\panel\nav.ts src\app\panel\page.tsx src\app\globals.css
del /q src\app\panel\views\analytics.tsx
echo rollback done.
