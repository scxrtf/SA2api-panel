"use client";
// 接入引导：端点、请求样例和客户端配置共用当前访问地址与选中的模型 ID。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { req } from "../lib";
import { Box, ButtonLoadingContent, LoadingIndicator } from "../components/ui";

interface ModelRow {
  id: string;
  name?: string;
  credits?: number | string;
  vendor?: string;
  provider?: boolean;
  is_default?: boolean;
  supports_tool_call?: boolean;
  supports_images?: boolean;
  supports_reasoning?: boolean;
  context_length?: number;
}

const MODEL_STORE = "wb2a_connect_model";
const bashQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

function curlJson(url: string, payload: Record<string, unknown>, headers: string[] = []) {
  return ["curl " + bashQuote(url), '  -H "Content-Type: application/json"', ...headers,
    "  -d " + bashQuote(JSON.stringify(payload, null, 2))].join(" \\\n");
}

// realmLabel 按模型 ID 前缀标注路由通道。
function realmLabel(id: string): string {
  if (id.startsWith("cn:")) return "CN 池";
  if (id.startsWith("global:")) return "GLOBAL 池";
  return id.includes(":") ? "供应商" : "CN 池";
}

// fallbackCopy 非安全上下文（HTTP 局域网）下 Clipboard API 不可用时走 textarea。
function fallbackCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const active = document.activeElement;
    const ta = document.createElement("textarea");
    try {
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      if (ok) resolve();
      else reject(new Error("copy failed"));
    } catch (e) {
      reject(e);
    } finally {
      ta.remove();
      if (active instanceof HTMLElement) active.focus({ preventScroll: true });
    }
  });
}

// copyText 优先 Clipboard API，被浏览器拒绝时回退 textarea。
function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  }
  return fallbackCopy(text);
}

// CopyRow 一行「标签 + 等宽值 + 复制」。值本身可点选，复制走剪贴板。
function CopyRow({ label, value, copied, onCopy }: {
  label: string; value: string;
  copied: string; onCopy: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0", flexWrap: "wrap" }}>
      <span className="copy-label" style={{ fontSize: 12, color: "var(--fg-dim)" }}>{label}</span>
      <code dir="ltr"
        style={{
          flex: "1 1 180px", minWidth: 0, background: "var(--bg-soft)", padding: "5px 8px",
          borderRadius: 6, fontSize: 12, fontFamily: "var(--mono)",
          whiteSpace: "normal", overflowWrap: "anywhere",
        }}
        title={value}
      >{value}</code>
      <Button size="xs" variant="outline" type="button" onClick={() => onCopy(value)} aria-label={`复制 ${label}`}>
        {copied === value ? "已复制" : "复制"}
      </Button>
    </div>
  );
}

// UrlLine 主地址行：地址独占一行，避免被标签挤成省略号。
function UrlLine({ label, value, copied, onCopy }: {
  label: string; value: string; copied: string; onCopy: (v: string) => void;
}) {
  return (
    <div className="url-line">
      <code dir="ltr" title={value} style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{value}</code>
      <Button size="xs" variant="outline" type="button" className="ml-auto" onClick={() => onCopy(value)} aria-label={`复制 ${label} 地址`}>
        {copied === value ? "已复制" : "复制"}
      </Button>
    </div>
  );
}

function CodeSnippet({ label, value, copied, onCopy }: {
  label: string; value: string; copied: string; onCopy: (v: string) => void;
}) {
  return (
    <div className="min-w-0">
      <pre dir="ltr" tabIndex={0} aria-label={label} style={{ fontSize: 12 }}
        className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"><code>{value}</code></pre>
      <div className="mt-2 flex justify-end">
        <Button size="xs" variant="outline" type="button" onClick={() => onCopy(value)} aria-label={`复制 ${label}`}>
          {copied === value ? "已复制" : "复制示例"}
        </Button>
      </div>
    </div>
  );
}

function CtrlHint({ children }: { children: React.ReactNode }) {
  return <div className="ctrl-hint" style={{ fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>{children}</div>;
}

// StepCard 带编号与 method 徽章的三步卡片。
function StepCard({ no, method, title, desc, children }: {
  no: string; method: string; title: string; desc?: string; children: React.ReactNode;
}) {
  return (
    <section className="connect-step">
      <div className="step-top">
        <span className="step-no">{no}</span>
        <span className={"method " + method.toLowerCase()}>{method}</span>
        <h4>{title}</h4>
      </div>
      {desc && <div className="step-desc">{desc}</div>}
      {children}
    </section>
  );
}

// pickDefault 选一个推荐模型：上游 is_default → cn:glm-5.2 → 首个池模型 → 首个。
function pickDefault(models: ModelRow[]): string {
  return (
    models.find((m) => m.is_default)?.id ??
    models.find((m) => m.id === "cn:glm-5.2")?.id ??
    models.find((m) => !m.provider)?.id ??
    models[0]?.id ??
    ""
  );
}

function capsOf(m: ModelRow | undefined, showDefault = true): string {
  if (!m) return "";
  const out: string[] = [];
  if (showDefault && m.is_default) out.push("默认");
  if (m.supports_tool_call) out.push("工具调用");
  if (m.supports_images) out.push("图片");
  if (m.supports_reasoning) out.push("思考");
  if (typeof m.context_length === "number" && m.context_length > 0) {
    out.push("上下文 " + (m.context_length >= 1000 ? Math.round(m.context_length / 1000) + "K" : m.context_length));
  }
  if (m.credits !== undefined && m.credits !== "") out.push("倍率 " + String(m.credits));
  return out.join(" / ");
}

export function ConnectView() {
  const [origin, setOrigin] = useState("");
  const [models, setModels] = useState<ModelRow[]>([]);
  const [modelErr, setModelErr] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [selected, setSelected] = useState("");
  const [copied, setCopied] = useState("");
  const [query, setQuery] = useState("");

  // 浏览器专属 API（location / localStorage）只能在挂载后读取：
  // 首帧保持空值以匹配 SSR，再同步到真实值，避免 hydration 不一致。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setOrigin(window.location.origin);
    try {
      const saved = localStorage.getItem(MODEL_STORE);
      if (saved) setSelected(saved);
    } catch { /* localStorage 不可用则忽略 */ }
  }, []);

  useEffect(() => {
    if (!selected) return;
    try { localStorage.setItem(MODEL_STORE, selected); } catch { /* 忽略 */ }
  }, [selected]);

  const loadModels = useCallback(async () => {
    setLoadingModels(true);
    setModelErr("");
    try {
      const r = await req<{ models: ModelRow[] }>("models");
      const list = r.models ?? [];
      setModels(list);
      setSelected((prev) => prev || pickDefault(list));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setModelErr(msg);
      setModels([]);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => { void loadModels(); }, [loadModels]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const base = (origin || "https://<你的域名>").replace(/\/+$/, "");
  const openaiBase = base + "/api/v1";
  const anthropicBase = base + "/api";
  const modelsUrl = openaiBase + "/models";
  const responsesUrl = openaiBase + "/responses";
  const chatUrl = openaiBase + "/chat/completions";
  const messagesUrl = anthropicBase + "/v1/messages";
  const model = selected || pickDefault(models) || "cn:glm-5.2";

  const modelOptions = useMemo(
    () => [...models].sort((a, b) => Number(!!b.is_default) - Number(!!a.is_default)),
    [models],
  );
  // quickPicks：把「最该先试」的几个模型提到最上面——上游默认、常用 GLM、
  // 支持工具调用/思考的各取一个，再补足到 6 个，避免用户面对长列表无从下手。
  const quickPicks = useMemo(() => {
    const picks: ModelRow[] = [];
    const seen = new Set<string>();
    const push = (m: ModelRow | undefined) => {
      if (m && !seen.has(m.id)) { seen.add(m.id); picks.push(m); }
    };
    push(models.find((m) => m.is_default));
    push(models.find((m) => m.id === "cn:glm-5.2"));
    push(models.find((m) => m.id === "cn:glm-5"));
    push(models.find((m) => m.supports_tool_call));
    push(models.find((m) => m.supports_reasoning));
    for (const m of models) {
      if (picks.length >= 6) break;
      push(m);
    }
    return picks;
  }, [models]);
  const current = models.find((m) => m.id === model);
  const caps = capsOf(current);

  // filteredModels：模型目录搜索（ID / 展示名 / 供应商）。
  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return modelOptions;
    return modelOptions.filter((m) =>
      m.id.toLowerCase().includes(q) ||
      (m.name ?? "").toLowerCase().includes(q) ||
      (m.vendor ?? "").toLowerCase().includes(q),
    );
  }, [modelOptions, query]);

  const copy = useCallback((v: string) => {
    copyText(v).then(() => {
      setCopied(v);
      window.setTimeout(() => setCopied((current) => current === v ? "" : current), 2500);
    }).catch(() => {});
  }, []);

  const curlModels = "curl " + bashQuote(modelsUrl);
  const curlResponses = curlJson(responsesUrl, { model, input: "你好", store: false });
  const messages = [{ role: "user", content: "你好" }];
  const curlChat = curlJson(chatUrl, { model, messages });
  const curlMessages = curlJson(messagesUrl, { model, max_tokens: 256, messages }, ['  -H "anthropic-version: 2023-06-01"']);

  const codexConfig = `model = ${JSON.stringify(model)}
model_provider = "wb2api"
web_search = "disabled"

[model_providers.wb2api]
name = "wb2api"
base_url = ${JSON.stringify(openaiBase)}
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false`;

  const pythonResponses = `from openai import OpenAI

client = OpenAI(
    base_url=${JSON.stringify(openaiBase)},
    api_key=None,
)
reply = client.responses.create(
    model=${JSON.stringify(model)},
    input="你好",
    store=False,
)
print(reply.output_text)`;

  return (
    <>
      <Box
        title="接入引导"
        hint="OpenAI Responses、Chat Completions 和 Anthropic Messages"
        extra={<Button size="xs" variant="outline" onClick={() => void loadModels()} disabled={loadingModels} aria-busy={loadingModels}>
          <ButtonLoadingContent loading={loadingModels} loadingChildren="读取中…">刷新模型</ButtonLoadingContent>
        </Button>}
        pad
      >
        <div className="connect-flow">
          <b>01 取模型</b><i>→</i><b>02 选模型</b><i>→</i><b>03 发对话</b>
          <span style={{ marginLeft: "auto" }}>
            当前域名 <code>{base}</code>
          </span>
        </div>

        <div className="mb-3">
          <CtrlHint>
            cURL 示例使用 Bash，网站与网关默认免验证密钥。创建子密钥后，客户端需改用对应的
            <code>Authorization: Bearer &lt;子密钥&gt;</code>。
          </CtrlHint>
        </div>

        <div className="connect-steps">
          {/* ① 获取模型 */}
          <StepCard no="01" method="GET" title="获取模型" desc="拉取当前可用的模型 ID 列表">
            <UrlLine label="模型目录" value={modelsUrl} copied={copied} onCopy={copy} />
            <CtrlHint>
              将返回的 <code>data[].id</code> 原样填入下一步。已配置的原生 Responses 模型也以此目录为准。
            </CtrlHint>
            <CodeSnippet label="模型目录命令" value={curlModels} copied={copied} onCopy={copy} />
          </StepCard>

          {/* ② 选择模型 */}
          <StepCard no="02" method="MODEL" title="选择模型" desc="选中的 ID 会自动填入请求和客户端配置。">
            <div className="model-pick">
              <input
                className="input"
                list="connect-model-options"
                value={model}
                onChange={(e) => setSelected(e.target.value)}
                placeholder="从列表选择，或直接填模型 ID"
                aria-label="模型 ID"
                style={{ flex: 1, minWidth: 0, fontFamily: "var(--mono)", fontSize: 12 }}
              />
              <datalist id="connect-model-options">
                {modelOptions.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
              </datalist>
              <button className="btn xs" onClick={() => copy(model)}>
                {copied === model ? "已复制" : "复制"}
              </button>
            </div>

            <div className="model-current">
              <div className="id">
                <code dir="ltr" style={{ minWidth: 0, overflowWrap: "anywhere" }}>{model}</code>
                {current && <span className="realm-chip">{realmLabel(current.id)}</span>}
              </div>
              <div className="caps">{caps || (modelErr ? "模型目录读取失败" : "—")}</div>
            </div>

            {quickPicks.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {quickPicks.map((m) => (
                  <button
                    key={m.id}
                    className="btn xs"
                    title={capsOf(m) || m.id}
                    style={m.id === model ? { background: "var(--ink)", color: "#fff", borderColor: "var(--ink)" } : undefined}
                    onClick={() => setSelected(m.id)}
                  >
                    {m.is_default ? "★ " : ""}{m.id}
                  </button>
                ))}
              </div>
            )}

            <CtrlHint>
              {loadingModels
                ? <LoadingIndicator inline label="正在读取模型目录…" />
                : modelErr ? "目录读取失败，可直接填入已知模型 ID。" : "当前目录有 " + models.length + " 个模型。"}
            </CtrlHint>
          </StepCard>

          {/* ③ 发起对话 */}
          <StepCard no="03" method="POST" title="发送请求">
            <Tabs defaultValue="responses" className="min-w-0 flex-col gap-3">
              <TabsList aria-label="请求协议" variant="line"
                className="h-auto w-full max-w-full flex-wrap justify-start gap-y-2">
                <TabsTrigger value="responses" className="h-7 flex-none text-xs aria-selected:border-b-foreground">Responses</TabsTrigger>
                <TabsTrigger value="chat" className="h-7 flex-none text-xs aria-selected:border-b-foreground">Chat Completions</TabsTrigger>
                <TabsTrigger value="messages" className="h-7 flex-none text-xs aria-selected:border-b-foreground">Messages</TabsTrigger>
              </TabsList>
              <TabsContent value="responses" className="min-w-0 space-y-2">
                <UrlLine label="Responses" value={responsesUrl} copied={copied} onCopy={copy} />
                <CodeSnippet label="Responses cURL" value={curlResponses} copied={copied} onCopy={copy} />
                <CtrlHint>
                  请求用 <code>input</code>；从 <code>output[].content[]</code> 中读取 <code>output_text</code> 项的 <code>text</code>。
                  流式模式设 <code>{'"stream": true'}</code>，用 <code>curl -N</code> 查看 <code>response.output_text.delta</code> 事件。
                </CtrlHint>
              </TabsContent>
              <TabsContent value="chat" className="min-w-0 space-y-2">
                <UrlLine label="Chat Completions" value={chatUrl} copied={copied} onCopy={copy} />
                <CodeSnippet label="Chat Completions cURL" value={curlChat} copied={copied} onCopy={copy} />
                <CtrlHint>请求用 <code>messages</code>，回复在 <code>choices[0].message</code>。</CtrlHint>
              </TabsContent>
              <TabsContent value="messages" className="min-w-0 space-y-2">
                <UrlLine label="Messages" value={messagesUrl} copied={copied} onCopy={copy} />
                <CodeSnippet label="Messages cURL" value={curlMessages} copied={copied} onCopy={copy} />
                <CtrlHint>Anthropic Messages 请求包含 <code>messages</code> 和 <code>max_tokens</code>。</CtrlHint>
              </TabsContent>
            </Tabs>
          </StepCard>
        </div>

        <div className="connect-legend">
          <span><code>cn:</code> 国区账号池，如 <code>cn:glm-5.2</code></span>
          <span><code>global:</code> 国际版账号池，如 <code>global:gpt-5</code></span>
          <span><code>供应商名:</code> 聚合供应商，如 <code>xxx:model</code></span>
          <span><code className="shrink-0 whitespace-nowrap">裸名</code> 默认走 CN；原生模型 ID 以目录为准。</span>
        </div>

        <div className="connect-catalog-head">
          <h4>模型目录 <span className="dim">({filteredModels.length}/{models.length})</span></h4>
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索模型 ID / 名称 / 供应商"
            aria-label="搜索模型"
          />
        </div>

        {filteredModels.length > 0 ? (
          <div className="connect-catalog">
            <table className="tbl tbl-catalog">
              <thead>
                <tr><th>模型 ID</th><th>通道</th><th>能力</th><th>倍率</th><th></th></tr>
              </thead>
              <tbody>
                {filteredModels.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.id}</td>
                    <td><span className="realm-chip">{realmLabel(m.id)}</span></td>
                    <td className="dim" style={{ fontSize: 12 }}>{capsOf(m, false) || "—"}</td>
                    <td className="mono">{m.credits === undefined || m.credits === "" ? "—" : String(m.credits)}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                      <button className="btn xs" onClick={() => copy(m.id)} style={{ marginRight: 6 }}>
                        {copied === m.id ? "已复制" : "复制"}
                      </button>
                      <button className="btn xs" disabled={m.id === model} onClick={() => setSelected(m.id)}>
                        {m.id === model ? "已选" : "填入"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="connect-empty">
            {models.length === 0
              ? (loadingModels
                ? <LoadingIndicator inline label="正在读取模型目录…" />
                : modelErr ? "模型目录读取失败：" + modelErr : "暂无可用模型，请先在「账号池」添加账号")
              : "没有匹配的模型，换个关键词试试"}
          </div>
        )}
      </Box>

      <Box title="客户端怎么填" pad>
        <div className="grid grid-cols-1 gap-3.5 min-[901px]:grid-cols-2">
          <div className="connect-card">
            <h4>Codex（Responses）</h4>
            <CtrlHint>将示例合并到 <code>~/.codex/config.toml</code>；网站免验证密钥，无需设置主密钥。</CtrlHint>
            <CodeSnippet label="Codex 配置" value={codexConfig} copied={copied} onCopy={copy} />
            <CtrlHint>
              使用 HTTP/SSE，保持 <code>supports_websockets = false</code>。搭配 WorkBuddy 或 Chat 上游时关闭服务端网页搜索。
            </CtrlHint>
          </div>

          <div className="connect-card">
            <h4>OpenAI SDK（Python）</h4>
            <CtrlHint>调用 <code>client.responses.create()</code>。示例使用 <code>store=False</code>，无需先启用响应存档。</CtrlHint>
            <CodeSnippet label="Python Responses 示例" value={pythonResponses} copied={copied} onCopy={copy} />
          </div>

          <div className="connect-card">
            <h4>OpenAI 兼容客户端</h4>
            <CopyRow label="Base URL" value={openaiBase} copied={copied} onCopy={copy} />
            <CopyRow label="模型 ID" value={model} copied={copied} onCopy={copy} />
            <CtrlHint>
              Base URL 只填到 <code>/api/v1</code>，不要附加 <code>/responses</code> 或 <code>/chat/completions</code>。
              客户端若可选协议，按需选择 Responses 或 Chat Completions。
            </CtrlHint>
          </div>

          <div className="connect-card">
            <h4>Anthropic / Claude Code</h4>
            <CopyRow label="Anthropic Base URL" value={anthropicBase} copied={copied} onCopy={copy} />
            <pre>{`ANTHROPIC_BASE_URL=${anthropicBase}
ANTHROPIC_MODEL=${model}`}</pre>
            <CtrlHint>
              Base URL 只填到 <code>{anthropicBase}</code>；SDK/CLI 自己拼
              <code>/v1/messages</code>，填完整端点会 404。
            </CtrlHint>
          </div>

        </div>

        <div className="connect-verify">
          <b>最小验收</b>
          <span>① <code>GET /api/v1/models</code> 返回 200 且 <code>data[]</code> 非空</span>
          <span>② <code>POST /api/v1/responses</code> 返回 <code>{'object: "response"'}</code>，回复见 <code>output</code></span>
        </div>

        <div className="msg ok" style={{ marginTop: 14 }}>
          WorkBuddy 模型和现有 Chat 供应商无需另配上游即可使用 Responses。
          后台任务、托管工具和精确 token 计数需要网关配置原生 Responses 上游。
        </div>
      </Box>

      <Box title="供应商模型怎么接" hint="把第三方 OpenAI 兼容服务挂到本网关，模型名带供应商前缀" pad>
        <div className="connect-grid">
          <div className="connect-card">
            <h4>① 添加供应商</h4>
            <pre>{`curl -X POST ${origin}/api/panel/providers \\
  -H "Content-Type: application/json" \\
  -d '{
    "name": "myvendor",
    "base_url": "https://api.example.com/v1",
    "key": "sk-xxxx",
    "models": ""
  }'`}</pre>
            <CtrlHint>
              也可在面板「供应商与密钥」页表单添加。<code>name</code> 即调用前缀（中文/字母/数字/
              下划线/连字符）；<code>base_url</code> 只填主机也行，网关自动补 <code>/v1</code>；
              <code>models</code> 留空 = 暴露供应商全部模型，逗号分隔 = 只暴露白名单。
            </CtrlHint>
          </div>

          <div className="connect-card">
            <h4>② 用供应商前缀调用</h4>
            <pre>{`curl ${chatUrl} \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "myvendor:模型名",
    "messages": [{"role":"user","content":"你好"}]
  }'`}</pre>
            <CtrlHint>
              同一个 <code>myvendor:模型名</code> 也可用于 <code>/api/v1/responses</code>，网关会转换协议后调用该供应商。
              请求不经过账号池，用量仍记入 <code>provider:myvendor</code>。
            </CtrlHint>
          </div>

          <div className="connect-card">
            <h4>③ 实测与子密钥授权</h4>
            <pre>{`curl -X POST ${origin}/api/panel/models/test \\
  -H "Content-Type: application/json" \\
  -d '{"model": "myvendor:模型名"}'`}</pre>
            <CtrlHint>
              面板「模型」页的「实测」按钮同效果（最长 45s，返回 HTTP 状态与首条回复）。
              子密钥可在「供应商与密钥」页勾选供应商白名单：绑定后该密钥只能调用已勾选供应商，
              显式 <code>*</code> 表示全部供应商，留空表示未授权任何供应商。
            </CtrlHint>
          </div>
        </div>

        <div className="connect-verify">
          <b>供应商验收</b>
          <span>① <code>GET /api/v1/models</code> 出现 <code>myvendor:xxx</code> 条目</span>
          <span>② 带前缀的 <code>chat/completions</code> 返回 <code>choices[0]</code></span>
          <span>③ 面板「模型」页筛选「供应商」可看到目录；单个供应商失败不拖垮整表（错误进 warnings）</span>
        </div>
      </Box>

      <Box title="排错速查" pad>
        <div className="connect-faq">
          <div className="faq-item">
            <span className="faq-code">401</span>
            <div>
              <b>invalid or missing api key</b>
              <p>
                未创建子密钥时无需鉴权头。创建子密钥后，HTTP 请求发送 <code>Authorization: Bearer &lt;子密钥&gt;</code>。
              </p>
            </div>
          </div>
          <div className="faq-item">
            <span className="faq-code">404</span>
            <div>
              <b>路径不对</b>
              <p>
                OpenAI、Codex 的 Base URL 只填到 <code>/api/v1</code>，不加 <code>/responses</code>。
                Anthropic 填到 <code>/api</code>；先用 <code>GET /api/v1/models</code> 验证地址。
              </p>
            </div>
          </div>
          <div className="faq-item">
            <span className="faq-code">400</span>
            <div>
              <b>模型名不匹配</b>
              <p>
                <code>model</code> 必须与模型目录里的 <code>id</code> 完全一致。
                <code>cn:</code> / <code>global:</code> / <code>供应商名:</code> 前缀不能省；
                裸名只会按 CN 池解析。
              </p>
            </div>
          </div>
          <div className="faq-item">
            <span className="faq-code">429/5xx</span>
            <div>
              <b>账号池不可用</b>
              <p>
                账号冷却、限流或上游失败。换一个模型重试，或到「账号池」检查账号是否被禁用/暂停；
                无可用账号时模型目录也会为空。
              </p>
            </div>
          </div>
          <div className="faq-item">
            <span className="faq-code">503</span>
            <div>
              <b>Responses 存档未就绪</b>
              <p>
                收到 <code className="wrap-anywhere">responses_storage_unavailable</code> 时，先用 <code>{'"store": false'}</code> 验证连通。
                查询存档或用 <code>previous_response_id</code> 续聊前，由部署者应用对应的数据库迁移。
              </p>
            </div>
          </div>
        </div>
      </Box>
    </>
  );
}
