"use client";

import { useEffect, useState } from "react";
import { ChevronDownIcon, ListFilterIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { RequestLogScope, RequestLogSession } from "@/lib/request-log-sessions";
import { fmtDateTime, fmtNum, req } from "../lib";
import { LogListLoading } from "./log-pagination";
import { RequestLogTable, type ReqLog, type RequestLogDetailControls } from "./request-log-table";

interface MembersPage { entries: ReqLog[]; page: number; totalPages: number }

function SessionRequests({ id, scope, filterQuery, detail, onCloseRequest }: {
  id: string;
  scope: RequestLogScope;
  filterQuery: string;
  detail: RequestLogDetailControls;
  onCloseRequest: () => void;
}) {
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [snapshot, setSnapshot] = useState<{ query: string; retry: number; data?: MembersPage; error?: string }>();
  const params = new URLSearchParams(filterQuery);
  params.set("group", id);
  params.set("page", String(page));
  params.set("limit", "50");
  params.set("from", scope.from);
  params.set("to", scope.to);
  const query = params.toString();
  const loading = snapshot?.query !== query || snapshot.retry !== retry;
  const data = snapshot?.data;
  const error = loading ? "" : snapshot?.error ?? "";

  useEffect(() => {
    const controller = new AbortController();
    void req<MembersPage>("request_logs?" + query, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.totalPages < page) setPage(result.totalPages);
      else setSnapshot({ query, retry, data: result });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) {
        setSnapshot((prev) => ({ query, retry, data: prev?.data,
          error: cause instanceof Error ? cause.message : String(cause) }));
      }
    });
    return () => controller.abort();
  }, [page, query, retry]);

  const go = (next: number) => { onCloseRequest(); setPage(next); };
  return (
    <div aria-busy={loading}>
      {error && <div className="log-session-error" role="alert">
        <span>{error}</span>
        <Button type="button" variant="outline" size="sm" onClick={() => setRetry((value) => value + 1)}>重试</Button>
      </div>}
      {loading && !data ? <LogListLoading label="正在加载会话请求…" /> : data && (
        <RequestLogTable {...detail} rows={data.entries} filtered={Boolean(filterQuery)} initial={false} error="" />
      )}
      {data && data.totalPages > 1 && (
        <nav className="log-session-pagination" aria-label="会话内请求分页">
          <span className="log-subtle log-num" role="status">
            {loading && page !== data.page ? `正在加载第 ${fmtNum(page)} 页…` : `第 ${fmtNum(data.page)} / ${fmtNum(data.totalPages)} 页`}
          </span>
          <Button type="button" variant="outline" size="sm" disabled={loading || data.page <= 1} focusableWhenDisabled
            onClick={() => go(data.page - 1)}>上一页</Button>
          <Button type="button" variant="outline" size="sm" disabled={loading || data.page >= data.totalPages} focusableWhenDisabled
            onClick={() => go(data.page + 1)}>下一页</Button>
        </nav>
      )}
    </div>
  );
}

export function RequestLogSessions({ entries, scope, filterQuery, initial, error, detail, onCloseRequest }: {
  entries: RequestLogSession[];
  scope: RequestLogScope | undefined;
  filterQuery: string;
  initial: boolean;
  error: string;
  detail: RequestLogDetailControls;
  onCloseRequest: () => void;
}) {
  const [opened, setOpened] = useState<string | null>(null);
  if (initial) return <LogListLoading label="正在加载会话日志…" />;
  if (!entries.length || !scope) return (
    <div className="log-empty" role={error ? "alert" : undefined}>
      <ListFilterIcon aria-hidden="true" />
      <strong>{error ? "读取会话日志失败" : filterQuery ? "没有匹配的会话或请求" : "暂无会话日志"}</strong>
      {error ? <span>{error}</span> : filterQuery ? <span>调整筛选条件后再试。</span> : null}
    </div>
  );
  return (
    <div className="log-session-list" role="list" aria-label="会话日志">
      {entries.map((entry) => {
        const associated = entry.id.startsWith("s:");
        const id = entry.id.slice(2);
        const title = associated ? "会话" : "未关联会话";
        const model = entry.modelCount > 1 ? `${fmtNum(entry.modelCount)} 个模型` : entry.model || "—";
        const open = opened === entry.id;
        return (
          <Collapsible key={entry.id} role="listitem" className="log-session" open={open} onOpenChange={(next) => {
            onCloseRequest();
            setOpened(next ? entry.id : null);
          }}>
            <CollapsibleTrigger render={<Button type="button" variant="ghost" className="log-session-trigger" />}>
              <span className="log-session-id" title={id}>
                <strong>{title}</strong><code className="log-subtle truncate">{id.slice(0, 12)}</code>
              </span>
              <span className="log-session-model log-stack" title={entry.keyName || undefined}>
                <span className="truncate" title={model}>{model}</span>
                {entry.keyName && <span className="log-subtle truncate">{entry.keyName}</span>}
              </span>
              <time className="log-session-time log-num log-subtle" dateTime={entry.lastAt} title="最近请求">{fmtDateTime(entry.lastAt)}</time>
              <span className="log-session-counts log-num">
                <span>{fmtNum(entry.count)} 条请求</span>
                {entry.failed > 0 && <Badge variant="destructive">{fmtNum(entry.failed)} 失败</Badge>}
              </span>
              <ChevronDownIcon aria-hidden="true" className="log-session-chevron" />
            </CollapsibleTrigger>
            <CollapsibleContent className="log-session-content">
              {open && <SessionRequests id={entry.id} scope={scope} filterQuery={filterQuery} detail={detail} onCloseRequest={onCloseRequest} />}
            </CollapsibleContent>
          </Collapsible>
        );
      })}
    </div>
  );
}
