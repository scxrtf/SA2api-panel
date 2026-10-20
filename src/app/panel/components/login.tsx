"use client";
// 登录页（CloseRouter 极简风：大留白卡片 + 深色 CTA + →）。
import React, { useState } from "react";
import { setKey } from "../lib";
import { CtrlHint } from "./ctrl";

export function LoginScreen({ onSubmit, msg }: {
  onSubmit: () => void;
  msg: { kind: "ok" | "err"; text: string } | null;
}) {
  const [keyInput, setKeyInput] = useState("");
  const go = () => { setKey(keyInput); onSubmit(); };

  return (
    <div className="login-wrap">
      <div className="card">
        <div className="card-title">SAworkApi</div>
        <div className="form-row">
          <input className="input" type="password" value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") go(); }}
            placeholder="输入 WB2A_API_KEY" autoFocus />
        </div>
        {msg && <div className={"msg " + msg.kind}>{msg.text}</div>}
        <button className="btn-cta" style={{ marginTop: 6 }} onClick={go}>
          <span>进入面板</span><span className="arr">→</span>
        </button>
        <div style={{ marginTop: 10 }}>
          <CtrlHint>密钥仅保存在浏览器 localStorage，所有请求以 Bearer 头携带。</CtrlHint>
        </div>
      </div>
    </div>
  );
}
