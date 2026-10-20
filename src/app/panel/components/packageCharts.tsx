"use client";
// 积分构成可视化组件（对齐 Go pkBySource/pkAccountSegments/renderExpiryDistribution）：
// 1) PackageMixBar — 账号内按来源分色的构成条（含剩余/已用占比）
// 2) ExpiryDistribution — 按剩余天数逐行聚合的到期分布图（横向堆叠、按账号着色）
// 色板对齐 CloseRouter Pal：橙系主色 + 同暖度灰阶，避免彩虹配色。
import React from "react";
import type { CreditPackage, PkgAccount } from "../views/packages";

// 来源色阶：橙 → 琥珀 → 暖灰 → 墨灰循环（对齐 Pal.orange / orangeDeep / ink / mute）。
const PK_COLORS = ["#e8741c", "#f28a2e", "#f5a95c", "#d9a066", "#8a8f98",
  "#b4b7bb", "#5a5c64", "#c98a4b", "#e39a55", "#6e6f78"];
// 账号色阶：同色系不同明度，保证多账号可区分又不破坏黑白橙基调。
const PK_ACCOUNT_COLORS = ["#e8741c", "#f28a2e", "#f5a95c", "#c9711a",
  "#3a3a40", "#6e6f78", "#9a9aa3", "#d9a066",
  "#b45a12", "#8a8f98", "#e39a55", "#48494e"];
// 已用部分统一用浅灰斜纹，与剩余彩色形成「色比」对比。
const PK_USED_COLOR = "#dedfdf";

const fmtN = (n: number) => n.toLocaleString("en-US");
const fmtPct = (x: number) => (x * 100).toFixed(1) + "%";

// bySource 包按 code+name 归并（对齐 Go pkBySource）。
function bySource(packs: CreditPackage[]) {
  const m = new Map<string, { key: string; name: string; n: number; remain: number; size: number }>();
  for (const p of packs) {
    const k = (p.package_code ?? "") + "|" + (p.name ?? "(未命名)");
    const e = m.get(k) ?? { key: k, name: p.name ?? "(未命名)", n: 0, remain: 0, size: 0 };
    e.n += 1; e.remain += p.remain; e.size += p.size;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.size - a.size);
}

function colorOf(key: string, keys: string[]): string {
  return PK_COLORS[keys.indexOf(key) % PK_COLORS.length];
}

export function PackageMixBar({ packs }: { packs: CreditPackage[] }) {
  const srcs = bySource(packs);
  if (srcs.length === 0) return <div className="dim" style={{ fontSize: 12.5 }}>无套餐包</div>;
  const total = Math.max(1, srcs.reduce((s, x) => s + x.size, 0));
  const keys = srcs.map((x) => x.key);
  return (
    <div>
      <div className="mixbar" role="img" aria-label="积分包构成">
        {srcs.map((s) => (
          <i key={s.key} style={{ width: (s.size / total * 100).toFixed(2) + "%", background: colorOf(s.key, keys) }}
            title={s.name + " " + fmtN(s.remain) + " / " + fmtN(s.size)}></i>
        ))}
      </div>
      <div className="pk-legend">
        {srcs.map((s) => (
          <span key={s.key}><i style={{ background: colorOf(s.key, keys) }}></i>
            {s.name.replace(/^CodeBuddy/, "")} x{s.n} · {fmtPct(s.size / total)}</span>
        ))}
      </div>
      <div className="pk-srcbars">
        {srcs.map((s) => {
          const remainPct = s.size > 0 ? s.remain / s.size : 0;
          return (
            <div className="pk-srcrow" key={s.key}>
              <span className="pk-srcname" title={s.name}>{s.name.replace(/^CodeBuddy/, "")}</span>
              <div className="pk-srctrack">
                <i style={{ width: fmtPct(remainPct), background: colorOf(s.key, keys) }}
                  title={"剩余 " + fmtN(s.remain) + " / " + fmtN(s.size)}></i>
                <b style={{ width: fmtPct(1 - remainPct), background: PK_USED_COLOR }}></b>
              </div>
              <span className="pk-srcnum mono">
                {fmtN(s.remain)} <em>/ {fmtN(s.size)}</em>
              </span>
              <span className={"pk-srcpct mono" + (remainPct < 0.15 ? " low" : "")}>{fmtPct(remainPct)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// expiryMs 对齐 Go pkExpiryMs：expires_at 优先，回落 end_time（+08:00 锚定）。
function expiryMs(p: CreditPackage): number | null {
  const raw = Number(p.expires_at);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const text = String(p.end_time ?? "").trim();
  if (!text) return null;
  let iso = text.includes("T") ? text : text.replace(" ", "T");
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(iso)) iso += "+08:00";
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : null;
}

interface Seg { amount: number; expiresAt: number | null; days: number | null; source: string; uid: string; accountName: string }

// accountSegments 对齐 Go pkAccountSegments：余额约束逐包拆分。
function accountSegments(a: PkgAccount, now: number): Seg[] {
  let balance = Math.max(0, a.remain);
  const out: Seg[] = [];
  for (const p of a.packages) {
    if (p.remain <= 0 || balance <= 0) continue;
    const amount = Math.min(balance, p.remain);
    const at = expiryMs(p);
    out.push({
      amount, expiresAt: at,
      days: at == null ? null : Math.max(0, Math.ceil((at - now) / 86_400_000)),
      source: p.name ?? "积分", uid: a.uid,
      accountName: a.nickname || a.uid.slice(0, 8) || "未命名账号",
    });
    balance -= amount;
  }
  return out.sort((x, y) => {
    if (x.expiresAt == null && y.expiresAt != null) return 1;
    if (x.expiresAt != null && y.expiresAt == null) return -1;
    return (x.expiresAt ?? 0) - (y.expiresAt ?? 0);
  });
}

// ExpiryDistribution 按剩余天数聚合的全池到期分布（对齐 Go renderExpiryDistribution）。
export function ExpiryDistribution({ accounts }: { accounts: PkgAccount[] }) {
  const now = Date.now();
  const ok = accounts.filter((a) => !a.error && Number.isFinite(a.remain));
  const uids = ok.map((a) => a.uid).sort();
  const colorMap = new Map(uids.map((uid, i) => [uid, PK_ACCOUNT_COLORS[i % PK_ACCOUNT_COLORS.length]]));

  const buckets = new Map<number, { days: number; credits: number; segs: Seg[] }>();
  for (const a of ok) {
    for (const s of accountSegments(a, now)) {
      if (s.days == null) continue;
      const row = buckets.get(s.days) ?? { days: s.days, credits: 0, segs: [] };
      row.credits += s.amount;
      row.segs.push(s);
      buckets.set(s.days, row);
    }
  }
  const rows = [...buckets.values()].sort((a, b) => a.days - b.days);
  if (rows.length === 0) {
    return <div className="pk-expiry-empty">暂无可汇总积分</div>;
  }
  const opacity = (days: number) => 0.25 + (0.75 * Math.max(0, Math.min(29, days - 1))) / 29;

  return (
    <div>
      <div className="pk-expiry-hdr"><span>剩余天数</span><span style={{ textAlign: "center" }}>各账号该批剩余</span><b>剩余积分</b></div>
      <div className="pk-expiry-chart">
        {rows.map((row) => (
          <div className="pk-expiry-row" key={row.days}>
            <span>{row.days === 0 ? "已到期" : row.days + " 天"}</span>
            <div className="pk-expiry-track">
              {row.segs.map((s, i) => (
                <span key={i} className="pk-expiry-seg"
                  style={{ ["--seg-color" as string]: colorMap.get(s.uid) ?? PK_ACCOUNT_COLORS[0], opacity: opacity(row.days), flex: Math.max(0.008, s.amount / Math.max(1, row.credits)) }}
                  title={s.source + "\n" + fmtN(s.amount) + " 积分\n" + (s.expiresAt ? new Date(s.expiresAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—") + "\n" + s.accountName}
                  aria-label={s.accountName + " " + fmtN(s.amount)}></span>
              ))}
            </div>
            <b>{fmtN(row.credits)}</b>
          </div>
        ))}
      </div>
      <div className="pk-expiry-legend">
        {ok.filter((a) => accountSegments(a, now).some((s) => s.days != null)).map((a) => (
          <span key={a.uid}><i style={{ background: colorMap.get(a.uid) ?? PK_ACCOUNT_COLORS[0] }}></i>{a.nickname || a.uid.slice(0, 8)}</span>
        ))}
      </div>
      <div className="pk-expiry-foot">{ok.length + " 个账号" + (accounts.length - ok.length > 0 ? " · " + (accounts.length - ok.length) + " 个未获取余额" : "")}</div>
    </div>
  );
}
