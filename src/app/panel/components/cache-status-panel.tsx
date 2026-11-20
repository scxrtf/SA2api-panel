"use client";

import { Fragment, useState } from "react";
import { ChevronDownIcon, DatabaseIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { CacheLayer, CacheStatusSnapshot } from "@/lib/cache-status";
import { fmtNum } from "../lib";
import { LoadingIndicator } from "./ui";

function formatTtl(ms: number): string {
  if (ms <= 0) return "—";
  const seconds = Math.ceil(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const remainder = seconds % 60;
  if (hours) return minutes ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  if (minutes) return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
  return `${seconds} 秒`;
}

function layerSize(layer: CacheLayer): string {
  const size = fmtNum(layer.size);
  return layer.maxEntries === null ? `${size} 条` : `${size} / ${fmtNum(layer.maxEntries)} 条`;
}

export function CacheStatusPanel({ stats, initial, error }: {
  stats: CacheStatusSnapshot | null;
  initial: boolean;
  error: string;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  if (!stats) {
    if (initial) return <LoadingIndicator label="正在读取缓存状态…" />;
    return (
      <div className="log-empty" role={error ? "alert" : undefined}>
        <DatabaseIcon aria-hidden="true" />
        <strong>{error ? "读取缓存状态失败" : "暂无缓存快照"}</strong>
        {error && <span>{error}</span>}
      </div>
    );
  }

  const total = stats.layers.reduce((sum, layer) => sum + layer.size, 0);
  return (
    <>
      <div className="log-cache-overview">
        <div>
          <h3>服务端缓存</h3>
          <p>有效期以采集时刻为准。不含浏览器缓存或上游前缀缓存。</p>
        </div>
        <span className="log-num">{fmtNum(stats.layers.length)} 层 <span className="log-subtle">/</span> {fmtNum(total)} 条活跃</span>
      </div>
      <Table className="log-ledger log-cache-table" aria-label="服务端缓存状态">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">缓存层</TableHead>
            <TableHead scope="col" className="log-cache-count">活跃 / 容量</TableHead>
            <TableHead scope="col" className="log-cache-ttl">默认有效期</TableHead>
            <TableHead scope="col" className="log-cache-ttl">最近到期</TableHead>
            <TableHead scope="col" className="log-col-action"><span className="sr-only">缓存条目</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats.layers.map((layer) => {
            const open = expanded === layer.id;
            const detailId = `cache-entries-${layer.id}`;
            const soonest = layer.entries.reduce((ttl, e) => Math.min(ttl, e.ttlMs), Infinity);
            const expires = Number.isFinite(soonest) ? formatTtl(soonest) : "—";
            return (
              <Fragment key={layer.id}>
                <TableRow className="log-data-row" data-expanded={open}>
                  <TableCell className="log-cache-name">
                    <div className="log-stack"><strong>{layer.name}</strong><span className="log-subtle">{layer.note}</span></div>
                    <div className="log-cache-compact log-subtle log-num">
                      <span>活跃 {layerSize(layer)}</span>
                      <span>默认 {formatTtl(layer.ttlMs)}</span>
                      {Number.isFinite(soonest) && <span>最近到期 {expires}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="log-cache-count log-num">{layerSize(layer)}</TableCell>
                  <TableCell className="log-cache-ttl log-num">{formatTtl(layer.ttlMs)}</TableCell>
                  <TableCell className="log-cache-ttl log-num">{expires}</TableCell>
                  <TableCell className="log-col-action">
                    {layer.entries.length > 0 && (
                      <Button type="button" variant="ghost" size="icon" className="log-expand-button"
                        aria-expanded={open} aria-controls={open ? detailId : undefined}
                        aria-label={`${open ? "收起" : "展开"}${layer.name}条目`}
                        onClick={() => setExpanded(open ? null : layer.id)}><ChevronDownIcon /></Button>
                    )}
                  </TableCell>
                </TableRow>
                {open && layer.entries.length > 0 && (
                  <TableRow className="log-expanded-row">
                    <TableCell colSpan={5}>
                      <div className="log-cache-entries" id={detailId}>
                        <Table className="log-ledger log-cache-keys" aria-label={`${layer.name}条目`}>
                          <TableHeader><TableRow>
                            <TableHead scope="col">缓存键</TableHead>
                            <TableHead scope="col" className="log-key-ttl">设定有效期</TableHead>
                            <TableHead scope="col" className="log-key-ttl">剩余有效期</TableHead>
                          </TableRow></TableHeader>
                          <TableBody>
                            {[...layer.entries].sort((a, b) => a.ttlMs - b.ttlMs).map((entry) => (
                              <TableRow key={entry.key}>
                                <TableCell className="log-cache-key"><code>{entry.key}</code></TableCell>
                                <TableCell className="log-num log-key-ttl">{formatTtl(entry.configuredTtlMs)}</TableCell>
                                <TableCell className="log-num log-key-ttl">{formatTtl(entry.ttlMs)}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
    </>
  );
}
