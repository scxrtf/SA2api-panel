// logfmt 统一日志的 uid 截断与账号标签（移植 Go internal/logfmt/logfmt.go）。
// 约定：
//   - uid 统一截 8 位：日志行只留 uid 前 8 位，全量 uid 在 DB/面板可查。
//   - Label 输出「昵称(uid8)」；昵称为空退回 uid8；两者皆空返回 "-"。
//   - 调度四类已有天然前缀（travel/activity/checkin/keepalive）保持不变。

// uid8 返回 uid 的前 8 位；空 uid 返回 "-"（对齐 Go UID8）。
export function uid8(uid: string): string {
  if (!uid) return "-";
  return uid.length > 8 ? uid.slice(0, 8) : uid;
}

// label 返回日志里的账号标签 "示例昵称甲(a1b2c3d4)"（对齐 Go Label）。
// 昵称认人、uid8 供 grep；uid 与 nick 同时为空返回 "-"。
export function label(uid: string, nick: string): string {
  const short = uid8(uid);
  const n = (nick ?? "").trim();
  return n === "" ? short : n + "(" + short + ")";
}
