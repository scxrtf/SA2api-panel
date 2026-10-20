"use client";
// 接入引导视图（对齐 Go view-connect）：给出 OpenAI / Anthropic / 通用三类接入片段。
import React, { useEffect, useState } from "react";
import { getKey } from "../lib";
import { Box } from "../components/ui";
import { CtrlValue, CtrlHint } from "../components/ctrl";

export function ConnectView() {
  const [origin, setOrigin] = useState("");
  const [key, setKeyState] = useState("");
  useEffect(() => {
    setOrigin(window.location.origin);
    setKeyState(getKey());
  }, []);

  const base = origin || "https://<你的域名>";
  const openaiBase = base + "/api/v1";
  const anthropicBase = base + "/api";
  const k = key || "<WB2A_API_KEY>";

  return (
    <>
      <Box title="接入引导" hint="把面板地址 + 主密钥填进任意 OpenAI / Anthropic 兼容客户端即可" pad>
        <div className="connect-grid">
          <div className="connect-card">
            <h4>OpenAI 兼容（Chat Completions）</h4>
            <div style={{ display: "grid", gap: 8, marginBottom: 4 }}>
              <CtrlValue label="BASE URL" value={openaiBase} accent />
              <CtrlValue label="API KEY" value={k} />
            </div>
            <pre>{`base_url: ${openaiBase}
api_key:  ${k}
model:    glm-5.2`}</pre>
          </div>
          <div className="connect-card">
            <h4>Anthropic 兼容（Messages）</h4>
            <div style={{ display: "grid", gap: 8, marginBottom: 4 }}>
              <CtrlValue label="BASE URL" value={anthropicBase} accent />
              <CtrlValue label="AUTH TOKEN" value={k} />
            </div>
            <pre>{`ANTHROPIC_BASE_URL=${anthropicBase}
ANTHROPIC_AUTH_TOKEN=${k}
ANTHROPIC_MODEL=glm-5.2`}</pre>
          </div>
          <div className="connect-card">
            <h4>curl 验证</h4>
            <div style={{ marginBottom: 4 }}>
              <CtrlHint>列出当前可用模型：</CtrlHint>
            </div>
            <pre>{`curl ${openaiBase}/models \\
  -H "Authorization: Bearer ${k}"`}</pre>
          </div>
        </div>
        <div className="msg ok" style={{ marginTop: 14 }}>
          密钥即面板登录密钥（WB2A_API_KEY）。网关子密钥在「供应商与密钥」页创建，供分发给他人使用。
        </div>
      </Box>
    </>
  );
}
