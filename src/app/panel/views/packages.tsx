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
                    {a.packages.map((p, i) => (
                      <tr key={i}>
                        <td>
                          {p.name || p.sub_product_name || "-"}
                          {p.cycle && <span className="tag info" style={{ marginLeft: 6 }}>周期</span>}
                        </td>
                        <td>{fmtNum(p.remain)} / {fmtNum(p.size)}</td>
                        <td className="dim">{fmtNum(p.used)}</td>
                        <td className="dim">{p.expires_at ? fmtTime(p.expires_at) : (p.end_time ?? "-")}</td>
                      </tr>
                    ))}
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
