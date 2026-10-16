# wb2api-next — workbuddy2api 的 Next.js 全栈版

将原 Go 版（账号池网关 + 管理面板）整体迁移到 Next.js：前端面板与后端 API 同一服务，
状态从本地文件迁移到 PostgreSQL。原 Go 项目不受影响，本目录为独立实现。

## 功能对照

| 模块 | Go 版 | 本版 |
|---|---|---|
| OpenAI 兼容端点 | `/v1/chat/completions` `/v1/models` | `/api/v1/chat/completions` `/api/v1/models` |
| Anthropic 端点 | `/v1/messages`（翻译层） | `/api/v1/messages`（等价移植） |
| 管理面板 | 内嵌 HTML | `/panel`（React SPA） |
| 面板 API | `/panel/api/*` | `/api/panel/*` |
| 状态存储 | auths/*.json + state.json | PostgreSQL（Prisma） |
| 定时任务 | 进程内 ticker | 外部 cron 打 `/api/cron/*` |
| 探活 | `/healthz` | `/api/livez`（存活）/ `/api/healthz`（池计数） |

## 本地开发

```bash
npm ci
cp .env.example .env        # 填 DATABASE_URL 与 WB2A_API_KEY
npx prisma migrate dev      # 建表
npm run dev                 # http://localhost:3000/panel
```

## 数据库：Supabase Postgres

1. [supabase.com](https://supabase.com) 建项目，**Connect → ORM → Prisma**，复制两条连接串：
   - **Transaction pooler**（6543 端口，带 `pgbouncer=true`）→ 填 `DATABASE_URL`
   - **Session pooler**（5432 端口）→ 填 `DIRECT_URL`（迁移用，schema.prisma 的 directUrl 已配）
   - 不要用 Direct connection（IPv6-only，Railway 出站可能不通）。
2. 密码是建项目时设的数据库密码（忘了：Settings → Database → Reset）。

## 本地开发

```bash
npm ci
cp .env.example .env        # 填 DATABASE_URL / DIRECT_URL / WB2A_API_KEY
npx prisma migrate dev      # 建表（走 DIRECT_URL）
npm run dev                 # http://localhost:3000/panel
```

## 部署到 Railway

1. Railway 项目 → **+ New → GitHub Repo** 选本仓库（若嵌套在 Go 项目内，
   Settings → Root Directory 填 `wb2api-next`）。
2. 服务 **Variables** 手动加三条：`DATABASE_URL` / `DIRECT_URL`（见上）/ `WB2A_API_KEY`。
3. `railway.toml` 内置：build 时 generate + 编译；start 时 `prisma migrate deploy`（走 DIRECT_URL 建表，幂等）。
4. **Settings → Networking → Generate Domain** 拿公网域名，访问 `https://域名/panel`。

### 定时任务（外部 cron）

| 频率 | 端点 | 说明 |
|---|---|---|
| 每天 09:00 / 21:00（Asia/Shanghai） | `POST /api/cron/checkin` | 全账号签到 |
| 每 5 分钟 | `POST /api/cron/balance` | 余额台账刷新 |
| 每 30 分钟 | `POST /api/cron/keepalive` | token 保活刷新 |

请求头：`Authorization: Bearer $WB2A_API_KEY`。主密钥为空时 cron 端点返回 503（拒绝未鉴权触发）。

## 架构要点

- **单实例语义**：选号运行态（inFlight/lastUsed/抽签序号）为进程内 Map，与 Go 单机口径等价。
  Railway 单容器部署即可；不要水平扩多副本（多副本会分裂在途计数，同 Go 版约束）。
- **鉴权**：`/api/v1/*` 接受主密钥 ∪ ApiKey 环任一 Bearer；`/api/panel/*` 与 `/api/cron/*` 仅主密钥。
- **粘性会话**：会话键 → 账号绑定存 StickySession 表，与 Go 的内存 map 语义一致（DB 化后重启不丢）。
- **冷却/熔断/降权**：ModelCooldown、AccountState 落库，策略逻辑 1:1 移植 internal/pool。
