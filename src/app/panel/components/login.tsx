"use client";
// 登录页（CloseRouter 极简风：大留白卡片 + 深色 CTA + →）。
import React, { useState } from "react";
import { setKey } from "../lib";
import { CtrlHint } from "./ctrl";
import { ButtonLoadingContent } from "./ui";

export function LoginScreen({ onSubmit, msg }: {
  onSubmit: () => void | Promise<void>;
  msg: { kind: "ok" | "err"; text: string } | null;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy || !keyInput.trim()) return;
    setKey(keyInput);
    setBusy(true);
    try { await onSubmit(); } finally { setBusy(false); }
  };

  return (
    <div className="login-wrap">
      <div className="card">
        <div className="card-title">SAworkApi</div>
        <div className="form-row">
          <input className="input" type="password" value={keyInput} disabled={busy}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") void go(); }}
            placeholder="输入 WB2A_API_KEY" autoFocus />
        </div>
        {msg && <div className={"msg " + msg.kind}>{msg.text}</div>}
        <button className="btn-cta" style={{ marginTop: 6 }} onClick={() => void go()}
          disabled={busy || !keyInput.trim()} aria-busy={busy}>
          <ButtonLoadingContent loading={busy} loadingChildren="正在验证密钥…">进入面板</ButtonLoadingContent>
          {!busy && <span className="arr">→</span>}
        </button>
        <div style={{ marginTop: 10 }}>
          <CtrlHint>密钥仅保存在浏览器 localStorage，所有请求以 Bearer 头携带。</CtrlHint>
        </div>
      </div>
    </div>
  );
}
