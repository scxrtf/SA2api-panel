"use client";
// 添加账号弹窗（对齐 Go #addTabs：浏览器登录 / 导入 JSON 两个子页）。
import React, { useEffect, useRef, useState } from "react";
import { req } from "../lib";

export function AddAccountModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [tab, setTab] = useState<"login" | "import">("login");
  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-title">添加账号</div>
        <div className="btn-row" style={{ marginBottom: 14 }}>
          <button className={"btn small" + (tab === "login" ? " primary" : "")} onClick={() => setTab("login")}>浏览器登录</button>
          <button className={"btn small" + (tab === "import" ? " primary" : "")} onClick={() => setTab("import")}>导入 JSON</button>
        </div>
        {tab === "login" ? <LoginPane onDone={onDone} /> : <ImportPane onDone={onDone} />}
        <div style={{ marginTop: 14, textAlign: "right" }}>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

// 设备授权登录（login/start → login/poll 轮询）。
function LoginPane({ onDone }: { onDone: () => void }) {
  const [realm, setRealm] = useState("cn");
  const [url, setUrl] = useState("");
  const [state, setState] = useState("");
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  useEffect(() => stop, []);

  const start = async () => {
    setErr(""); setStatus("正在发起授权…");
    try {
      const r = await req<{ url: string; state: string }>("login/start", { method: "POST", body: { realm } });
      setUrl(r.url); setState(r.state);
      setStatus("等待用户在打开的页面中完成授权…（每 3 秒轮询）");
      stop();
      timer.current = setInterval(async () => {
        try {
          const p = await req<{ done: boolean; message?: string; uid?: string }>(
            "login/poll?state=" + encodeURIComponent(r.state));
          if (p.done) { stop(); setStatus("登录成功，账号 " + (p.uid ?? "") + " 已入库。"); setTimeout(onDone, 1200); }
          else if (p.message) setStatus("等待授权…（" + p.message + "）");
        } catch (e) { stop(); setErr(e instanceof Error ? e.message : String(e)); }
      }, 3000);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setStatus(""); }
  };

  return (
    <>
      <div className="form-row">
        <label className="form-label">账号域</label>
        <select className="select" value={realm} onChange={(e) => setRealm(e.target.value)} disabled={!!state}>
          <option value="cn">国内（codebuddy.cn）</option>
          <option value="global">国际（workbuddy.ai）</option>
        </select>
      </div>
      {!state && <button className="btn primary" onClick={start}>发起授权</button>}
      {url && (
        <div className="form-row" style={{ marginTop: 12 }}>
          <label className="form-label">请在浏览器中打开以下链接完成授权：</label>
          <div className="mono" style={{ padding: 8, background: "var(--bg-soft)", borderRadius: 6 }}>
            <a href={url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{url}</a>
          </div>
        </div>
      )}
      {status && <div className="msg ok">{status}</div>}
      {err && <div className="msg err">{err}</div>}
    </>
  );
}

// 导入 JSON（import/cockpit：粘贴账号 JSON 批量入库）。
function ImportPane({ onDone }: { onDone: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [okMsg, setOkMsg] = useState("");

  const run = async () => {
    setBusy(true); setErr(""); setOkMsg("");
    try {
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { throw new Error("JSON 解析失败，请检查格式"); }
      const r = await req<{ imported?: number; message?: string }>("import/cockpit", { method: "POST", body: parsed });
      setOkMsg(r.message ?? ("导入完成 " + (r.imported ?? "") + " 个账号"));
      setTimeout(onDone, 1200);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="form-row">
        <label className="form-label">粘贴账号 JSON（数组或单对象，含 accessToken / refreshToken 等字段）</label>
        <textarea className="textarea" rows={8} value={text} onChange={(e) => setText(e.target.value)}
          placeholder='[{"uid":"…","accessToken":"…","refreshToken":"…"}]' />
      </div>
      <button className="btn primary" onClick={run} disabled={busy || !text.trim()}>{busy ? "导入中…" : "导入"}</button>
      {okMsg && <div className="msg ok">{okMsg}</div>}
      {err && <div className="msg err">{err}</div>}
    </>
  );
}
