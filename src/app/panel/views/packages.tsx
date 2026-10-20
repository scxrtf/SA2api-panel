"use client";
// 积分构成视图（对齐 Go view-packages）：按账号列出套餐包构成 + 到期分布。
import React, { useCallback, useEffect, useState } from "react";
import { req, fmtNum, fmtTime, useAutoRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";
import { PackageMixBar, ExpiryDistribution } from "../components/packageCharts";

export interface CreditPackage {
  name: string; remain: number; used: number; size: number;
  expires_at?: number; end_time?: string; created_at?: string;
  package_code?: string; sub_product_name?: string; cycle?: boolean;
}
export interface PkgAccount {
  uid: string; nickname: string; realm: string;
  remain: number; size: number; packages: CreditPackage[]; error?: string;
}

export function PackagesView({ flash }: { flash: Flash }) {
  const [rows, setRows] = useState<PkgAccount[] | null>(null);
  const [expandAll, setExpandAll] = useState(false);

  const load = useCallback(() => {
    req<{ accounts: PkgAccount[] }>("packages")
      .then((r) => setRows(r.accounts))
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [flash]);
  useEffect(load, [load]);
  useAutoRefresh(load, 60_000);

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
          <ExpiryDistribution accounts={rows} />
        </div>
        {rows.map((a) => (
          <div className="tc-acct" key={a.uid}>
            <h4>
              {a.nickname || a.uid}
              <span className="dim mono" style={{ marginLeft: 8 }}>{a.uid}</span>
              <span className="tag info" style={{ marginLeft: 8 }}>{a.realm}</span>
              <span style={{ marginLeft: 8 }} className="dim">
                剩余 {fmtNum(a.remain)} / 总量 {fmtNum(a.size)}
              </span>
            </h4>
            {a.error && <div className="msg err">{a.error}</div>}
            {!a.error && (
              <div style={{ marginBottom: 10 }}>
                <PackageMixBar packs={a.packages} />
              </div>
            )}
            {!a.error && a.packages.length === 0 && <div className="dim" style={{ fontSize: 13 }}>无套餐包</div>}
            {a.packages.length > 0 && (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead><tr><th>套餐</th><th>剩余 / 总量</th><th>已用</th><th>到期</th></tr></thead>
                  <tbody>
                    {(expandAll ? a.packages : a.packages.slice(0, 4)).map((p, i) => {
                      const dupName = (p.name || p.sub_product_name || "-");
                      // 同名相邻包折叠标记：与前一行同名时弱化名称列（避免刷屏）。
                      const dup = i > 0 && dupName === ((expandAll ? a.packages : a.packages)[i - 1].name || (expandAll ? a.packages : a.packages)[i - 1].sub_product_name || "-");
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
                    {!expandAll && a.packages.length > 4 && (() => {
                      const rest = a.packages.slice(4);
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
                    {expandAll && a.packages.length > 4 && (
                      <tr style={{ cursor: "pointer" }} onClick={() => setExpandAll(false)}>
                        <td className="dim" colSpan={4} style={{ textAlign: "center" }}>收起 ▲</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ))}
        </>
      )}
    </Box>
  );
}
