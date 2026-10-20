"use client";
// 模型鉴别视图（hlwy-ai-checker 集成版）：同源 iframe 内嵌原项目前端，
// 面板 API key 通过 postMessage 注入 iframe 的 fetch 拦截器（bridge.js），
// 不落 localStorage、不经页面输入框。
import React, { useCallback, useRef } from "react";
import { getKey } from "../lib";
import { Box } from "../components/ui";

export function AiCheckerView() {
  const ref = useRef<HTMLIFrameElement>(null);

  const sendKey = useCallback(() => {
    ref.current?.contentWindow?.postMessage(
      { type: "wb2a-auth", key: getKey() },
      window.location.origin,
    );
  }, []);

  // iframe 就绪后回发一次 key（bridge.js 加载完成时主动索要）。
  React.useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      if (ev.origin === window.location.origin && ev.data?.type === "aichecker-ready") sendKey();
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [sendKey]);

  return (
    <Box title="模型指纹鉴别" hint="hlwy-ai-checker v2.6.1 集成版 · 探测请求经面板代理转发，密钥仅存在于本次会话">
      <iframe
        ref={ref}
        src="/aichecker/index.html"
        onLoad={sendKey}
        title="AI 模型鉴别器"
        style={{ display: "block", width: "100%", height: "calc(100vh - 260px)", minHeight: 560, border: 0, background: "#0b0e14" }}
      />
    </Box>
  );
}
