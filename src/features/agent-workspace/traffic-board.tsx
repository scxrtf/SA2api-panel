"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, Circle, GitMerge, MessageSquare, Monitor, Radio, Search, Wrench, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtDateTime, setKey, usePanelRefresh } from "@/app/panel/lib";
import { applyEvent, blankSnapshot, sessionColor, statusName, type Activity, type GatewaySource, type GraphNode, type Session, type Snapshot, type WorkspaceEvent } from "@/lib/workspace/contracts";
import { anchorId, useWorkspaceLights } from "./light";
import { readWorkspaceStream, requestWorkspace, WorkspaceHttpError } from "./transport";
import { WorkspaceTree } from "./tree";

const blank = blankSnapshot();
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fail = (error: unknown) => error instanceof Error ? error.message : "读取会话失败。";
const protocol = { chat: "Chat Completions", responses: "Responses", anthropic: "Messages", compact: "Responses Compact" } as const;
const evidence: Record<GatewaySource["correlation"], string> = { explicit: "会话 ID", response: "响应续接", tool: "工具续接", history: "历史匹配", unlinked: "未关联" };
const basis = { device: "客户端标识", key: "按访问密钥", connection: "按连接估算" } as const;
const pending = (session?: Session) => session?.gateway?.lastStatus === "running";
const sections = [
  { value: "sessions", label: "机器", icon: Monitor },
  { value: "chat", label: "会话", icon: MessageSquare },
  { value: "trace", label: "工作树", icon: GitMerge },
] as const;
type Section = (typeof sections)[number]["value"];

function outline(sessions: Session[]) {
  const ids = new Set(sessions.map(({ id }) => id));
  const children = new Map<string, Session[]>();
  for (const row of sessions) {
    const parent = row.parentId && ids.has(row.parentId) ? row.parentId : "";
    const items = children.get(parent);
    if (items) items.push(row);
    else children.set(parent, [row]);
  }
  const result: { row: Session; depth: number }[] = [];
  const add = (id: string, depth: number) => {
    for (const row of children.get(id) ?? []) {
      result.push({ row, depth });
      add(row.id, depth + 1);
    }
  };
  add("", 0);
  return result;
}

function groups(sessions: Session[]) {
  const byMachine = new Map<string, { source: GatewaySource; sessions: Session[] }>();
  for (const session of [...sessions].sort((a, b) => (b.gateway?.lastAt ?? 0) - (a.gateway?.lastAt ?? 0))) {
    const source = session.gateway;
    if (!source) continue;
    const group = byMachine.get(source.machineId);
    if (group) group.sessions.push(session);
    else byMachine.set(source.machineId, { source, sessions: [session] });
  }
  return [...byMachine.values()];
}

export function TrafficBoard({ enabled, active }: { enabled: boolean; active: boolean }) {
  const [snapshot, put] = useState<Snapshot>(blank);
  const [connectState, setConnectState] = useState<"loading" | "live" | "reconnecting" | "error">("loading");
  const [attempt, retry] = useState(0);
  const [message, setMessage] = useState("");
  const [requiresKey, setRequiresKey] = useState(false);
  const [password, setPassword] = useState("");
  const [requested, setRequested] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [selectedNode, setSelectedNode] = useState<string>();
  const [flights, setFlights] = useState<WorkspaceEvent[]>([]);
  const [mobile, setMobile] = useState<Section>("chat");
  const [compact, setCompact] = useState(false);
  const [filter, setFilter] = useState("");
  const [away, setAway] = useState(false);
  const overlay = useRef<HTMLElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const graphScroller = useRef<HTMLDivElement>(null);
  const lastSession = useRef<string | undefined>(undefined);
  const follow = useRef(true), followGraph = useRef(true);
  const available = enabled && !requiresKey && connectState !== "error";
  useWorkspaceLights(overlay, flights, !active, active && available);
  usePanelRefresh(() => retry((n) => n + 1));

  useLayoutEffect(() => {
    const root = overlay.current;
    if (!active || !root) return;
    const measure = () => {
      if (root.clientWidth > 0) setCompact(root.clientWidth <= 820);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [active]);

  useEffect(() => {
    if (!enabled || !active) return;
    const cancel = new AbortController();
    let cursor = 0, rootId = "", currentId = "";
    const roots = new Map<string, string>();
    async function connect() {
      try {
        const id = new URL(window.location.href).searchParams.get("session") ?? lastSession.current ?? requested;
        const initial = await (await requestWorkspace(id ? "?session=" + encodeURIComponent(id) : "", { signal: cancel.signal })).json() as Snapshot;
        if (cancel.signal.aborted) return;
        for (const session of initial.sessions) roots.set(session.id, session.rootId);
        const selected = (id && initial.sessions.find((s) => s.id === id)) || initial.sessions[0];
        currentId = selected?.id ?? "";
        rootId = selected?.rootId ?? "";
        cursor = initial.cursor;
        setSelected(currentId || undefined);
        if (currentId !== lastSession.current) setSelectedNode(undefined);
        lastSession.current = currentId || undefined;
        put(initial);
        setRequiresKey(false);
        setMessage("");
        setFlights([]);
      } catch (error) {
        if (cancel.signal.aborted) return;
        setRequiresKey(error instanceof WorkspaceHttpError && error.status === 401);
        setMessage(fail(error));
        setConnectState("error");
        return;
      }

      let backoff = 350;
      while (!cancel.signal.aborted) {
        try {
          let live = false;
          const response = await requestWorkspace("/events?after=" + cursor, { signal: cancel.signal });
          await readWorkspaceStream(response, (type, payload) => {
            if (cancel.signal.aborted) return;
            if (type === "live") { live = true; backoff = 350; setConnectState("live"); return; }
            if (type !== "workspace") return;
            const event = payload as WorkspaceEvent;
            if (event.seq <= cursor) return;
            cursor = event.seq;
            if (event.session) {
              roots.set(event.session.id, event.session.rootId);
              if (!currentId) {
                currentId = event.session.id;
                rootId = event.session.rootId;
                lastSession.current = currentId;
                setSelected(currentId);
              }
            }
            const id = event.node?.sessionId ?? event.activity?.sessionId ?? event.run?.sessionId ?? "";
            const belongs = roots.get(id) === rootId;
            put((old) => {
              if (!belongs) return applyEvent(old, { seq: event.seq, session: event.session });
              const next = applyEvent(old, event);
              return { ...next, nodes: next.nodes.slice(-640), activities: next.activities.slice(-640), runs: next.runs.slice(-128) };
            });
            if (live && belongs && event.beacon) setFlights((old) => [...old.slice(-23), event]);
          });
        } catch (error) {
          if (cancel.signal.aborted) return;
          if (error instanceof WorkspaceHttpError && error.status === 409) { retry((i) => i + 1); return; }
          if (error instanceof WorkspaceHttpError && [401, 404].includes(error.status)) {
            setRequiresKey(error.status === 401);
            setMessage(fail(error));
            setConnectState("error");
            return;
          }
        }
        if (cancel.signal.aborted) return;
        setConnectState("reconnecting");
        await wait(backoff);
        backoff = Math.min(4000, backoff * 2);
      }
    }
    void connect();
    return () => cancel.abort();
  }, [enabled, active, attempt, requested]);

  const session = snapshot.sessions.find((row) => row.id === selected);
  const source = session?.gateway;
  const lanes = outline(snapshot.sessions.filter((row) => row.rootId === session?.rootId)).map(({ row }) => row);
  const ids = new Set(lanes.map((row) => row.id));
  const nodes = snapshot.nodes.filter((node) => ids.has(node.sessionId));
  const activities = snapshot.activities.filter((item) => item.sessionId === selected);
  const current = nodes.find((node) => node.id === selectedNode);
  const tail = activities.at(-1)?.id;
  useLayoutEffect(() => {
    if (followGraph.current && graphScroller.current?.clientHeight) graphScroller.current.scrollTop = graphScroller.current.scrollHeight;
  }, [active, compact, nodes.length, mobile]);
  useLayoutEffect(() => {
    if (follow.current && scroller.current?.clientHeight) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [active, compact, selected, tail, mobile]);

  function syncUrl(id: string) {
    lastSession.current = id;
    const url = new URL(window.location.href);
    url.searchParams.set("session", id);
    window.history.replaceState(null, "", url);
  }
  function choose(item: Session) {
    follow.current = true;
    followGraph.current = true;
    setAway(false);
    setSelected(item.id);
    setSelectedNode(undefined);
    setMobile("chat");
    syncUrl(item.id);
    if (item.rootId !== session?.rootId) setRequested(item.id);
  }
  function jump(node: GraphNode) {
    follow.current = false;
    setSelected(node.sessionId);
    setSelectedNode(node.id);
    setMobile("chat");
    syncUrl(node.sessionId);
    if (!node.activityId) return;
    requestAnimationFrame(() => {
      const destination = document.getElementById(anchorId("activity", node.activityId!));
      if (destination && scroller.current) {
        const surface = scroller.current;
        surface.scrollTop += destination.getBoundingClientRect().top - surface.getBoundingClientRect().top - 16;
        destination.focus({ preventScroll: true });
      }
    });
  }
  const machines = groups(snapshot.sessions);
  const term = filter.trim().toLocaleLowerCase();
  const filtered = !term ? machines : machines.flatMap((machine) => {
    if (machine.source.machineLabel.toLocaleLowerCase().includes(term)) return [machine];
    const sessions = machine.sessions.filter(({ name, gateway }) => [name, gateway?.client, gateway?.model]
      .some((entry) => entry?.toLocaleLowerCase().includes(term)));
    return sessions.length ? [{ ...machine, sessions }] : [];
  });
  const header = (
    <header className="aw-header">
      <div className="aw-title">
        <Radio size={16} className="aw-header-icon" aria-hidden="true" /><span className="aw-header-label">会话观测</span>
        {available && <span className="aw-muted aw-header-count">{snapshot.sessions.length} 条会话</span>}
      </div>
      <div className="aw-header-actions">
        {enabled && !requiresKey && <Badge variant="outline"><Radio size={12} className={connectState === "live" ? "aw-online" : undefined} />
          {connectState === "live" ? "实时观测" : connectState === "reconnecting" ? "正在重连" : connectState === "loading" ? "读取中" : "未连接"}
        </Badge>}
      </div>
    </header>
  );
  const gate = !available && (
    <section className="aw-empty aw-gate">
      <h2>{!enabled ? "会话观测未启用" : requiresKey ? "验证面板权限" : "连接失败"}</h2>
      <p>{!enabled ? "在服务端设置 WB2_WORKSPACE_ENABLED=1。" : message}</p>
      {requiresKey ? <form className="aw-actions" onSubmit={(event) => {
        event.preventDefault();
        if (password.trim()) { setKey(password.trim()); setPassword(""); retry((n) => n + 1); }
      }}>
        <Input aria-label="面板主密钥" type="password" value={password} autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
        <Button type="submit" disabled={!password.trim()}>进入面板</Button>
      </form> : enabled ? <Button variant="outline" onClick={() => retry((n) => n + 1)}>重新连接</Button> : null}
    </section>
  );

  const panes = {
    sessions: (
      <aside className="aw-sessions" aria-label="机器与会话">
        <div className="aw-section-head"><h2><Monitor size={15} aria-hidden="true" />机器</h2><span className="aw-count">{filtered.length} 台</span></div>
        <div className="aw-search">
          <Search size={15} aria-hidden="true" />
          <Input aria-label="搜索机器或会话" placeholder="搜索机器或会话" value={filter} onChange={(event) => setFilter(event.target.value)} />
          {filter && <Button type="button" variant="ghost" size="icon-xs" aria-label="清除搜索" onClick={() => setFilter("")}><X size={14} /></Button>}
        </div>
        <div className="aw-session-list" data-aw-viewport>
          {!filtered.length && <div className="aw-empty">{term ? "没有匹配的机器或会话" : connectState === "loading" ? "读取机器中" : "暂无客户端请求"}</div>}
          {filtered.map((machine) => <section key={machine.source.machineId} className="aw-machine">
            <h3 title={machine.source.machineLabel}><span>{machine.source.machineLabel}</span></h3>
            <div className="aw-muted aw-machine-meta"><span>{basis[machine.source.machineBasis]}</span><span>{machine.sessions.length} 条会话</span></div>
            {outline(machine.sessions).map(({ row: item, depth }) => <Button key={item.id} variant="ghost" className="aw-session"
              style={depth ? { paddingInlineStart: 8 + Math.min(4, depth) * 14 } : undefined}
              aria-current={item.id === selected ? "true" : undefined} onClick={() => choose(item)}>
              <span className="aw-session-icon" id={anchorId("engine", item.id)} style={{ color: sessionColor(item.id) }}><Circle size={12} fill={pending(item) ? "currentColor" : "none"} /></span>
              <span className="aw-session-label"><strong title={item.name}>{item.name}</strong><small>
                <span>{item.gateway?.client}</span><span>{item.gateway ? evidence[item.gateway.correlation] : ""}</span>
              </small></span>
            </Button>)}
          </section>)}
        </div>
      </aside>
    ),
    chat: (
      <section className="aw-chat" aria-label="客户端会话">
        <div className="aw-section-head">
          <div className="aw-chat-title"><h2 title={session?.name}>{session?.name ?? "客户端会话"}</h2>
            {session && source && <Badge variant="outline" id={anchorId("model", session.id)} title={source.model}>{source.client}</Badge>}</div>
          {source?.lastStatus && <Badge variant={source.lastStatus === "failed" ? "destructive" : "outline"}>{statusName[source.lastStatus]}</Badge>}
        </div>
        {source && <div className="aw-session-summary aw-muted" title={source.model}>
          <span>{source.machineLabel}</span><span>{protocol[source.protocol]}</span><span>{source.model}</span>
          <time>{fmtDateTime(source.lastAt)}</time>
        </div>}
        <div className="aw-transcript" ref={scroller} data-aw-viewport onScroll={() => {
          const surface = scroller.current;
          if (!surface) return;
          follow.current = surface.scrollHeight - surface.scrollTop - surface.clientHeight < 42;
          setAway(!follow.current);
        }}>
          {!activities.length && <div className="aw-empty aw-intro"><MessageSquare size={22} aria-hidden="true" />
            <h3>{connectState === "loading" ? "正在恢复会话" : session ? "本会话暂无记录" : "等待客户端请求"}</h3>
            <p>{connectState === "loading" ? "正在读取最近的网关活动。" : session ? "新的请求和回复会显示在这里。" : "客户端发来的请求会自动按机器与会话归档。"}</p></div>}
          {activities.map((item) => <ObservedActivity key={item.id} item={item} focused={item.id === current?.activityId} />)}
        </div>
        {away && <Button variant="outline" size="sm" className="aw-follow" onClick={() => {
          follow.current = true; setAway(false); if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
        }}><ArrowDown size={14} />回到最新</Button>}
      </section>
    ),
    trace: (
      <aside className="aw-trace" aria-label="会话工作树">
        <div className="aw-section-head"><h2><GitMerge size={15} aria-hidden="true" />工作树</h2><span className="aw-count">{nodes.length} 个节点</span></div>
        <div className="aw-graph-scroll" ref={graphScroller} data-aw-viewport onScroll={() => {
          const surface = graphScroller.current;
          if (surface) followGraph.current = surface.scrollHeight - surface.scrollTop - surface.clientHeight < 45;
        }}>
          <WorkspaceTree nodes={nodes} sessions={lanes} selected={selectedNode} onSelect={jump} />
        </div>
      </aside>
    ),
  };
  return <section className="aw-screen" ref={overlay} aria-label="机器会话工作台" data-compact={compact ? "true" : undefined}>
    {header}
    {connectState === "reconnecting" && available && <div role="status" className="aw-inline-note">正在恢复事件流，模型调用不受影响。</div>}
    {gate || (compact
      ? <Tabs className="aw-compact" value={mobile} onValueChange={(value) => {
        const next = sections.find((entry) => entry.value === value);
        if (next) setMobile(next.value);
      }}>
        <TabsList variant="line" className="aw-mobile-tabs" aria-label="会话面板">
          {sections.map(({ value, label, icon: Icon }) => <TabsTrigger key={value} value={value}>
            <Icon size={15} aria-hidden="true" />{label}
          </TabsTrigger>)}
          <TabsIndicator className="aw-tab-indicator" />
        </TabsList>
        <div className="aw-compact-body">
          {sections.map(({ value }) => <TabsContent className="aw-section-panel" value={value} key={value} hidden={mobile !== value} keepMounted>
            {panes[value]}
          </TabsContent>)}
        </div>
      </Tabs>
      : <div className="aw-body">{panes.sessions}{panes.chat}{panes.trace}</div>)}
  </section>;
}

function ObservedActivity({ item, focused }: { item: Activity; focused: boolean }) {
  const anchor = { id: anchorId("activity", item.id), tabIndex: -1, "data-selected": focused || undefined };
  if (item.kind === "tool") return <div className="aw-activity aw-observed-tool" {...anchor}>
    <Wrench size={14} /><strong>{item.title}</strong>{item.text && <span className="aw-muted">{item.text}</span>}
  </div>;
  if (item.kind === "status") return <div className="aw-activity aw-status" {...anchor}><span>{item.title}</span>{item.text && <p>{item.text}</p>}</div>;
  return <article className={`aw-activity aw-message aw-message-${item.kind}`} {...anchor}>
    <h3>{item.title}</h3><div>{item.text}</div>
  </article>;
}
