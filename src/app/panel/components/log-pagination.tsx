"use client";

import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem } from "@/components/ui/pagination";
import { Spinner } from "@/components/ui/spinner";
import { fmtNum } from "../lib";

function pageItems(page: number, totalPages: number): (number | "ellipsis")[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = [...new Set([1, page - 1, page, page + 1, totalPages])]
    .filter((value) => value >= 1 && value <= totalPages);
  return pages.flatMap((value, index) => index > 0 && value - pages[index - 1] > 1 ? ["ellipsis", value] : [value]);
}

export function LogPagination({ page, total, totalPages, pageSize, unit = "条", pendingPage, blocked, failure, onPageChange }: {
  page: number;
  total: number;
  totalPages: number;
  pageSize: number;
  unit?: string;
  pendingPage?: number;
  blocked: boolean;
  failure?: { page: number; message: string };
  onPageChange: (page: number) => void;
}) {
  const isPaging = pendingPage !== undefined;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const go = (next: number) => {
    if (!blocked && next >= 1 && next <= totalPages && next !== page) onPageChange(next);
  };

  return (
    <div className="log-pager" data-pending={isPaging}>
      {isPaging && <div className="log-pager-rail" aria-hidden="true"><span /></div>}
      <div className="log-pager-meta log-num">
        <div className="log-page-count"><strong>第 {fmtNum(page)} / {fmtNum(totalPages)} 页</strong><span>共 {fmtNum(total)} {unit}</span></div>
        <div className="log-page-feedback" data-error={Boolean(failure) && !isPaging}>
          <span role="status" aria-atomic="true" title={failure?.message}>
            {isPaging ? `正在加载第 ${fmtNum(pendingPage)} 页…`
              : failure ? `第 ${fmtNum(failure.page)} 页加载失败`
                : total > 0 ? `显示第 ${fmtNum(first)}–${fmtNum(last)} ${unit}` : "暂无记录"}
          </span>
          {!isPaging && failure && <Button variant="ghost" size="xs" type="button" disabled={blocked}
            onClick={() => go(failure.page)}>重试</Button>}
        </div>
      </div>
      <Pagination aria-label="日志分页" className="log-pager-nav">
        <PaginationContent className="log-pager-controls">
          <PaginationItem>
            <Button type="button" variant="outline" className="log-pager-step" aria-label="上一页"
              disabled={blocked || page <= 1} focusableWhenDisabled={blocked} onClick={() => go(page - 1)}>
              <ChevronLeftIcon data-icon="inline-start" /><span>上一页</span>
            </Button>
          </PaginationItem>
          {pageItems(page, totalPages).map((item, index) => item === "ellipsis"
            ? <PaginationItem className="log-page-distant" key={`ellipsis-${index}`}><PaginationEllipsis /></PaginationItem>
            : <PaginationItem key={item} className={Math.abs(item - page) > 1 && item !== pendingPage ? "log-page-distant" : undefined}>
              <Button type="button" variant={item === page ? "outline" : "ghost"} size="icon" className="log-page-number"
                aria-current={item === page ? "page" : undefined} aria-label={`第 ${item} 页`}
                data-pending={item === pendingPage ? "true" : undefined}
                disabled={blocked} focusableWhenDisabled onClick={() => go(item)}>{fmtNum(item)}</Button>
            </PaginationItem>)}
          <PaginationItem>
            <Button type="button" variant="outline" className="log-pager-step" aria-label="下一页"
              disabled={blocked || page >= totalPages} focusableWhenDisabled={blocked} onClick={() => go(page + 1)}>
              <span>下一页</span><ChevronRightIcon data-icon="inline-end" />
            </Button>
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

export function LogListLoading({ label, terminal = false }: { label: string; terminal?: boolean }) {
  return (
    <div className="log-list-loading" data-terminal={terminal}>
      <div className="log-list-loading-label" role="status" aria-label={label}><Spinner />{label}</div>
      <div className="log-list-skeleton" aria-hidden="true">
        {[0, 1, 2, 3].map((row) => <div className="log-skeleton-row" key={row}><span /><span /><span /></div>)}
      </div>
    </div>
  );
}
