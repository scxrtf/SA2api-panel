"use client";
// 权限级操作统一的二次确认弹窗：沿用建 Key 的遮罩、状态与按钮体系。
import React, { useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { ButtonLoadingContent } from "./ui";

export function SuperPasswordModal({ title, description, confirmText = "确认执行", busy = false,
  error = "", onCancel, onConfirm }: {
  title: string; description: React.ReactNode; confirmText?: string; busy?: boolean;
  error?: string; onCancel: () => void; onConfirm: (password: string) => Promise<void>;
}) {
  const [password, setPassword] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  useEffect(() => { cancelRef.current = onCancel; }, [onCancel]);
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousGutter = document.documentElement.style.scrollbarGutter;
    document.body.style.overflow = "hidden";
    document.documentElement.style.scrollbarGutter = "stable";
    return () => { document.body.style.overflow = previousOverflow; document.documentElement.style.scrollbarGutter = previousGutter; };
  }, []);
  useEffect(() => {
    inputRef.current?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) cancelRef.current();
      if (e.key === "Tab") {
        const items = dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex='0']");
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [busy]);
  const submit = async () => { if (password && !busy) await onConfirm(password); };
  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div ref={dialogRef} className="modal super-password-modal" role="dialog" aria-modal="true" aria-labelledby="super-password-title" aria-busy={busy}>
        <div className="machine-modal-heading">
          <div className="modal-title" id="super-password-title">{title}</div>
          {busy && <Spinner className="size-[18px] text-[var(--accent)]" />}
        </div>
        <div className="machine-state">
          <div className="machine-state-top"><span className="machine-state-label">超级密码验证</span><span className="machine-badge">权限操作</span></div>
          <div className="super-password-description">{description}</div>
        </div>
        <div className="form-row">
          <label className="form-label" htmlFor="super-password-input">请输入超级密码</label>
          <input ref={inputRef} id="super-password-input" className="input" type="password"
            autoComplete="current-password" value={password} disabled={busy} placeholder="输入后确认，本次不会保存"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") { e.preventDefault(); void submit(); } }} />
        </div>
        {error && <div className="msg err super-password-error" role="alert">{error}</div>}
        <div className="btn-row super-password-actions">
          <button className="btn primary machine-submit" onClick={() => void submit()} disabled={!password || busy} aria-busy={busy}>
            <ButtonLoadingContent loading={busy} loadingChildren="正在验证并执行…">{confirmText}</ButtonLoadingContent>
          </button>
          <button className="btn" onClick={onCancel} disabled={busy}>取消</button>
        </div>
      </div>
    </div>
  );
}
