"use client";
// 接入引导视图：把「取模型 → 选模型 → 发对话」三步完整摊开。
// 地址按当前访问域名自动生成：本机访问显示 127.0.0.1，线上域名访问显示线上域名。
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getKey, req } from "../lib";
import { Box } from "../components/ui";
import { CtrlHint } from "../components/ctrl";

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

// realmLabel 按模型 ID 前缀标注路由通道。
function realmLabel(id: string): string {
  if (id.startsWith("cn:")) return "CN 池";
  if (id.startsWith("global:")) return "GLOBAL 池";
  return id.includes(":") ? "供应商" : "CN 池";
}

// fallbackCopy 非安全上下文（HTTP 局域网）下 Clipboard API 不可用时走 textarea。
function fallbackCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      if (ok) resolve();
      else reject(new Error("copy failed"));
    } catch (e) {
      reject(e);
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
function CopyRow({ label, value, tip, copied, onCopy }: {
  label: string; value: string; tip?: string;
  copied: string; onCopy: (v: string) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "6px 0", flexWrap: "wrap" }}>
      <span style={{ minWidth: 104, fontSize: 12, color: "var(--fg-dim)" }}>{label}</span>
      <code
        style={{
          flex: "1 1 180px", minWidth: 0, background: "var(--bg-soft)", padding: "5px 8px",
          borderRadius: 6, fontSize: 12, fontFamily: "var(--mono)",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}
        title={value}
      >{value}</code>
      {tip && <span style={{ fontSize: 11, color: "var(--fg-dim)" }}>{tip}</span>}
      <button className="btn xs" onClick={() => onCopy(value)}>
        {copied === value ? "已复制" : "复制"}
      </button>
    </div>
  );
}

// UrlLine 主地址行：地址独占一行，避免被标签挤成省略号。
function UrlLine({ value, copied, onCopy }: {
  value: string; copied: string; onCopy: (v: string) => void;
}) {
  return (
    <div className="url-line">
      <code title={value}>{value}</code>
      <button className="btn xs" onClick={() => onCopy(value)}>
        {copied === value ? "已复制" : "复制"}
      </button>
    </div>
  );
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

function capsOf(m: ModelRow | undefined): string {
  if (!m) return "";
  const out: string[] = [];
  if (m.is_default) out.push("默认");
  if (m.supports_tool_call) out.push("工具调用");
  if (m.supports_images) out.push("图片");
  if (m.supports_reasoning) out.push("思考");
  if (typeof m.context_length === "number" && m.context_length > 0) {
    out.push("上下文 " + (m.context_length >= 1000 ? Math.round(m.context_length / 1000) + "K" : m.context_length));
  }
  if (m.credits !== undefined && m.credits !== "") out.push("倍率 " + String(m.credits));
  return out.join(" · ");
}

export function ConnectView() {
  const [origin, setOrigin] = useState("");
  const [key, setKey] = useState("");
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
    setKey(getKey());
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
      setModelErr(msg === "__AUTH__" ? "面板登录已失效，请重新输入密钥" : msg);
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
  const chatUrl = openaiBase + "/chat/completions";
  const messagesUrl = anthropicBase + "/v1/messages";
  const k = key || "<面板主密钥或网关子密钥>";
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
      window.setTimeout(() => setCopied(""), 1500);
    }).catch(() => {});
  }, []);

  const curlModels =
`curl ${modelsUrl} \\
  -H "Authorization: Bearer ${k}"`;

  const curlChat =
`curl ${chatUrl} \\
  -H "Authorization: Bearer ${k}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}]}'`;

  const httpMessages =
`POST ${messagesUrl}
x-api-key: ${k}
anthropic-version: 2023-06-01
Content-Type: application/json

{
  "model": "${model}",
  "max_tokens": 256,
  "messages": [{"role": "user", "content": "你好"}]
}`;

  return (
    <>
      <Box
        title="接入引导"
        hint="三步：取模型 → 选模型 → 发对话；地址按当前访问域名自动生成"
        extra={<button className="btn xs" onClick={() => void loadModels()} disabled={loadingModels}>
          {loadingModels ? "读取中…" : "刷新模型"}
        </button>}
        pad
      >
        {!key && (
          <div className="msg err" style={{ marginBottom: 12 }}>
            未读取到面板密钥：下方示例里的 <code>{k}</code> 需要替换成你自己的 WB2A_API_KEY 或网关子密钥。
          </div>
        )}

        <div className="connect-flow">
          <b>01 取模型</b><i>→</i><b>02 选模型</b><i>→</i><b>03 发对话</b>
          <span style={{ marginLeft: "auto" }}>
            当前域名 <code>{base}</code>
          </span>
        </div>

        <div className="connect-steps">
          {/* ① 获取模型 */}
          <StepCard no="01" method="GET" title="获取模型" desc="拉取当前可用的模型 ID 列表">
            <div className="url-label">请求地址</div>
            <UrlLine value={modelsUrl} copied={copied} onCopy={copy} />
            <CtrlHint>
              鉴权头：<code>Authorization: Bearer &lt;Key&gt;</code>。
              返回 <code>{"{ object: \"list\", data: [...] }"}</code>，其中
              <code>data[].id</code> 就是下一步要填的 <code>model</code>。
            </CtrlHint>
            <pre>{curlModels}</pre>
            <CtrlHint>
              未带鉴权头直接打开会返回 401。模型列表页也可查看完整能力与倍率。
            </CtrlHint>
          </StepCard>

          {/* ② 发起对话 */}
          <StepCard no="02" method="POST" title="发起对话" desc="两种协议任选，模型 ID 与上一步一致">
            <div className="url-label">OpenAI 兼容 · Chat Completions</div>
            <UrlLine value={chatUrl} copied={copied} onCopy={copy} />
            <pre>{curlChat}</pre>
            <div className="url-label" style={{ marginTop: 4 }}>Anthropic 兼容 · Messages</div>
            <UrlLine value={messagesUrl} copied={copied} onCopy={copy} />
            <pre>{httpMessages}</pre>
            <CtrlHint>
              OpenAI SDK 的 <code>base_url</code> 填 <code>{openaiBase}</code>；
              Anthropic SDK / Claude Code 的 Base URL 填 <code>{anthropicBase}</code>，
              客户端会自动补 <code>/v1/messages</code>。
            </CtrlHint>
          </StepCard>

          {/* ③ 开哪个模型 */}
          <StepCard no="03" method="MODEL" title="开哪个模型" desc="从列表选一个，或直接输入完整模型 ID">
            <div className="model-pick">
              <input
                className="input"
                list="connect-model-options"
                value={model}
                onChange={(e) => setSelected(e.target.value)}
                placeholder="从列表选择，或直接填模型 ID"
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
                <code>{model}</code>
                <span className="realm-chip">{realmLabel(model)}</span>
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
                ? "正在读取模型目录…"
                : "共 " + models.length + " 个可选模型" + (modelErr ? "（读取失败：" + modelErr + "）" : "") + "。模型 ID 必须原样使用，前缀决定路由通道。"}
            </CtrlHint>
          </StepCard>
        </div>

        <div className="connect-legend">
          <span><code>cn:</code> 国区账号池，如 <code>cn:glm-5.2</code></span>
          <span><code>global:</code> 国际版账号池，如 <code>global:gpt-5</code></span>
          <span><code>供应商名:</code> 聚合供应商，如 <code>xxx:model</code></span>
          <span><code>裸名</code> 默认走 CN，如 <code>glm-5.2</code></span>
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
            <table className="tbl">
              <thead>
                <tr><th>模型 ID</th><th>通道</th><th>能力</th><th>倍率</th><th></th></tr>
              </thead>
              <tbody>
                {filteredModels.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">{m.id}</td>
                    <td><span className="realm-chip">{realmLabel(m.id)}</span></td>
                    <td className="dim" style={{ fontSize: 11 }}>{capsOf(m).replace(/^默认 · /, "") || "—"}</td>
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
                ? "正在读取模型目录…"
                : modelErr ? "模型目录读取失败：" + modelErr : "暂无可用模型，请先在「账号池」添加账号")
              : "没有匹配的模型，换个关键词试试"}
          </div>
        )}
      </Box>

      <Box title="客户端怎么填" hint="只认 Base URL + API Key + 模型名三样" pad>
        <div className="connect-grid">
          <div className="connect-card">
            <h4>OpenAI 兼容客户端</h4>
            <CopyRow label="BASE URL" value={openaiBase} tip="Cherry Studio / LobeChat" copied={copied} onCopy={copy} />
            <CopyRow label="API KEY" value={k} copied={copied} onCopy={copy} />
            <CopyRow label="MODEL" value={model} copied={copied} onCopy={copy} />
            <pre>{`base_url: ${openaiBase}
api_key:  ${k}
model:    ${model}`}</pre>
            <CtrlHint>
              服务商类型选「OpenAI 兼容 / 自定义」。Base URL 只填到
              <code>{openaiBase}</code>，不要带 <code>/chat/completions</code>。
            </CtrlHint>
          </div>

          <div className="connect-card">
            <h4>Anthropic / Claude Code</h4>
            <CopyRow label="BASE URL" value={anthropicBase} tip="会拼 /v1/messages" copied={copied} onCopy={copy} />
            <CopyRow label="AUTH TOKEN" value={k} copied={copied} onCopy={copy} />
            <CopyRow label="MODEL" value={model} copied={copied} onCopy={copy} />
            <pre>{`ANTHROPIC_BASE_URL=${anthropicBase}
ANTHROPIC_AUTH_TOKEN=${k}
ANTHROPIC_MODEL=${model}`}</pre>
            <CtrlHint>
              Base URL 只填到 <code>{anthropicBase}</code>；SDK/CLI 自己拼
              <code>/v1/messages</code>，填完整端点会 404。只认
              <code>ANTHROPIC_API_KEY</code> 的客户端也可以改用该变量（网关同时接受
              <code>x-api-key</code>）。
            </CtrlHint>
          </div>

          <div className="connect-card">
            <h4>Python OpenAI SDK</h4>
            <pre>{`from openai import OpenAI

client = OpenAI(
    base_url="${openaiBase}",
    api_key="${k}",
)

resp = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "你好"}],
)`}</pre>
            <CtrlHint>
              流式请求（<code>stream: true</code>）同样走 <code>{chatUrl}</code>。
              若提示 404，检查 Base URL 是否多写或少写了 <code>/api/v1</code>。
            </CtrlHint>
          </div>
        </div>

        <div className="connect-verify">
          <b>最小验收</b>
          <span>① <code>GET /api/v1/models</code> 返回 200 且 <code>data[]</code> 非空</span>
          <span>② <code>POST /api/v1/chat/completions</code> 返回 <code>choices[0]</code></span>
        </div>

        <div className="msg ok" style={{ marginTop: 14 }}>
          密钥即面板登录密钥（WB2A_API_KEY）；网关子密钥在「供应商与密钥」页创建，供分发给他人使用。
          模型别名/前缀由网关路由：<code>cn:</code> 走国区账号池，<code>global:</code> 走国际版，
          <code>名称:</code> 走对应聚合供应商。
        </div>
      </Box>

      <Box title="排错速查" hint="接入时最常见的四类问题" pad>
        <div className="connect-faq">
          <div className="faq-item">
            <span className="faq-code">401</span>
            <div>
              <b>invalid or missing api key</b>
              <p>
                没带鉴权头或 Key 不正确。OpenAI 风格用 <code>Authorization: Bearer &lt;Key&gt;</code>，
                Anthropic 风格用 <code>x-api-key: &lt;Key&gt;</code>；粘贴时不要带引号和空格。
              </p>
            </div>
          </div>
          <div className="faq-item">
            <span className="faq-code">404</span>
            <div>
              <b>路径不对</b>
              <p>
                Base URL 填成了完整端点。OpenAI 兼容只填到 <code>/api/v1</code>，
                Anthropic 只填到 <code>/api</code>；先用 <code>GET /api/v1/models</code> 确认网关可达。
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
        </div>
      </Box>
    </>
  );
}
