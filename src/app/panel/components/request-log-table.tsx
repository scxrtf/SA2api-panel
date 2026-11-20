"use client";

import { Fragment, type ReactNode } from "react";
import { ChevronDownIcon, ListFilterIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { errKindLabel, knownText, uaDisplay } from "@/lib/logfmt";
import { formatCacheRate, formatLogTokens, requestCacheUsage, requestFailed, summarizeRequestPage } from "@/lib/request-log-metrics";
import { fmtClock, fmtDateTime, fmtNum, PANEL_TIME_ZONE } from "../lib";
import { LogListLoading } from "./log-pagination";

export interface ReqLog {
  id: string; at: string; uid: string; model: string; status: number; errKind: string;
  durationMs: number; clientIp: string; ua: string; realm: string; provider: string; stream: boolean;
  ttfbMs?: number; attempts?: number;
  promptTokens?: number; completionTok?: number; totalTokens?: number;
  credit?: number; hasCredit?: boolean;
  cacheHitTok?: number; cacheMissTok?: number;
  keyName?: string; slot?: string; machineId?: string; path?: string; errMsg?: string;
}

export const EMPTY_REQUEST_FILTER = { model: "", account: "", client_ip: "", key: "", err: "", outcome: "" };
type RequestFilter = typeof EMPTY_REQUEST_FILTER;

export function requestFilterParams(filter: RequestFilter): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(filter)) {
    const term = value.trim();
    if (term) params.set(name, term);
  }
  return params.toString();
}

const FILTER_INPUTS = [
  { name: "model", label: "模型", placeholder: "模型前缀" },
  { name: "account", label: "账号", placeholder: "账号 UID 前缀" },
  { name: "client_ip", label: "来源 IP", placeholder: "IP 地址" },
  { name: "key", label: "Key 归属", placeholder: "Key 名称前缀" },
  { name: "err", label: "报错内容", placeholder: "关键词或错误码" },
] as const;

export function RequestLogFilters({ filter, onChange }: {
  filter: RequestFilter;
  onChange: (filter: RequestFilter) => void;
}) {
  return (
    <div className="log-filters" role="group" aria-label="筛选请求日志">
      {FILTER_INPUTS.map(({ name, label, placeholder }) => (
        <label className="log-filter" key={name}>
          <span>{label}</span>
          <Input type="search" value={filter[name]} placeholder={placeholder}
            onChange={(event) => onChange({ ...filter, [name]: event.target.value })} />
        </label>
      ))}
      <div className="log-filter">
        <label htmlFor="request-log-outcome">结果</label>
        <NativeSelect className="w-full" id="request-log-outcome" value={filter.outcome}
          onChange={(event) => onChange({ ...filter, outcome: event.target.value })}>
          <NativeSelectOption value="">全部结果</NativeSelectOption>
          <NativeSelectOption value="ok">仅成功</NativeSelectOption>
          <NativeSelectOption value="error">仅失败</NativeSelectOption>
        </NativeSelect>
      </div>
      <Button type="button" variant="ghost" className="log-clear" disabled={!Object.values(filter).some(Boolean)}
        onClick={() => onChange(EMPTY_REQUEST_FILTER)}>
        <XIcon data-icon="inline-start" />清除筛选
      </Button>
    </div>
  );
}

const dayFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: PANEL_TIME_ZONE, month: "2-digit", day: "2-digit",
});
const credits = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const UNRECORDED_KEY = "未记录";

function RequestKeyName({ name }: { name: string }) {
  return name
    ? <span className="block truncate" title={name}>{name}</span>
    : <span className="log-subtle">{UNRECORDED_KEY}</span>;
}

function plainTime(at: string): string {
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? dayFormat.format(date) : "—";
}

export function fmtLogMs(value: number | undefined): string {
  return value && value > 0 ? `${fmtNum(value)} ms` : "—";
}

function fmtCredit(entry: ReqLog): string {
  return entry.hasCredit && typeof entry.credit === "number" && Number.isFinite(entry.credit)
    ? `${credits.format(entry.credit)} 积分`
    : "—";
}

function tokens(entry: ReqLog): number {
  return entry.totalTokens || ((entry.promptTokens ?? 0) + (entry.completionTok ?? 0));
}

function routeLabel(entry: ReqLog): string {
  const provider = knownText(entry.provider);
  const slot = knownText(entry.slot);
  const realm = knownText(entry.realm);
  if (provider) return [provider, slot].filter(Boolean).join(" / ");
  if (realm === "global") return "国际版池";
  if (realm === "domestic") return "国内版池";
  return realm || slot;
}

function shortClient(ua: string): string {
  const match = ua.match(/(?:Claude-Code|Claude|Codex(?:CLI)?|CherryStudio|Cline|OpenAI|python-requests|node(?:-fetch)?|curl|PostmanRuntime|Go-http-client)(?:[ /][\w.-]+)?/i);
  if (match) return match[0].replace("/", " ");
  return ua.match(/^Mozilla\/[^ ]+\s*\(([^;)]+)/)?.[1] || ua.split(/[\s;,]/, 1)[0] || "";
}

function RequestStatus({ entry }: { entry: ReqLog }) {
  const failed = requestFailed(entry);
  const label = statusLabel(entry);
  return (
    <Badge variant={failed ? "destructive" : "secondary"} className="log-request-badge"
      title={entry.errMsg || label}>
      <span className="log-num">{entry.status || "—"}</span><span>{failed ? "失败" : "成功"}</span>
    </Badge>
  );
}

function statusLabel(entry: ReqLog): string {
  return errKindLabel(entry.errKind) || (requestFailed(entry) ? "失败" : "成功");
}

function CacheMeter({ rate }: { rate: number }) {
  return <span className="log-cache-meter" aria-hidden="true"><span style={{ width: `${rate * 100}%` }} /></span>;
}

function RequestCacheCell({ entry, compact = false }: { entry: ReqLog; compact?: boolean }) {
  const { hit, miss, rate } = requestCacheUsage(entry);
  if (rate === null) return <span className="log-subtle">{compact ? "缓存无数据" : "无数据"}</span>;
  return (
    <span className="log-cache-value" title={`命中 ${fmtNum(hit)} / 未命中 ${fmtNum(miss)} Token`}>
      <span className="log-num">{compact && "缓存 "}{formatCacheRate(rate)}</span>
      {!compact && <CacheMeter rate={rate} />}
    </span>
  );
}

export function RequestLogSummary({ summary }: { summary: ReturnType<typeof summarizeRequestPage> | null }) {
  return (
    <dl className="log-summary" aria-label="当前页请求统计">
      <div><dt>本页请求</dt><dd className="log-num">{summary ? <>{fmtNum(summary.count)} <small>条</small></> : "—"}</dd></div>
      <div><dt>本页失败</dt><dd className="log-num" data-failed={!!summary?.failed}>{summary ? <>{fmtNum(summary.failed)} <small>条</small></> : "—"}</dd></div>
      <div className="log-summary-cache">
        <dt title="本页命中 Token ÷（命中 + 未命中 Token）；无数据的请求不计入。">前缀缓存命中率</dt>
        <dd className="log-num">
          {summary ? summary.rate === null ? "无数据" : formatCacheRate(summary.rate) : "—"}
          {summary && summary.rate !== null && <small>{fmtNum(summary.reported)} 条有数据</small>}
        </dd>
      </div>
    </dl>
  );
}

function DetailFields({ title, fields }: { title: string; fields: [string, ReactNode][] }) {
  return (
    <section className="log-fact-section">
      <h4>{title}</h4>
      <dl className="log-facts">
        {fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}
      </dl>
    </section>
  );
}

function RequestFacts({ entry, keyName }: { entry: ReqLog; keyName: string }) {
  const cache = requestCacheUsage(entry);
  const error = knownText(entry.errMsg);
  const code = (value: string) => value ? <code>{value}</code> : null;
  const tokenText = (value: number | undefined) => value != null ? `${fmtNum(value)} Token` : "—";
  return (
    <>
      {error && <div className="log-error-summary">
        <strong>报错摘要</strong><pre>{error}</pre>
      </div>}
      <div className="log-fact-grid">
        <DetailFields title="请求与路由" fields={[
          ["请求 ID", code(entry.id)],
          ["时间", fmtDateTime(entry.at)],
          ["状态", `${entry.status || "—"} ${statusLabel(entry)}`],
          ["模型", code(knownText(entry.model))],
          ["路径", code(knownText(entry.path))],
          ["路由", routeLabel(entry)],
          ["账号 UID", code(knownText(entry.uid))],
          ["请求类型", entry.stream ? "SSE 流式" : "非流式"],
          ["尝试次数", entry.attempts ? `${entry.attempts} 次` : "—"],
        ]} />
        <DetailFields title="客户端" fields={[
          ["来源 IP", code(knownText(entry.clientIp))],
          ["Key 归属", keyName || UNRECORDED_KEY],
          ["机器码", code(knownText(entry.machineId))],
          ["User-Agent", code(uaDisplay(knownText(entry.ua)))],
        ]} />
        <DetailFields title="耗时与用量" fields={[
          ["总耗时", fmtLogMs(entry.durationMs)],
          ["首包耗时", entry.stream ? fmtLogMs(entry.ttfbMs) : "—"],
          ["总 Token", tokens(entry) > 0 ? tokenText(tokens(entry)) : "—"],
          ["输入 / 输出", (entry.promptTokens ?? 0) + (entry.completionTok ?? 0) > 0
            ? `${tokenText(entry.promptTokens)} / ${tokenText(entry.completionTok)}` : "—"],
          ["积分", fmtCredit(entry)],
          ["缓存命中率", cache.rate === null ? "无数据" : formatCacheRate(cache.rate)],
          ["命中 Token", cache.rate === null ? "—" : tokenText(cache.hit)],
          ["未命中 Token", cache.rate === null ? "—" : tokenText(cache.miss)],
        ]} />
      </div>
    </>
  );
}

export interface RequestLogDetailControls {
  expanded: string | null;
  onToggle: (id: string) => void;
  renderDetail: (id: string) => ReactNode;
}

export function RequestLogTable({ rows, expanded, onToggle, renderDetail, filtered, initial, error }: RequestLogDetailControls & {
  rows: ReqLog[];
  filtered: boolean;
  initial: boolean;
  error: string;
}) {
  if (initial) return <LogListLoading label="正在加载请求日志…" />;
  if (!rows.length) return (
    <div className="log-empty" role={error ? "alert" : undefined}>
      <ListFilterIcon aria-hidden="true" />
      <strong>{error ? "读取请求日志失败" : filtered ? "没有匹配的请求" : "暂无请求日志"}</strong>
      {error ? <span>{error}</span> : filtered ? <span>调整筛选条件后再试。</span> : null}
    </div>
  );
  return (
      <Table className="log-ledger log-request-table" aria-label="请求日志">
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="log-col-time">时间</TableHead>
            <TableHead scope="col" className="log-col-result">结果</TableHead>
            <TableHead scope="col">模型 / 路由</TableHead>
            <TableHead scope="col" className="log-col-key">Key 归属</TableHead>
            <TableHead scope="col" className="log-col-client">客户端</TableHead>
            <TableHead scope="col" className="log-col-timing">耗时</TableHead>
            <TableHead scope="col" className="log-col-usage">用量</TableHead>
            <TableHead scope="col" className="log-col-cache" title="按上游报告的 Token 计算">前缀缓存</TableHead>
            <TableHead scope="col" className="log-col-action"><span className="sr-only">详情</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((entry) => {
            const isOpen = expanded === entry.id;
            const detailId = `request-detail-${entry.id}`;
            const model = knownText(entry.model);
            const route = routeLabel(entry) || knownText(entry.uid);
            const keyName = entry.keyName?.trim() ?? "";
            const ip = knownText(entry.clientIp);
            const ua = uaDisplay(knownText(entry.ua));
            const sum = tokens(entry);
            const tokenLabel = sum > 0 ? `${formatLogTokens(sum)} Token` : "—";
            const exactTokens = sum > 0 ? `${fmtNum(sum)} Token` : undefined;
            return (
              <Fragment key={entry.id}>
                <TableRow className="log-data-row" data-expanded={isOpen} onClick={() => {
                  if (window.getSelection()?.isCollapsed !== false) onToggle(entry.id);
                }}>
                  <TableCell className="log-col-time">
                    <time className="log-stack log-num" dateTime={entry.at} title={fmtDateTime(entry.at)}>
                      <span>{fmtClock(entry.at)}</span><span className="log-subtle">{plainTime(entry.at)}</span>
                    </time>
                  </TableCell>
                  <TableCell className="log-col-result">
                    <div className="log-stack">
                      <RequestStatus entry={entry} />
                      {entry.errKind && <span className="truncate log-subtle" title={statusLabel(entry)}>{statusLabel(entry)}</span>}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="log-stack">
                      <span className="log-model truncate" title={model || undefined}>{model || "—"}</span>
                      {route && <span className="log-subtle truncate" title={route}>{route}</span>}
                      <div className="log-compact-key"><span className="log-subtle">Key 归属</span><RequestKeyName name={keyName} /></div>
                      <div className="log-compact-status"><RequestStatus entry={entry} /><RequestCacheCell entry={entry} compact /></div>
                      <div className="log-compact-timing log-subtle log-num">
                        <span>{fmtLogMs(entry.durationMs)}</span>
                        {sum > 0 && <span title={exactTokens}>{tokenLabel}</span>}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="log-col-key"><RequestKeyName name={keyName} /></TableCell>
                  <TableCell className="log-col-client">
                    <div className="log-stack" title={[ip, ua].filter(Boolean).join("\n") || undefined}>
                      <span className="log-num truncate">{ip || "—"}</span>
                      {ua && <span className="log-subtle truncate">{shortClient(ua)}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="log-col-timing">
                    <div className="log-stack log-num">
                      <span>{fmtLogMs(entry.durationMs)}</span>
                      {entry.stream && entry.ttfbMs ? <span className="log-subtle">首包 {fmtLogMs(entry.ttfbMs)}</span> : null}
                    </div>
                  </TableCell>
                  <TableCell className="log-col-usage">
                    <div className="log-stack log-num">
                      <span className="truncate" title={exactTokens}>{tokenLabel}</span>
                      {entry.hasCredit && <span className="log-subtle">{fmtCredit(entry)}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="log-col-cache"><RequestCacheCell entry={entry} /></TableCell>
                  <TableCell className="log-col-action">
                    <Button type="button" variant="ghost" size="icon" className="log-expand-button"
                      aria-expanded={isOpen} aria-controls={isOpen ? detailId : undefined}
                      aria-label={`${isOpen ? "收起" : "展开"}请求 ${entry.id}`} onClick={(event) => {
                        event.stopPropagation();
                        onToggle(entry.id);
                      }}>
                      <ChevronDownIcon />
                    </Button>
                  </TableCell>
                </TableRow>
                {isOpen && (
                  <TableRow className="log-expanded-row">
                    <TableCell colSpan={9}>
                      <div className="log-detail-pane" id={detailId} role="region" aria-label="请求详情">
                        <RequestFacts entry={entry} keyName={keyName} />
                        {renderDetail(entry.id)}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>
  );
}
