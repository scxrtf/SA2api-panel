# 回滚指引（Supabase → CloudBase 迁移）

迁移时间：2026-11-10
源：Supabase / Prisma Postgres（`db.prisma.io`，DATABASE_URL 见 `.env.bak-supabase-20261110`）
目标：CloudBase 国内站个人版 PG `postgres-lvve9tbg`（ap-shanghai）

## 数据落点

- DDL：`cloudbase/migrations/20261110064138_import_prisma_schema.sql`
- 数据：`backup-cloudbase-migration-20261110/data/*.json`（17 表 / 51,422 行）
- 校验脚本：`scripts/cloudbase-migrate/01-export.cjs` → `04-import-migrations.cjs`
- API Key：CloudBase 控制台 `democratic-aphid-d2ekz7739861827` → API Key 管理（KeyId=lsyuPrLcQpC0OujhhKQe8Q）

## 回滚到 Supabase（一键）

```powershell
# 1. 恢复 .env
copy .env.bak-supabase-20261110 .env

# 2. 重启应用即可；Supabase 上的数据没动过
```

CloudBase 侧的环境/数据可保留作冷备，不删。

## 应用层改造（如果要让 Next 应用直接读 CloudBase）

CloudBase 个人版共享 PG **不提供 TCP 直连**，所以现有 `@prisma/adapter-pg` 通道打不通。
可用通道只有一个：PostgREST HTTP 网关
`https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/<table>`，配 `apikey` + `Authorization: Bearer <key>` 头。

## 已完成（2026-11-10）：CloudBase 已是主库

1. `src/lib/dal.ts`：PostgREST DAL，Prisma 形态的薄垫片（findMany/create/update/upsert/count 等 16 个模型）。
2. `src/lib/db.ts`：`USE_CLOUDBASE_REST=1` 时 `prisma` 代理转发到 DAL，调用点零改动。
3. 应用层聚合：`src/lib/usage-query.ts` 在 CloudBase 通道下拉行自算（queryUsageAggregateDal）。
4. 原生 SQL 替换：`src/lib/cron.ts` keepalive 租约改 upsert 读-判-写；`src/app/api/panel/database/route.ts` 库监控改 count 聚合。
5. 行数对拍：`scripts/cloudbase-verify-counts.mjs` 14 表全量一致（51,422 行）。
6. 写链路验证：`scripts/dal-write-test.mjs` create/createMany/update/count/deleteMany 全通。

## 当前运行模式

- `USE_CLOUDBASE_REST=1`：CloudBase PostgREST 为唯一读写源，容器启动时跳过 Prisma migration。
- 未启用 CloudBase REST：Prisma/PostgreSQL 为读写源，容器启动时执行 `prisma migrate deploy`。
- 回滚时同步恢复环境变量并重启，避免应用读写源与启动迁移通道不一致。
