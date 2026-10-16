"use client";
// 管理面板单页：概览 / 账号 / 配置 / 密钥 / 供应商 / 日志 / 用量。
import { useCallback, useEffect, useRef, useState } from "react";
import { req, getKey, setKey, fmtNum, fmtTime, fmtDur } from "./lib";

// ─── 类型（与后端响应对齐） ────────────────────────────────────────────────
interface StatusRow {
  uid: string; nickname: string; realm: string; enterprise: boolean;
  credits: number; credits_total: number; credits_expiring: number;
  credits_earliest_expiry: number; credits_earliest_remaining: number;
  cooling: boolean; cool_kind: string; cool_remaining_sec: number; reason: string;
  disabled: boolean; disabled_reason: string; paused: boolean; checkin_done: boolean;
  soft_streak: number; in_flight: number; breaker_fails: number;
  breaker_until: number; degrade_until: number;
  rate_limited_models: { model: string; kind: string; until: number; reason: string }[];
  model_costs: { model: string; cost_per_1k: number; last_seen: number }[];
}
interface Overview {
  version: string; uptime_sec: number; auth_required: boolean;
  total: number; healthy: number; cooling: number; disabled: number; paused: number;
  sticky_sessions: number; accounts: StatusRow[];
  gateway: { enabled: boolean; providers: number; keys: number };
}
interface KeyRow { name: string; key_mask: string; created_at: string }
interface ProviderRow { name: string; base_url: string; key_mask: string; created_at: string }
interface LogEntry { ts: string; channel: string; line: string }
interface ReqLog {
  id: string; at: string; uid: string; model: string; status: number;
  durationMs: number; errKind: string; clientIp: string; ua: string;
  realm: string; provider: string; stream: boolean;
}
interface UsageResp {
  count: number; ok_count: number;
  prompt_tokens: number; completion_tokens: number; total_tokens: number; credit: number;
  by_model: { model: string; n: number; tokens: number; credit: number }[];
  by_account: { uid: string; nickname: string; n: number; tokens: number; credit: number }[];
}
type Config = Record<string, string | number | boolean>;

type Tab = "overview" | "accounts" | "config" | "keys" | "providers" | "logs" | "usage";

// ─── 主组件 ────────────────────────────────────────────────────────────────
export default function PanelPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [ov, setOv] = useState<Overview | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const busy = useRef(false);

  const flash = (kind: "ok" | "err", text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 5000);
  };

  const loadOverview = useCallback(async () => {
    try {
      const r = await req<Overview>("overview");
      setOv(r);
      setAuthed(true);
    } catch (e) {
      if (e instanceof Error && e.message === "__AUTH__") { setAuthed(false); return; }
      flash("err", e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  // 账号操作统一入口：POST /accounts/{uid}/{action}。
  const acctOp = async (uid: string, action: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await req("accounts/" + encodeURIComponent(uid) + "/" + action, { method: "POST", body: {} });
      const extra = r.checkin_message ? "：" + String(r.checkin_message) : "";
      flash("ok", action + " 成功" + extra);
      await loadOverview();
    } catch (e) {
      flash("err", action + " 失败：" + (e instanceof Error ? e.message : String(e)));
    } finally { busy.current = false; }
  };

  const batchOp = async (path: string, label: string) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await req(path, { method: "POST", body: {} });
      flash("ok", label + " 完成：" + JSON.stringify(r).slice(0, 200));
      await loadOverview();
    } catch (e) {
      flash("err", label + " 失败：" + (e instanceof Error ? e.message : String(e)));
    } finally { busy.current = false; }
  };

  // ── 登录页 ──
  if (authed === null) return <div className="panel-shell dim">加载中…</div>;
  if (authed === false) {
    return (
      <div className="login-wrap">
        <div className="card">
          <div className="card-title">workbuddy2api 面板</div>
          <div className="form-row">
            <label className="form-label">主密钥（API Key）</label>
            <input className="input" type="password" value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { setKey(keyInput); loadOverview(); } }}
              placeholder="输入 WB2A_API_KEY" autoFocus />
          </div>
          {msg && <div className={"msg " + msg.kind}>{msg.text}</div>}
          <button className="btn primary" style={{ width: "100%" }}
            onClick={() => { setKey(keyInput); loadOverview(); }}>进入面板</button>
          <div className="dim" style={{ marginTop: 10, fontSize: 12 }}>
            密钥仅保存在浏览器 localStorage，所有请求以 Bearer 头携带。
          </div>
        </div>
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "概览" },
    { id: "accounts", label: "账号" },
    { id: "config", label: "配置" },
    { id: "keys", label: "密钥" },
    { id: "providers", label: "供应商" },
    { id: "logs", label: "日志" },
    { id: "usage", label: "用量" },
  ];

  return (
    <div className="panel-shell">
      <div className="panel-topbar">
        <div className="panel-title">workbuddy2api</div>
        <div className="panel-tabs">
          {tabs.map((t) => (
            <button key={t.id} className={"panel-tab" + (tab === t.id ? " active" : "")}
              onClick={() => setTab(t.id)}>{t.label}</button>
          ))}
        </div>
        <div style={{ marginLeft: "auto" }} className="dim">
          {ov ? "v" + ov.version + " · 运行 " + fmtDur(ov.uptime_sec) : ""}
        </div>
      </div>
      {msg && <div className={"msg " + msg.kind}>{msg.text}</div>}

      {tab === "overview" && ov && <OverviewTab ov={ov} onRefresh={loadOverview}
        onCheckinAll={() => batchOp("checkin_all", "批量签到")}
        onBalanceAll={() => batchOp("balance_all", "批量刷新余额")} />}
      {tab === "accounts" && ov && (
        <AccountsTab accounts={ov.accounts} onOp={acctOp}
          onAdd={() => setAddOpen(true)} onRefresh={loadOverview} />
      )}
      {tab === "config" && <ConfigTab flash={flash} />}
      {tab === "keys" && <KeysTab flash={flash} />}
      {tab === "providers" && <ProvidersTab flash={flash} />}
      {tab === "logs" && <LogsTab flash={flash} />}
      {tab === "usage" && <UsageTab flash={flash} />}

      {addOpen && <AddAccountModal onClose={() => setAddOpen(false)}
        onDone={async () => { setAddOpen(false); await loadOverview(); }} />}
    </div>
  );
}

// ─── 概览 ──────────────────────────────────────────────────────────────────
function OverviewTab({ ov, onRefresh, onCheckinAll, onBalanceAll }: {
  ov: Overview; onRefresh: () => void; onCheckinAll: () => void; onBalanceAll: () => void;
}) {
  const stats: [string, number | string][] = [
    ["账号总数", ov.total], ["健康", ov.healthy], ["冷却中", ov.cooling],
    ["已禁用", ov.disabled], ["已暂停", ov.paused],
    ["粘性会话", ov.sticky_sessions],
    ["供应商", ov.gateway.providers], ["网关密钥", ov.gateway.keys],
  ];
  return (
    <>
      <div className="card">
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <button className="btn" onClick={onRefresh}>刷新</button>
          <button className="btn" onClick={onCheckinAll}>全部签到</button>
          <button className="btn" onClick={onBalanceAll}>全部刷新余额</button>
        </div>
        <div className="stat-grid">
          {stats.map(([label, v]) => (
            <div key={label} className="stat">
              <div className="stat-num">{v}</div>
              <div className="stat-label">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── 账号 ──────────────────────────────────────────────────────────────────
function acctTags(a: StatusRow) {
  const tags: { text: string; cls: string }[] = [];
  if (a.disabled) tags.push({ text: "禁用" + (a.disabled_reason ? ":" + a.disabled_reason : ""), cls: "err" });
  else if (a.paused) tags.push({ text: "暂停", cls: "warn" });
  else if (a.cooling) tags.push({ text: "冷却 " + fmtDur(a.cool_remaining_sec) + (a.cool_kind ? " " + a.cool_kind : ""), cls: "warn" });
  else tags.push({ text: "健康", cls: "ok" });
  if (a.checkin_done) tags.push({ text: "已签到", cls: "info" });
  if (a.in_flight > 0) tags.push({ text: "在途 " + a.in_flight, cls: "info" });
  if (a.rate_limited_models.length > 0) tags.push({ text: "限流模型 " + a.rate_limited_models.length, cls: "warn" });
  return tags;
}

function AccountsTab({ accounts, onOp, onAdd, onRefresh }: {
  accounts: StatusRow[];
  onOp: (uid: string, action: string, confirmText?: string) => void;
  onAdd: () => void; onRefresh: () => void;
}) {
  return (
    <div className="card">
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className="btn primary" onClick={onAdd}>添加账号</button>
        <button className="btn" onClick={onRefresh}>刷新</button>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr>
            <th>账号</th><th>域</th><th>余额</th><th>状态</th><th>操作</th>
          </tr></thead>
          <tbody>
            {accounts.length === 0 && (
              <tr><td colSpan={5} className="dim">暂无账号，点击「添加账号」开始设备授权登录。</td></tr>
            )}
            {accounts.map((a) => (
              <tr key={a.uid}>
                <td>
                  <div>{a.nickname || a.uid}</div>
                  <div className="dim mono">{a.uid}</div>
                </td>
                <td>{a.realm}{a.enterprise ? "（企）" : ""}</td>
                <td>
                  {fmtNum(a.credits)} / {fmtNum(a.credits_total)}
                  {a.credits_expiring > 0 && (
                    <div className="dim" style={{ fontSize: 12 }}>
                      将过期 {fmtNum(a.credits_expiring)}
                      {a.credits_earliest_expiry > 0 && " · 最早 " + fmtTime(a.credits_earliest_expiry)}
                    </div>
                  )}
                </td>
                <td>{acctTags(a).map((t) => <span key={t.text} className={"tag " + t.cls}>{t.text}</span>)}</td>
                <td>
                  <div className="btn-row">
                    <button className="btn small" onClick={() => onOp(a.uid, "checkin")}>签到</button>
                    <button className="btn small" onClick={() => onOp(a.uid, "balance")}>余额</button>
                    {a.paused
                      ? <button className="btn small" onClick={() => onOp(a.uid, "resume")}>恢复</button>
                      : <button className="btn small" onClick={() => onOp(a.uid, "pause")}>暂停</button>}
                    {a.disabled
                      ? <button className="btn small" onClick={() => onOp(a.uid, "revive")}>复活</button>
                      : <button className="btn small danger" onClick={() => onOp(a.uid, "disable", "确认禁用 " + a.uid + "？")}>禁用</button>}
                    <button className="btn small danger"
                      onClick={() => onOp(a.uid, "remove", "确认移除 " + a.uid + "？该操作不可撤销。")}>移除</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── 添加账号（设备授权弹窗） ──────────────────────────────────────────────
function AddAccountModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [realm, setRealm] = useState("cn");
  const [url, setUrl] = useState("");
  const [state, setState] = useState("");
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => { if (timer.current) { clearInterval(timer.current); timer.current = null; } };
  useEffect(() => stop, []);

  const start = async () => {
    setErr(""); setStatus("正在发起授权…");
    try {
      const r = await req<{ url: string; state: string }>("login/start", { method: "POST", body: { realm } });
      setUrl(r.url); setState(r.state);
      setStatus("等待用户在打开的页面中完成授权…（每 3 秒轮询）");
      stop();
      timer.current = setInterval(async () => {
        try {
          const p = await req<{ done: boolean; message?: string; uid?: string }>(
            "login/poll?state=" + encodeURIComponent(r.state));
          if (p.done) {
            stop();
            setStatus("登录成功，账号 " + (p.uid ?? "") + " 已入库。");
            setTimeout(onDone, 1200);
          } else if (p.message) {
            setStatus("等待授权…（" + p.message + "）");
          }
        } catch (e) {
          stop();
          setErr(e instanceof Error ? e.message : String(e));
        }
      }, 3000);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus("");
    }
  };

  return (
    <div className="modal-mask" onClick={(e) => { if (e.target === e.currentTarget) { stop(); onClose(); } }}>
      <div className="modal">
        <div className="modal-title">添加账号（WorkBuddy 设备授权）</div>
        <div className="form-row">
          <label className="form-label">账号域</label>
          <select className="select" value={realm} onChange={(e) => setRealm(e.target.value)} disabled={!!state}>
            <option value="cn">国内（codebuddy.cn）</option>
            <option value="global">国际（workbuddy.ai）</option>
          </select>
        </div>
        {!state && <button className="btn primary" onClick={start}>发起授权</button>}
        {url && (
          <div className="form-row" style={{ marginTop: 12 }}>
            <label className="form-label">请在浏览器中打开以下链接完成授权：</label>
            <div className="mono" style={{ padding: 8, background: "var(--bg-soft)", borderRadius: 6 }}>
              <a href={url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>{url}</a>
            </div>
          </div>
        )}
        {status && <div className="msg ok">{status}</div>}
        {err && <div className="msg err">{err}</div>}
        <div style={{ marginTop: 14, textAlign: "right" }}>
          <button className="btn" onClick={() => { stop(); onClose(); }}>关闭</button>
        </div>
      </div>
    </div>
  );
}

// ─── 配置 ──────────────────────────────────────────────────────────────────
const CONFIG_FIELDS: { key: string; label: string; type: "number" | "text" | "bool" | "select"; options?: string[] }[] = [
  { key: "api_key", label: "主密钥（留空=不鉴权，慎用）", type: "text" },
  { key: "max_rotate", label: "单请求最大轮换次数", type: "number" },
  { key: "refresh_skew_sec", label: "token 提前刷新窗口（秒）", type: "number" },
  { key: "soft_cooldown_ms", label: "软限流冷却基数（ms）", type: "number" },
  { key: "soft_rate_max_ms", label: "软限流冷却封顶（ms）", type: "number" },
  { key: "breaker_threshold", label: "熔断连败阈值", type: "number" },
  { key: "breaker_cooldown_ms", label: "熔断冷却基数（ms）", type: "number" },
  { key: "breaker_cooldown_max_ms", label: "熔断冷却封顶（ms）", type: "number" },
  { key: "max_in_flight", label: "单账号最大在途（0=不限）", type: "number" },
  { key: "max_in_flight_global", label: "global 域在途上限（0=同上）", type: "number" },
  { key: "idle_weight_per_hour", label: "闲置补偿权重/小时", type: "number" },
  { key: "idle_weight_max", label: "闲置补偿上限", type: "number" },
  { key: "prefer_expiring", label: "快过期积分优先", type: "bool" },
  { key: "credit_floor", label: "积分保底（收费模型门槛）", type: "number" },
  { key: "session_sticky", label: "会话粘性", type: "bool" },
  { key: "passthrough_ip", label: "客户端 IP 透传", type: "bool" },
  { key: "client_name", label: "用量归属名", type: "text" },
  { key: "client_version", label: "客户端版本段", type: "text" },
  { key: "cli_version", label: "CLI 版本段", type: "text" },
  { key: "user_agent", label: "UA 覆盖", type: "text" },
  { key: "device_token", label: "全局 X-Device-Token", type: "text" },
  { key: "prompt_mode", label: "提示词模式", type: "select", options: ["passthrough", "custom", "append"] },
  { key: "prompt_text", label: "提示词内容", type: "text" },
  { key: "header_timeout_ms", label: "上游响应头超时（ms）", type: "number" },
  { key: "stream_idle_ms", label: "流空闲看门狗（ms，0=关）", type: "number" },
];

function ConfigTab({ flash }: { flash: (k: "ok" | "err", t: string) => void }) {
  const [cfg, setCfg] = useState<Config | null>(null);

  useEffect(() => {
    req<{ config: Config }>("config")
      .then((r) => setCfg(r.config))
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [flash]);

  if (!cfg) return <div className="card dim">加载配置…</div>;

  const set = (k: string, v: string | number | boolean) => setCfg({ ...cfg, [k]: v });

  const save = async () => {
    try {
      await req("config", { method: "POST", body: cfg });
      flash("ok", "配置已保存并热生效");
    } catch (e) {
      flash("err", "保存失败：" + (e instanceof Error ? e.message : String(e)));
    }
  };

  return (
    <div className="card">
      <div className="card-title">运行配置（保存即热生效）</div>
      <div className="form-grid">
        {CONFIG_FIELDS.map((f) => (
          <div key={f.key} className="form-row">
            <label className="form-label">{f.label}</label>
            {f.type === "bool" ? (
              <select className="select" value={String(cfg[f.key])}
                onChange={(e) => set(f.key, e.target.value === "true")}>
                <option value="true">开</option><option value="false">关</option>
              </select>
            ) : f.type === "select" ? (
              <select className="select" value={String(cfg[f.key] ?? "")}
                onChange={(e) => set(f.key, e.target.value)}>
                {(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input className="input" type={f.type === "number" ? "number" : "text"}
                value={String(cfg[f.key] ?? "")}
                onChange={(e) => set(f.key, f.type === "number" ? Number(e.target.value) : e.target.value)} />
            )}
          </div>
        ))}
      </div>
      <button className="btn primary" onClick={save}>保存配置</button>
    </div>
  );
}

// ─── 密钥 ──────────────────────────────────────────────────────────────────
function KeysTab({ flash }: { flash: (k: "ok" | "err", t: string) => void }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);

  const load = useCallback(() => {
    req<{ keys: KeyRow[] }>("keys")
      .then((r) => setKeys(r.keys))
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [flash]);
  useEffect(load, [load]);

  const create = async () => {
    try {
      const r = await req<{ name: string; key: string }>("keys", { method: "POST", body: { name } });
      setCreated(r); setName(""); load();
      flash("ok", "密钥已创建，请立即复制保存（仅显示一次）");
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };
  const remove = async (n: string) => {
    if (!window.confirm("确认删除密钥 " + n + "？")) return;
    try { await req("keys/" + encodeURIComponent(n), { method: "DELETE" }); load(); }
    catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="card">
      <div className="card-title">网关密钥环（可调用 /api/v1/* 的子密钥）</div>
      {created && (
        <div className="msg ok">
          新密钥 {created.name}：<span className="mono">{created.key}</span>（仅显示一次，请立即保存）
        </div>
      )}
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <input className="input" style={{ width: 220 }} placeholder="密钥名称"
          value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" onClick={create} disabled={!name.trim()}>新建密钥</button>
      </div>
      <table className="tbl">
        <thead><tr><th>名称</th><th>掩码</th><th>创建时间</th><th></th></tr></thead>
        <tbody>
          {(keys ?? []).map((k) => (
            <tr key={k.name}>
              <td>{k.name}</td><td className="mono">{k.key_mask}</td>
              <td className="dim">{new Date(k.created_at).toLocaleString("zh-CN", { hour12: false })}</td>
              <td><button className="btn small danger" onClick={() => remove(k.name)}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── 供应商 ────────────────────────────────────────────────────────────────
function ProvidersTab({ flash }: { flash: (k: "ok" | "err", t: string) => void }) {
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [form, setForm] = useState({ name: "", base_url: "", key: "" });

  const load = useCallback(() => {
    req<{ providers: ProviderRow[] }>("providers")
      .then((r) => setRows(r.providers))
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [flash]);
  useEffect(load, [load]);

  const create = async () => {
    try {
      await req("providers", { method: "POST", body: form });
      setForm({ name: "", base_url: "", key: "" }); load();
      flash("ok", "供应商已添加");
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };
  const remove = async (n: string) => {
    if (!window.confirm("确认删除供应商 " + n + "？")) return;
    try { await req("providers/" + encodeURIComponent(n), { method: "DELETE" }); load(); }
    catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };

  return (
    <div className="card">
      <div className="card-title">聚合供应商（OpenAI 兼容上游，模型以「供应商名:模型」暴露）</div>
      <div className="form-grid" style={{ marginBottom: 10 }}>
        <div className="form-row"><label className="form-label">名称</label>
          <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="form-row"><label className="form-label">Base URL</label>
          <input className="input" placeholder="https://api.example.com/v1" value={form.base_url}
            onChange={(e) => setForm({ ...form, base_url: e.target.value })} /></div>
        <div className="form-row"><label className="form-label">API Key</label>
          <input className="input" type="password" value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value })} /></div>
      </div>
      <button className="btn primary" onClick={create}
        disabled={!form.name || !form.base_url || !form.key}>添加供应商</button>
      <table className="tbl" style={{ marginTop: 14 }}>
        <thead><tr><th>名称</th><th>Base URL</th><th>Key 掩码</th><th></th></tr></thead>
        <tbody>
          {(rows ?? []).map((p) => (
            <tr key={p.name}>
              <td>{p.name}</td><td className="mono">{p.base_url}</td><td className="mono">{p.key_mask}</td>
              <td><button className="btn small danger" onClick={() => remove(p.name)}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── 日志 ──────────────────────────────────────────────────────────────────
function LogsTab({ flash }: { flash: (k: "ok" | "err", t: string) => void }) {
  const [mode, setMode] = useState<"runtime" | "requests">("requests");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [reqs, setReqs] = useState<ReqLog[]>([]);
  const [filter, setFilter] = useState({ account: "", model: "", outcome: "" });

  const load = useCallback(() => {
    if (mode === "runtime") {
      req<{ entries: LogEntry[] }>("logs")
        .then((r) => setLogs(r.entries))
        .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
    } else {
      const q = new URLSearchParams();
      if (filter.account) q.set("account", filter.account);
      if (filter.model) q.set("model", filter.model);
      if (filter.outcome) q.set("outcome", filter.outcome);
      req<{ entries: ReqLog[] }>("request_logs?" + q.toString())
        .then((r) => setReqs(r.entries))
        .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
    }
  }, [mode, filter, flash]);
  useEffect(load, [load]);

  return (
    <div className="card">
      <div className="btn-row" style={{ marginBottom: 12 }}>
        <button className={"btn" + (mode === "requests" ? " primary" : "")} onClick={() => setMode("requests")}>请求日志</button>
        <button className={"btn" + (mode === "runtime" ? " primary" : "")} onClick={() => setMode("runtime")}>运行日志</button>
        <input className="input" style={{ width: 140 }} placeholder="账号过滤" value={filter.account}
          onChange={(e) => setFilter({ ...filter, account: e.target.value })} />
        <input className="input" style={{ width: 140 }} placeholder="模型过滤" value={filter.model}
          onChange={(e) => setFilter({ ...filter, model: e.target.value })} />
        <select className="select" style={{ width: 110 }} value={filter.outcome}
          onChange={(e) => setFilter({ ...filter, outcome: e.target.value })}>
          <option value="">全部结果</option><option value="ok">仅成功</option><option value="error">仅失败</option>
        </select>
        <button className="btn" onClick={load}>刷新</button>
      </div>
      {mode === "runtime" ? (
        <div className="mono" style={{ maxHeight: 480, overflowY: "auto" }}>
          {logs.map((l, i) => <div key={i}>{new Date(l.ts).toLocaleTimeString("zh-CN", { hour12: false })} {l.line}</div>)}
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>时间</th><th>账号</th><th>模型</th><th>状态</th><th>耗时</th><th>流式</th><th>错误</th></tr></thead>
            <tbody>
              {reqs.map((r) => (
                <tr key={r.id}>
                  <td className="dim">{new Date(r.at).toLocaleString("zh-CN", { hour12: false })}</td>
                  <td>{r.uid}</td><td>{r.model}</td>
                  <td><span className={"tag " + (r.status < 400 ? "ok" : "err")}>{r.status}</span></td>
                  <td>{r.durationMs}ms</td>
                  <td>{r.stream ? "是" : "否"}</td>
                  <td className="dim">{r.errKind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── 用量 ──────────────────────────────────────────────────────────────────
function UsageTab({ flash }: { flash: (k: "ok" | "err", t: string) => void }) {
  const [hours, setHours] = useState(72);
  const [u, setU] = useState<UsageResp | null>(null);

  const load = useCallback(() => {
    req<UsageResp>("usage?hours=" + hours)
      .then(setU)
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [hours, flash]);
  useEffect(load, [load]);

  if (!u) return <div className="card dim">加载用量…</div>;
  const t = u;
  return (
    <>
      <div className="card">
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <select className="select" style={{ width: 140 }} value={hours}
            onChange={(e) => setHours(Number(e.target.value))}>
            <option value={24}>近 24 小时</option><option value={72}>近 3 天</option>
            <option value={168}>近 7 天</option><option value={720}>近 30 天</option>
          </select>
          <button className="btn" onClick={load}>刷新</button>
        </div>
        <div className="stat-grid">
          <div className="stat"><div className="stat-num">{fmtNum(t.count)}</div><div className="stat-label">请求数</div></div>
          <div className="stat"><div className="stat-num">{fmtNum(t.ok_count)}</div><div className="stat-label">成功数</div></div>
          <div className="stat"><div className="stat-num">{fmtNum(t.prompt_tokens)}</div><div className="stat-label">输入 tokens</div></div>
          <div className="stat"><div className="stat-num">{fmtNum(t.completion_tokens)}</div><div className="stat-label">输出 tokens</div></div>
          <div className="stat"><div className="stat-num">{fmtNum(t.total_tokens)}</div><div className="stat-label">总 tokens</div></div>
          <div className="stat"><div className="stat-num">{t.credit.toFixed(2)}</div><div className="stat-label">积分消耗</div></div>
        </div>
      </div>
      <div className="card">
        <div className="card-title">按模型</div>
        <table className="tbl">
          <thead><tr><th>模型</th><th>请求</th><th>tokens</th><th>积分</th></tr></thead>
          <tbody>{u.by_model.map((m) => (
            <tr key={m.model}><td>{m.model}</td><td>{fmtNum(m.n)}</td>
              <td>{fmtNum(m.tokens)}</td><td>{m.credit.toFixed(2)}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <div className="card">
        <div className="card-title">按账号</div>
        <table className="tbl">
          <thead><tr><th>账号</th><th>请求</th><th>tokens</th><th>积分</th></tr></thead>
          <tbody>{u.by_account.map((a) => (
            <tr key={a.uid}><td>{a.nickname || a.uid}<div className="dim mono">{a.uid}</div></td>
              <td>{fmtNum(a.n)}</td><td>{fmtNum(a.tokens)}</td><td>{a.credit.toFixed(2)}</td></tr>
          ))}</tbody>
        </table>
      </div>
    </>
  );
}
