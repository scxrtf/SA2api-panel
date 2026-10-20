"use client";
// CloseRouter ControlPanel.kt 的 Web 复刻组件体系：
// CtrlCard / CtrlStatus / CtrlAction / CtrlMetric / CtrlValue / CtrlHint。
import React from "react";

/** ControlCard：灰面 14px 圆角容器 */
export function CtrlCard({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: "var(--radius)", padding: 14, display: "flex",
      flexDirection: "column", gap: 10, ...style,
    }}>{children}</div>
  );
}

/** ControlStatus：圆点 + 标题 + badge + 描述 */
export function CtrlStatus({ title, detail, active, badge }: {
  title: string; detail: string; active: boolean; badge: string;
}) {
  return (
    <div className={"ctrl-status" + (active ? " on" : "")}>
      <div className="row">
        <span className="dot"></span>
        <span className="t">{title}</span>
        <span className="badge">{badge}</span>
      </div>
      <div className="d">{detail}</div>
    </div>
  );
}

/** ControlAction：CODE 徽章 + 标题 + →，深色主按钮 / 白底次按钮 */
export function CtrlAction({ text, code, onClick, secondary, disabled, title }: {
  text: string; code: string; onClick: () => void;
  secondary?: boolean; disabled?: boolean; title?: string;
}) {
  return (
    <button className={"ctrl-action" + (secondary ? " secondary" : "")}
      onClick={onClick} disabled={disabled} title={title}>
      <span className="code">{code}</span>
      <span className="txt">{text}</span>
      <span className="arr">→</span>
    </button>
  );
}

/** ControlMetric：标签 + 22px 等宽大数字 + 单位 */
export function CtrlMetric({ label, value, unit, color }: {
  label: string; value: React.ReactNode; unit?: string; color?: string;
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <span className="stat-num" style={color ? { color } : undefined}>{value}</span>
      {unit && <span className="stat-unit">{unit}</span>}
    </div>
  );
}

/** ControlValue：小标签 + 等宽值（可复制） */
export function CtrlValue({ label, value, accent }: {
  label: string; value: React.ReactNode; accent?: boolean;
}) {
  return (
    <div className={"ctrl-value" + (accent ? " accent" : "")}>
      <div className="lbl">{label}</div>
      <div className="val">{value}</div>
    </div>
  );
}

/** ControlHint：10px 灰色提示小字 */
export function CtrlHint({ children }: { children: React.ReactNode }) {
  return <div className="ctrl-hint">{children}</div>;
}
