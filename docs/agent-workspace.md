# 机器会话工作树

面板的「机器会话」（`/panel/workspace`）只观察已经发到网关的客户端请求。Codex、Claude Code、Pi 等继续在原来的客户端工作。网页没有任务输入框，不创建 Worker 任务，也无需启动 Worker。

## 开启观测

开发和部署需要 Node.js 22.19+（推荐 24）。服务器配置：

```dotenv
WB2_WORKSPACE_ENABLED=1
```

重启服务后，从面板打开「机器会话」。Chat Completions、Anthropic Messages、Responses 和 Responses Compact 路由会自动记录通过网关校验的请求。观察器不改变模型响应或 SSE 字节；关闭观察页面也会继续记录。使用 `WB2_WORKSPACE_CAPTURE=0` 可暂停新记录并保留历史。

观测使用独立的 `gateway-trace.sqlite`；默认在 `.runtime/agent-workspace`，可通过 `WB2_WORKSPACE_DATA_DIR` 指定持久目录。采集故障不会阻断模型请求。已有网关日志和本地 Worker 数据都不被移动或删除。旧请求不会回填，因为它们没有可靠的客户端机器和会话关联键。

本机开发可沿用已启用的面板免密。其他设备或生产服务打开面板仍使用原有管理凭据；发送模型请求的客户端不使用面板登录。

## 一台机器多条会话

机器归属按以下优先级确定：

1. 客户端发送的 `X-WB2A-Machine-Id` 或可识别的安装 ID。
2. 使用的具名网关子密钥。多台机器共享一个密钥时，如果未提供设备标识，这一级只能归组。
3. 连接信息的摘要，显示为「按连接估算」，不展示原始地址。不是物理机器识别。

对于 Codex，可在**现有**工作网关的用户级 provider 表中加每台机器不同的静态请求头，例如：

```toml
http_headers = { "X-WB2A-Machine-Id" = "dev-desktop" }
```

合并已有 `http_headers`，不要重复定义。该选项见 [Codex 官方配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。本配置不替代现有 `base_url`、`wire_api` 或密钥。

会话按客户端发来的会话/线程 ID、同一台机器上的 `previous_response_id`、已观察工具回传及能唯一比对的消息历史关联。Codex CLI 0.170.0 的 `thread-id` 和 `session-id` 已用本机 CLI 验证，同一会话续聊自动入同树。相同首条提示不会自动合并。无法稳定识别时保留独立请求并标为「未关联」。`X-WB2A-Session-Id` 仅供能为**每条会话**生成独立值的集成使用，不要为整台机器写死同一个值。客户端可通过 `X-WB2A-Parent-Session-Id` 对已观察的同机父会话标明子分支。

## 工作树能看什么

每棵树展示网关实际观察到的模型请求、响应和工具调用/回传。选择左侧机器下的会话切换工作树；点击节点可定位到对应记录。光线只由新事件触发，刷新或补发旧事件不会重播。列表默认读取最近 250 条会话，当前工作树显示最近 640 个节点。

这是会话事件树，不是远端机器的 Git worktree。工具节点区分「模型请求工具」与「客户端回传结果」；没经过网关的本地进程、子代理关系和文件，不被推断为已执行或已交付。

默认不保存请求和回复正文，也不保存工具参数、工具返回正文、认证头或原始 IP。需要看短正文时，在服务端显式设置 `WB2_WORKSPACE_TRACE_TEXT=1`，只影响新收集的数据。它会截断并遮盖常见凭据形式；请将观测数据目录按会话日志管理。

## 直接使用 Codex 的 Responses 网关

Codex 可通过 `/api/v1/responses` 连接既有 WorkBuddy 模型、Chat 供应商和原生 Responses 上游。
配置示例和迁移步骤见 [Responses 接入指南](responses.md)。

旧 Chat Completions 和 Messages 使用方式不变。直接从外部客户端自身的原有模型地址发送、没有经过本网关的请求，不会出现在面板。

## 验证和回退

运行 `npm test -- scripts/gateway-worktree.test.mts scripts/request-validation.test.mts` 校验机器隔离、线程分支、续接、SSE 透传和无正文默认模式。

停采集时设 `WB2_WORKSPACE_CAPTURE=0`；停用整个面板入口的数据读取时设 `WB2_WORKSPACE_ENABLED=0`，重启服务即可。两者都保留现有数据。
