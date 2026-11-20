# OpenAI Responses 接入

HTTP Base URL 为 `http://127.0.0.1:3000/api/v1`，也可使用 `/v1`。客户端传已有网关密钥与模型目录中的完整 ID（保留 `cn:`、`global:` 或供应商前缀）。未配置原生上游时，Responses 请求复用现有 Chat 路由、账号池和用量统计；已有 Chat Completions / Anthropic Messages 调用不变。

## 启用持久化

默认 `store:true`。升级时先执行对应数据库迁移，再重启新版：

- **Prisma/PostgreSQL**：在项目目录执行 `npx prisma migrate deploy`，用新版镜像时由容器启动命令执行。
- **CloudBase REST**：在现有 PostgreSQL 环境应用 `cloudbase/migrations/20261120150000_gateway_responses.sql`，不要在该环境重复执行 Prisma 迁移。

`store:false` 不会建立 Responses 存档：客户端传完整 `input` 重放历史，不传 `previous_response_id`。兼容层存档用于查询和续接，按实际网关密钥隔离，保留 30 天，并在写入时定期清理过期记录。删除一条响应不会删除其已经续接生成的独立存档。原生通道在本地只保存 ID 归属；实际上游保留周期由供应商决定。旧版原生响应未登记归属，升级后续聊请改用完整历史。Responses 的 `store` 字段不改变项目原有请求日志或机器会话采集设置。

## 快速验证

运行中的网关应已配置至少一个可用模型。在 PowerShell 中执行：

```powershell
$base = 'http://127.0.0.1:3000/api/v1'
$headers = @{ Authorization = "Bearer $env:WB2A_API_KEY" }
$model = (Invoke-RestMethod "$base/models" -Headers $headers).data[0].id
$body = @{ model = $model; input = '只回复 OK'; store = $false } | ConvertTo-Json -Compress
$reply = Invoke-RestMethod "$base/responses" -Method Post -Headers $headers -ContentType 'application/json' -Body $body
$reply.output | Where-Object type -eq 'message' | ForEach-Object { $_.content.text }
```

Codex：在现有 `~/.codex/config.toml` 合并以下设置，运行时给环境变量 `WB2A_API_KEY` 设置**客户端网关密钥**。`model` 选模型目录实际可用的 ID。若连接的是 Chat 兼容通道，将 Codex 的服务端网页搜索设为 `disabled`。配置字段见 [Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。

```toml
model_provider = "wb2api"
web_search = "disabled"

[model_providers.wb2api]
name = "wb2api"
base_url = "http://127.0.0.1:3000/api/v1"
wire_api = "responses"
env_key = "WB2A_API_KEY"
requires_openai_auth = false
supports_websockets = false
```

## 能力对照

| HTTP 路径 / 功能 | WorkBuddy / Chat 兼容层 | 原生 Responses 上游 |
|---|---|---|
| `POST /responses` | JSON、增量 SSE、多轮重放、图像 URL、函数/自定义工具、结构化格式参数 | 原生 JSON 与 SSE；保留上游支持的参数和事件 |
| `GET /responses/{id}` | 查询已存档的响应 | 原生查询，支持 `stream=true&starting_after=N` |
| `GET /responses/{id}/input_items` | `limit`、`order`、`after` 分页 | 原生分页及 `include` 参数 |
| `DELETE /responses/{id}` | 删除本条存档 | 删除上游响应并清除归属 |
| `POST /responses/compact` | 生成模型摘要，返回可重放的网关加密项 | 原生压缩 |
| `POST /responses/input_tokens` | — | 由上游返回真实 token 数 |
| `background: true` / `POST /responses/{id}/cancel` | — | 上游支持时可轮询/取消 |
| 上游托管工具、文件 ID、Conversations 引用和自动压缩 | — | 取决于原生供应商；独立的 Files/Conversations API 不在这些路由内 |

两条路径均使用 HTTP / SSE；没有 WebSocket 监听。兼容层只转换协议，实际识图、JSON Schema 约束和推理能力取决于所选模型。自定义工具在 Chat 通道用 `{ "input": "…" }` 函数参数桥接；自定义语法作为模型提示传入，不由网关执行。请求体与兼容层重放窗口上限为 8 MiB。

### 配置原生通道

| 环境变量 | 作用 |
|---|---|
| `WB2A_RESPONSES_UPSTREAM` | 上游 HTTPS API Base URL（或环回 HTTP 测试地址） |
| `WB2A_RESPONSES_KEY` | 服务端上游密钥，不是下游客户端密钥 |
| `WB2A_RESPONSES_MODELS` | 逗号分隔的原生模型 ID；与其他通道同名时优先走原生 |
| `WB2A_RESPONSES_PROVIDER` | 子密钥供应商授权名，默认 `openai-responses` |
| `WB2A_RESPONSES_STATE_SECRET` | 可选，兼容层加密项密钥。多实例设置同一份；未设置则用网关主密钥，无主密钥时限同一进程重放 |

原生通道需配置网关主密钥。可通过 `PATCH /api/panel/keys/{name}` 把原生授权名加入子密钥的 `providers` 白名单（提交完整白名单及 `super_password`）。直接引用上游项目的 `conversation`、`prompt` 或 `item_reference` 使用主密钥。原生和兼容通道的 `previous_response_id` 以及加密项各自绑定原通道和网关密钥，换通道时改用完整的文本、消息与工具结果重放。

## 离线回归

```powershell
npm test -- scripts/responses.test.mts scripts/workspace-runtime.test.mts
```

路由烟测：用 `WB2A_NEXT_DIST_DIR=.runtime/responses-verify-next` 构建后运行 `node --import tsx scripts/responses-e2e.mts`。也可设 `WB2A_TEST_NEXT_DEV=1` 直接以隔离的开发服务运行。若已安装 Codex，可以另设 `WB2A_TEST_CODEX=1` 验证 CLI 实际完成一轮请求。测试自建环回模拟上游和 PostgREST，不消耗上游额度。
