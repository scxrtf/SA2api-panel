# WorkBuddy 登录、隐私与工具请求对齐

## 结论

用户指出的三类差异已按本机 **WorkBuddy 5.9.3 / CLI 2.165.0** 的代码分支补齐，并通过独立请求构造、模拟登录闭环与真实 loopback HTTP 收包验证。配置显式覆盖、网关兼容扩展与尚未取得的动态上下文分别记录，不把离线测试写成真实账号登录成功。

```powershell
npm run test:workbuddy-profile
npm test
npm run lint
```

## 对齐内容

| 编号 | 位置 | 修改前 → 修改后 | 证据 |
|---|---|---|---|
| A01 | `src/lib/login.ts:31` | CN copilot 域 + platform=CLI → `www.workbuddy.cn` + `platform=workbuddy` | AL01/AL21 |
| A02 | `src/lib/login.ts:31`、`src/app/api/panel/login/poll/route.ts` | `/v2/plugin/login/account?state=` → Bearer `GET /v2/plugin/account`，不发 state | AL05/AL06；登录闭环和 HTTP 实收 |
| A03 | `src/lib/login.ts:63` | 旧 CLI/2.63.2 UA 与浏览器头 → 当前 RPC UA、四个匿名哨兵、原生默认 request-id/Accept/encoding | AL02/AL03/AL08–AL15 |
| A04 | 登录 start/poll 路由 | 未区分错误/等待 → 仅 11217/12151 视为等待，编码 state、检查会话 TTL、保留有效期语义 | AL16；模拟路由回归 |
| A05 | `src/lib/upstream/privacy.ts:6`、`:20` | 按 Global/enterprise 简化 → 原生显式偏好、产品默认与企业 edition 判定；header 为优化开关的反值 | AP01–AP03 |
| A06 | `src/lib/upstream/client.ts:148` | Global chat UA 第一段仍是 WorkBuddy → chat/common 与 RPC 使用同一 realm profile | 请求实收的 CN/Global UA 断言 |
| A07 | `src/lib/upstream/agenttool.ts:60` | 工具套用 chat SDK/trace/private 头 → 独立 `CLI/<客户端版本>` 工具头族 | AT1/AT2/AT5/AT7 |
| A08 | `src/lib/upstream/agenttool.ts:93`、`:106` | 仅 query/url → 搜索筛选、完整 fetch 正文与 20 秒默认 deadline | AT6–AT9；路由与 HTTP 实收 |

### 登录

- state：`POST /v2/plugin/auth/state?platform=workbuddy`，JSON 正文 `{}`。
- token：`GET /v2/plugin/auth/token?state=`，state 做 URL 编码。
- account：`GET /v2/plugin/account`，只用 Bearer 和 token 返回的 domain/默认 endpoint domain，不再泄露 state。
- state/token 的 `X-No-Authorization`、`X-No-User-Id`、`X-No-Enterprise-Id`、`X-No-Department-Info` 均为字符串 `true`。
- 去掉 Origin/Referer/XMLHttpRequest 头；默认 UA 为 `WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0`。实际请求仍尊重已有配置覆盖。
- 实际登录 state 的 `{}` 使用 JSON Content-Type；通用 null POST 则复现 Axios 的 urlencoded 默认和 `Content-Length: 0`。GET 不额外发正文或 Content-Type。
- Axios 1.18.1 的 zstd 广告默认关闭，因此默认保留四段 `gzip, compress, deflate, br`，没有只因运行时支持 zstd 就擅自加第五段。

### 隐私判定与配置

原生规则：显式 `enabled` 布尔值优先；没有显式值时，企业 edition 关闭模型优化，其他账号采用产品/AB 默认值，产品值未知时回落 `true`。最后 **优化开启 → `X-Private-Data: false`；优化关闭 → `true`**。

新增配置通过现有管理员配置 API 保存，不需要数据库迁移：

```json
{
  "enable_model_optimization": null,
  "model_optimization_default_enabled": true,
  "model_optimization_accounts": {}
}
```

- `enable_model_optimization=null`：不强制全局偏好；`true/false` 表示显式开启/关闭优化。
- `model_optimization_default_enabled`：已解析的产品/AB 默认。本机产品 `DefaultModelOptimizationOff=false` 对应这里的 `true`。
- `model_optimization_accounts`：UID 到布尔值的映射，优先于全局显式值；清空对象可移除逐账号覆盖。
- 若需要强制发 private 头，可设置 `enable_model_optimization=false`，并清除与之冲突的逐账号覆盖。
- CN 和 Global 不再通过 realm 硬编码隐私。企业判定支持非空 enterpriseId，以及可用时的原生 `type=ultimate/exclusive`。

旧 Account 表没有保存原生 `type` 列；本轮没有凭空补 edition，也没有读取桌面端用户设置。旧账号继续使用已有 enterpriseId，并可用逐 UID 显式偏好匹配缺失的客户端设置。该数据来源边界不等于改写判定公式。

### 搜索与抓取

两条工具链路保留客户端原生 `fetch`，不误套 RPC/uTLS 或 Stainless SDK 头；默认 `User-Agent: CLI/5.9.3`。request/message 共用去横线 UUIDv7。会话缺失时保留空上下文，不伪造完整聊天会话；webfetch 另带 `X-Wb-Uid`。

搜索：

- `query` 至少 2 个字符，保留调用者原始非空文本；`allowed_domains`、`blocked_domains` 为字符串数组。
- 屏蔽域编为 `query (-site:a -site:b)`，不额外发送 `blocked_domains` 字段。
- freshness 接受 `d`、`d1`–`d30`、`m`、`m1`–`m12`、`y`、`y1`–`y5`。
- 默认 `max_results=5`；既有 `max_results/count` 显式正整数覆盖保留为网关扩展，正 max_results 优先 count，0/缺省回落 5。

抓取默认正文：

```json
{
  "url": "https://example.com/",
  "format": "markdown",
  "prompt": "",
  "timeout": 20,
  "max_length": 100000
}
```

支持显式 `prompt`、`model_name`。未传 model_name 而有 model 时，去掉 cn/global 前缀后映射过去。旧 URL-only 调用保持可用，prompt 为空串，而不是删除该字段。

显式 timeout 1–120 秒和 max_length 1–1000000 是网关保护范围，不宣称是上游实测最大值。网关 deadline 也保护正文读取，保留原有取消、错误分类与 Retry-After。`/api/v1/fetch` 的下游 DSH 补 url/JSON 包装保持原样，本次只调整上游请求。

## 验证与证据

- 针对性测试：**28/28 通过**。包括登录路由模拟闭环、隐私完整布尔矩阵、工具 body/header/路由与 3 项真实 loopback HTTP 实收。
- 全量测试、lint、类型检查、构建最终状态见 [verification.json](docs/upstream-alignment-2026-11-20/verification.json)。跳过项单独记录，不计为通过。
- 类型检查遵循当前仓库 tsconfig；并发工作台的 `workers/workspace` 被其配置作为独立运行时排除，不是本轮上游模块的类型验收对象。生成路由类型曾含已迁移 API 的旧引用，本轮用 `next typegen` 更新并清理临时 QA 类型路径，没有排除本轮失败源码。
- [登录证据](docs/upstream-alignment-2026-11-20/login-evidence.json)：24 条字节定位。
- [隐私证据](docs/upstream-alignment-2026-11-20/privacy-evidence.json)：原生函数与默认值。
- [工具证据](docs/upstream-alignment-2026-11-20/agenttool-evidence.json)：10 条字节定位。

没有运行真实账号授权、改写凭据或执行上游付费聊天。Global 保留现有区域映射，共享已还原的构造逻辑；没有把 CN 静态基线宣称为同版 Global 应用全过程抓包。动态 AB、可选 host login header provider、实际会话/部门上下文、自定义 IOA 和完整遥测生命周期仍不是本轮离线验证的对象。

## 改动与回退

- 本轮前像：`.codex-backup/alignment-20261120-110929/`，保留上一轮复审修复。
- [逐文件原始/目标 hash 与前像位置](docs/upstream-alignment-2026-11-20/changes.json)。
- 完整差异：该备份目录的 `alignment.patch`。
- 默认只校验，不写盘；`-Apply` 才恢复本轮文件并把本轮新增文件移入备份。后续 hash 已变的文件报冲突，不覆盖并发编辑。
- 同一文件与其它任务交叉编辑时，按差异手工挑选更精确；脚本恢复的是整个登记前像，不是语义级只撤销某一行。

```powershell
& '.\.codex-backup\alignment-20261120-110929\Restore-Alignment.ps1'
& '.\.codex-backup\alignment-20261120-110929\Restore-Alignment.ps1' -Apply
```
