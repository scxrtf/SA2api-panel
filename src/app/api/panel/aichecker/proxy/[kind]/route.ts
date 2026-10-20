import { panelAuth, ok, fail } from "@/lib/panel-auth";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// hlwy-ai-checker 模型指纹探测的 API 代理（对齐原项目 start.py 的 proxy_api_request）。
// 转发 OpenAI chat/completions、OpenAI responses、Anthropic messages 三类端点，
// 目标地址由 X-Target-Base-URL 指定；并复刻 max_tokens ↔ max_completion_tokens
// 400 报错时的自动切换重试（_post_adaptive）。

const KIND_PATH: Record<string, string> = {
  "chat-completions": "/chat/completions",
  messages: "/messages",
  responses: "/responses",
};

export async function POST(
  req: Request,
  ctx: { params: Promise<{ kind: string }> },
) {
  const auth = await panelAuth(req);
  if (auth) return auth;
  const { kind } = await ctx.params;
  const suffix = KIND_PATH[kind];
  if (!suffix) return fail(404, "endpoint not found");

  const base = (req.headers.get("X-Target-Base-URL") ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return fail(400, "X-Target-Base-URL invalid");
  const target = base + suffix;

  const preset = req.headers.get("X-Header-Preset") ?? "default";
  const headers = presetHeaders(preset);
  for (const [src, dst] of [
    ["Content-Type", "content-type"],
    ["Authorization", "authorization"],
    ["anthropic-version", "anthropic-version"],
    ["x-api-key", "x-api-key"],
  ] as const) {
    const v = req.headers.get(src);
    if (v) headers[dst] = v;
  }

  const body = await req.text();
  try {
    let resp = await post(target, body, headers);
    resp = await adaptMaxTokens(resp, target, body, headers, suffix);
    const raw = await resp.arrayBuffer();
    return new Response(raw, {
      status: resp.status,
      headers: { "Content-Type": resp.headers.get("Content-Type") ?? "application/json" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /abort|timeout/i.test(msg);
    return fail(isTimeout ? 504 : 502, (isTimeout ? "请求超时: " : "网络错误: ") + msg);
  }
}

// 原项目的请求头伪装预设（claude-code / codex 对齐官方 JS SDK 指纹），
// 避免中转站按 python-requests / 浏览器指纹识别探测流量。
function presetHeaders(preset: string): Record<string, string> {
  const os = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "MacOS" : "Linux";
  const arch = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : "other:" + process.arch;
  if (preset === "claude-code") {
    return {
      accept: "application/json",
      "user-agent": "Anthropic/JS 0.109.0",
      "x-stainless-lang": "js",
      "x-stainless-package-version": "0.109.0",
      "x-stainless-os": os,
      "x-stainless-arch": arch,
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": process.version,
      "x-stainless-retry-count": "0",
    };
  }
  if (preset === "codex") {
    return {
      accept: "application/json",
      "user-agent": "OpenAI/JS 6.45.0",
      "x-stainless-lang": "js",
      "x-stainless-package-version": "6.45.0",
      "x-stainless-os": os,
      "x-stainless-arch": arch,
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": process.version,
      "x-stainless-retry-count": "0",
      "openai-beta": "responses_websockets=2026-02-06",
      "x-codex-installation-id": crypto.randomUUID(),
    };
  }
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  };
}

function post(target: string, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(target, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });
}

// 对齐 start.py _post_adaptive：新版模型只认 max_completion_tokens、
// 旧模型/部分中转只认 max_tokens，按 400 报错文案自动切换重试一次。
async function adaptMaxTokens(
  resp: Response, target: string, body: string,
  headers: Record<string, string>, suffix: string,
): Promise<Response> {
  if (resp.status !== 400 || suffix !== "/chat/completions") return resp;
  const errText = (await resp.text()).toLowerCase();
  const replay = () => new Response(errText, { status: resp.status, headers: resp.headers });
  if (!errText.includes("max_tokens") && !errText.includes("max_completion_tokens")) return replay();
  if (!errText.includes("unsupported_parameter") && !errText.includes("unknown parameter")) return replay();
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(body); } catch { return replay(); }
  let changed = false;
  if ("max_tokens" in obj && errText.includes("max_completion_tokens")) {
    obj.max_completion_tokens = obj.max_tokens;
    delete obj.max_tokens;
    changed = true;
  } else if ("max_completion_tokens" in obj && errText.includes("max_tokens")) {
    obj.max_tokens = obj.max_completion_tokens;
    delete obj.max_completion_tokens;
    changed = true;
  }
  if (!changed) return replay();
  return post(target, JSON.stringify(obj), headers);
}
