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
| 状态存储 | auths/*.json + state.json | CloudBase PostgREST 或 PostgreSQL（Prisma） |
| 定时任务 | 进程内 ticker | 外部 cron 打 `/api/cron/*` |
| 探活 | `/healthz` | `/api/livez`（存活）/ `/api/healthz`（池计数） |

## 本地开发

官方真机 HTTPS 出口使用 `native/official-tls` 中的 uTLS helper，本地需安装 Go 1.26+；
Docker 构建会在独立阶段自动编译并带入运行镜像。

```bash
npm ci
npm run build:official-tls  # 生成 native/official-tls/bin/official-tls[.exe]
cp .env.example .env        # 填数据库通道、WB2A_API_KEY 与两个面板密码
npx prisma migrate dev      # 建表
npm run dev                 # http://localhost:3000/panel
```

## 数据库通道

默认使用 Prisma/PostgreSQL，设置 `DATABASE_URL` 与 `DIRECT_URL` 后运行迁移。
使用 CloudBase 时设置 `USE_CLOUDBASE_REST=1`、`CLOUDBASE_POSTGREST_URL` 与
`CLOUDBASE_API_KEY`；CloudBase 模式不执行 Prisma migration。

`WB2A_SUPER_PASSWORD` 用于配置、密钥与账号权限操作的二次确认；
`WB2A_MACHINE_PASSWORD` 用于当前机器的建 Key 授权。本项目两项均配置为 `QWEZXC2004`。

## 部署到 Railway

1. Railway 项目 → **+ New → GitHub Repo** 选本仓库（若嵌套在 Go 项目内，
   Settings → Root Directory 填 `wb2api-next`）。
2. 服务 **Variables** 设置数据库通道、`WB2A_API_KEY`、`WB2A_SUPER_PASSWORD` 与 `WB2A_MACHINE_PASSWORD`。
3. 启动时 Prisma 模式执行 `prisma migrate deploy`；CloudBase REST 模式跳过迁移。
4. **Settings → Networking → Generate Domain** 拿公网域名，访问 `https://域名/panel`。

### 定时任务（外部 cron）

| 频率 | 端点 | 说明 |
|---|---|---|
| 每天 09:00 / 21:00（Asia/Shanghai） | `POST /api/cron/checkin` | 全账号签到 |
| 每 5 分钟 | `POST /api/cron/balance` | 余额台账刷新 |
| 每 30 分钟 | `POST /api/cron/keepalive` | 仅续期临期 token；可安全高频调用 |
| 每 6 小时 | `POST /api/cron/retention` | 数据库保留策略：清老日志详情、删过期日志与健康检查 |

请求头：`Authorization: Bearer $WB2A_API_KEY`。主密钥为空时 cron 端点返回 503（拒绝未鉴权触发）。

### 磁盘 / 保留策略

`RequestLog` 在诊断详情保留期内保存请求对话、助手回复、失败诊断、参数覆盖和尝试明细，到期后剥离大字段，
仅保留用量统计。`REQUEST_LOG_DIALOG=0` 可关闭对话记录。托管 PostgreSQL 磁盘超限时可能把数据库切成只读
（`default_transaction_read_only=on`），表现为整站写入失败。

- 保留参数（环境变量）：`REQUEST_LOG_RETENTION_DAYS`（默认 7）、`REQUEST_LOG_DETAIL_HOURS`（默认 24，
  超过就清空对话、参数覆盖、尝试明细与错误详情但保留统计列）、`MODEL_HEALTH_RETENTION_DAYS`（默认 3）。
- 定时打 `/api/cron/retention`（每 6~12 小时）即可自动维持；临时收紧可带 `?days=3&detailHours=12`。
  定时任务不会提前清理保留期内的对话；「清理历史对话」按钮仍会立即清理全部对话，仅供管理员手动使用。
- 面板「CloudBase」显示数据库与表占用，提供历史对话清理和保留策略按钮；Egress、Log Ingestion、
  Log Query 使用可编辑的控制台快照与额度进度条。快照仅保存在当前浏览器，数据库统计每 60 秒缓存刷新。
- 紧急救火（平台已只读、连清理都跑不动时）：`node scripts/db-truncate.mjs --yes` 直接 `TRUNCATE`
  归还物理空间并附带 `ALTER DATABASE ... SET default_transaction_read_only = off` 解除只读；
  需要立即把回收的空间还给文件系统时跑 `node scripts/db-vacuum-full.mjs ModelHealthCheck`。

Token 保活默认只处理 24 小时内到期或过期时间未知的账号；本进程调度器默认仍在
22:00 触发一次。所有自动/外部/面板触发共用数据库租约，同一时间只跑一轮；单轮
默认最多 240 秒、3 并发，跑不完的账号下次继续。外部 cron 若配置 `force=1`
（`POST /api/cron/keepalive?force=1`）则强制刷新全部账号，用于人工排障。

## 架构要点

- **单实例语义**：选号运行态（inFlight/lastUsed/抽签序号）为进程内 Map，与 Go 单机口径等价。
  Railway 单容器部署即可；不要水平扩多副本（多副本会分裂在途计数，同 Go 版约束）。
- **鉴权**：`/api/v1/*` 接受主密钥 ∪ ApiKey 环任一 Bearer；`/api/panel/*` 与 `/api/cron/*` 仅主密钥。
- **粘性会话**：会话键 → 账号绑定存 StickySession 表，与 Go 的内存 map 语义一致（DB 化后重启不丢）。
- **冷却/熔断/降权**：ModelCooldown、AccountState 落库，策略逻辑 1:1 移植 internal/pool。

## 聚合供应商接入说明

聚合供应商（Provider）是把第三方 OpenAI 兼容服务挂到本网关的通道：命中生效供应商时
**完全旁路 CodeBuddy 账号池管线**（无粘性会话 / 无积分台账 / 无提示词改写），直接把请求
原样转发到供应商的 `baseUrl`，供应商响应原样回传，仅在旁路做 token 记账。

### 1. 添加供应商

面板 → 网关页「聚合供应商」区，或 API：

```bash
curl -X POST https://<你的域名>/api/panel/providers \
  -H "Authorization: Bearer $WB2A_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "myvendor",
    "base_url": "https://api.example.com/v1",
    "key": "sk-xxxx",
    "models": "gpt-6.1-sol, deepseek-v4.1-flash"
  }'
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 供应商名，作为调用前缀。仅限中文/字母/数字/下划线/连字符（1-64 字符），不可含空格与标点 |
| `base_url` | 是 | 供应商的 OpenAI 兼容 Base URL。可填到版本段（`https://host/v1`），也可只填主机（`https://host`，网关自动补 `/v1`，不会出现 `/v1/v1`） |
| `key` | 是 | 供应商 API Key，作为 `Authorization: Bearer` 转发 |
| `models` | 否 | 模型白名单，逗号分隔。**空 = 暴露供应商全部模型**；非空 = 只暴露勾选模型 |

### 2. 调用供应商模型

模型名带前缀：`供应商名:模型名`，例如 `myvendor:gpt-6.1-sol`。不带前缀或 `cn:` / `global:` 前缀走 CodeBuddy 池。

```bash
# 列模型（含供应商聚合目录）
curl https://<你的域名>/api/v1/models -H "Authorization: Bearer <任一可用密钥>"

# 聊天
curl https://<你的域名>/api/v1/chat/completions \
  -H "Authorization: Bearer <任一可用密钥>" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "myvendor:gpt-6.1-sol",
    "messages": [{"role": "user", "content": "hello"}],
    "stream": true
  }'
```

- **鉴权**：与池通道相同，`/api/v1/*` 接受主密钥或 ApiKey 环任一 Bearer。
- **密钥环绑定**：面板网关页可给子密钥勾选供应商白名单——绑定后该子密钥只能调用已勾选
  供应商的模型；显式 `*` = 全部；留空/不勾选 = 不授权任何供应商（新建密钥的默认态，
  需在面板显式授权后才能调用聚合供应商；池通道不受影响）。
- **流式空闲看门狗**：供应商 SSE 流经 `stream_idle_ms` 看门狗（默认 300s），面板配置项可调。
- **用量记账**：供应商调用计入 UsageEvent，`realm = provider:<供应商名>`，
  面板用量视图可按 realm 前缀筛选。

### 3. 面板内验证可调用性

面板 → 模型页「实测」按钮，模型名填 `供应商名:模型名`（前缀非 cn/global 时自动走供应商直连
通道），最长阻塞 45s，返回 HTTP 状态与首条回复；也可直接调：

```bash
curl -X POST https://<你的域名>/api/panel/models/test \
  -H "Authorization: Bearer $WB2A_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "myvendor:gpt-6.1-sol"}'
```

供应商 `/models` 目录探测失败不会拖垮整体列表，错误以 `warnings` 形式返回在
`/api/panel/models` 响应中。
