"use client";
// 积分构成视图（对齐 Go view-packages）：按账号列出套餐包构成 + 到期分布。
// 取数失败的行显式标注原因（会话失效/鉴权被拒/上游失败），不再用 0/0 冒充真实余额，
// 也不计入域合计——否则整页会读出「CN 剩余 0」这种与事实相反的结论。
import React, { useCallback, useEffect, useState } from "react";
import { req, fmtNum, fmtTime, useAutoRefresh, usePanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";
import { PackageMixBar, ExpiryDistribution } from "../components/packageCharts";

export interface CreditPackage {
  name: string; remain: number; used: number; size: number;
  expires_at?: number; end_time?: string; created_at?: string;
  package_code?: string; sub_product_name?: string; cycle?: boolean;
}
export interface PkgAccount {
  uid: string; nickname: string; realm: string;
  remain: number; size: number; packages: CreditPackage[];
  ok?: boolean; reason?: string; error?: string;
}

// 失败原因 → 面板文案（后端给稳定 reason 码，前端不解析上游原文）。
const reasonText: Record<string, string> = {
  session_dead: "会话已失效，该账号需重新登录后才会恢复积分数据。",
  auth_rejected: "上游鉴权被拒（401），可能需重新登录。",
  upstream_error: "上游取数失败，稍后重试；持续失败请查看运行日志。",
};
const reasonTag: Record<string, string> = {
  session_dead: "会话失效",
  auth_rejected: "鉴权被拒",
  upstream_error: "上游失败",
};
const reasonOf = (a: PkgAccount) => reasonText[a.reason ?? ""] ?? reasonText.upstream_error;
const tagOf = (a: PkgAccount) => reasonTag[a.reason ?? ""] ?? reasonTag.upstream_error;

export function PackagesView({ flash }: { flash: Flash }) {
  const [rows, setRows] = useState<PkgAccount[] | null>(null);
  const [detailLimit, setDetailLimit] = useState(5);
  const [expandAll, setExpandAll] = useState(false);

  const load = useCallback(() => {
    req<{ accounts: PkgAccount[]; detail_limit?: number }>("packages")
      .then((r) => {
        setRows(r.accounts);
        const n = Number(r.detail_limit);
        setDetailLimit(Number.isFinite(n) && n > 0 ? Math.floor(n) : 5);
      })
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [flash]);
  useEffect(load, [load]);
  useAutoRefresh(load, 60_000);
  usePanelRefresh(load);

  // 域分组汇总：只累加取数成功的账号；失败账号单独计数，不污染合计。
  const realmSummary = (rows ?? []).reduce(
    (acc, a) => {
      const k = a.realm === "global" ? "global" : "cn";
      if (a.ok === false) {
        acc[k].failed += 1;
        return acc;
      }
      acc[k].remain += a.remain || 0;
      acc[k].size += a.size || 0;
      acc[k].count += 1;
      return acc;
    },
    {
      cn: { remain: 0, size: 0, count: 0, failed: 0 },
      global: { remain: 0, size: 0, count: 0, failed: 0 },
    },
  );
  const totalFailed = (rows ?? []).filter((a) => a.ok === false).length;

  return (
    <Box title="积分构成" hint="按账号列出套餐包 · 上游按失效时刻先后自动优先扣减（FEFO）"
      extra={<button className="btn xs" onClick={load}>刷新</button>}>
      {!rows ? (
        <div className="pad dim">加载中…</div>
      ) : rows.length === 0 ? (
        <div className="pad dim">暂无账号</div>
      ) : (
        <>
        <div className="pad">
          <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
            {realmSummary.cn.count > 0 && (
              <span className="tag info" title="国内域账号积分合计（仅统计取数成功的账号）">
                CN · {realmSummary.cn.count} 账号 · 剩余 {fmtNum(realmSummary.cn.remain)} / 总量 {fmtNum(realmSummary.cn.size)}
              </span>
            )}
            {realmSummary.global.count > 0 && (
              <span className="tag ok" title="国际域账号积分合计（仅统计取数成功的账号）">
                国际 · {realmSummary.global.count} 账号 · 剩余 {fmtNum(realmSummary.global.remain)} / 总量 {fmtNum(realmSummary.global.size)}
              </span>
            )}
            {totalFailed > 0 && (
              <span className="tag warn" title="这些账号未取到上游数据，未计入合计；逐号原因见下方">
                {totalFailed} 个账号取数失败 · 未计入合计
              </span>
            )}
          </div>
          <ExpiryDistribution accounts={rows} />
        </div>
        {rows.map((a) => {
          const failed = a.ok === false;
          return (
          <div className="tc-acct" key={a.uid}>
            <h4>
              {a.nickname || a.uid}
              <span className="dim" style={{ margin: "0 8px" }}>·</span>
              <span className="dim mono">{a.uid}</span>
              <span className={"tag " + (a.realm === "global" ? "ok" : "info")} style={{ marginLeft: 8 }}>
                {a.realm === "global" ? "国际" : "CN"}
              </span>
              {failed ? (
                <span className="tag err" style={{ marginLeft: 8 }}>{tagOf(a)}</span>
              ) : (
                <span style={{ marginLeft: 8 }} className="dim">
                  剩余 {fmtNum(a.remain)} / 总量 {fmtNum(a.size)}
                </span>
              )}
            </h4>
            {failed && (
              <div className="msg err" style={{ fontSize: 12.5, overflowWrap: "anywhere" }}>
                {reasonOf(a)}
                {a.error && (
                  <span className="dim" style={{ display: "block", marginTop: 4, fontSize: 12 }}>
                    上游原文：{a.error}
                  </span>
                )}
              </div>
            )}
            {!failed && (
              <div style={{ marginBottom: 10 }}>
                <PackageMixBar packs={a.packages} />
              </div>
            )}
            {!failed && a.packages.length === 0 && <div className="dim" style={{ fontSize: 13 }}>无套餐包</div>}
            {!failed && a.packages.length > 0 && (
              <div className="tbl-wrap">
                <table className="tbl tbl-packages">
                  <thead><tr><th>套餐</th><th>剩余 / 总量</th><th>已用</th><th>到期</th></tr></thead>
                  <tbody>
                    {(expandAll ? a.packages : a.packages.slice(0, detailLimit)).map((p, i, shown) => {
                      const dupName = (p.name || p.sub_product_name || "-");
                      // 同名相邻包折叠标记：与前一行同名时弱化名称列（避免刷屏）。
                      const prev = i > 0 ? shown[i - 1] : null;
                      const dup = prev !== null && dupName === (prev.name || prev.sub_product_name || "-");
                      return (
                        <tr key={i}>
                          <td className={dup ? "dim" : ""}>
                            {dupName}
                            {p.cycle && <span className="tag info" style={{ marginLeft: 6 }}>周期</span>}
                          </td>
                          <td>{fmtNum(p.remain)} / {fmtNum(p.size)}</td>
                          <td className="dim">{fmtNum(p.used)}</td>
                          <td className="dim">{p.expires_at ? fmtTime(p.expires_at) : (p.end_time ?? "-")}</td>
                        </tr>
                      );
                    })}
                    {!expandAll && a.packages.length > detailLimit && (() => {
                      const rest = a.packages.slice(detailLimit);
                      const restRemain = rest.reduce((n, p) => n + (p.remain || 0), 0);
                      const restSize = rest.reduce((n, p) => n + (p.size || 0), 0);
                      const restUsed = rest.reduce((n, p) => n + (p.used || 0), 0);
                      const nextExpiry = rest.map((p) => p.expires_at || 0).filter((t) => t > 0).sort((x, y) => x - y)[0];
                      return (
                        <tr style={{ cursor: "pointer" }} onClick={() => setExpandAll(true)} title="点击展开全部套餐">
                          <td className="dim" colSpan={4} style={{ textAlign: "center" }}>
                            …还有 {rest.length} 个套餐（剩余 {fmtNum(restRemain)} / 总量 {fmtNum(restSize)} · 已用 {fmtNum(restUsed)}
                            {nextExpiry ? " · 最近到期 " + fmtTime(nextExpiry) : ""}）— 点击展开
                          </td>
                        </tr>
                      );
                    })()}
                    {expandAll && a.packages.length > detailLimit && (
                      <tr style={{ cursor: "pointer" }} onClick={() => setExpandAll(false)}>
                        <td className="dim" colSpan={4} style={{ textAlign: "center" }}>收起 ▲</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          );
        })}
        </>
      )}
    </Box>
  );
}
