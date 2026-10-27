"use client";
// 供应商与密钥视图（对齐 Go view-gateway：密钥环 + 聚合供应商合一页）。
import React, { useCallback, useEffect, useState } from "react";
import { req, useAutoRefresh, usePanelRefresh, emitPanelRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";

interface KeyRow { name: string; key_mask: string; providers: string[]; created_at: string }
interface ProviderRow { name: string; base_url: string; key_mask: string; models: string; created_at: string }

export function GatewayView({ flash }: { flash: Flash }) {
  return (
    <>
      <KeysBox flash={flash} />
      <ProvidersBox flash={flash} />
    </>
  );
}

function KeysBox({ flash }: { flash: Flash }) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [name, setName] = useState("");
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  // 可授权的供应商名列表（来自「聚合供应商」）。
  const [providers, setProviders] = useState<string[]>([]);
  // 授权编辑器：all = 全部供应商；picked = 勾选的白名单；password = 超级密码。
  const [authEditor, setAuthEditor] = useState<{
    name: string; all: boolean; picked: string[]; password: string;
  } | null>(null);

  const load = useCallback(() => {
    req<{ keys: KeyRow[] }>("keys").then((r) => setKeys(r.keys))
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
    req<{ providers: { name: string }[] }>("providers")
      .then((r) => setProviders(r.providers.map((p) => p.name)))
      .catch(() => undefined);
  }, [flash]);
  useEffect(load, [load]);
  useAutoRefresh(load, 30_000);
  usePanelRefresh(load);

  const create = async () => {
    try {
      const r = await req<{ name: string; key: string }>("keys", { method: "POST", body: { name } });
      setCreated(r); setName(""); load();
      flash("ok", "密钥已创建，请立即复制保存（仅显示一次）");
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };
  const remove = async (n: string) => {
    if (!window.confirm("确认删除密钥 " + n + "？")) return;
    try { await req("keys/" + encodeURIComponent(n), { method: "DELETE" }); load(); flash("ok", "密钥已吊销"); }
    catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };
  const openAuth = (k: KeyRow) => {
    setAuthEditor({
      name: k.name,
      // 只有显式 "*" 才预勾「全部供应商」；空授权保持未勾选状态，
      // 直接保存仍是空授权（不授权任何供应商），不会被改写为 "*"。
      all: k.providers.includes("*"),
      picked: k.providers.filter((p) => p !== "*"),
      password: "",
    });
  };
  const toggleAuthProvider = (n: string) => {
    setAuthEditor((cur) => {
      if (!cur) return cur;
      const picked = cur.picked.includes(n)
        ? cur.picked.filter((x) => x !== n)
        : [...cur.picked, n];
      return { ...cur, picked };
    });
  };
  const saveAuth = async () => {
    if (!authEditor) return;
    try {
      await req("keys/" + encodeURIComponent(authEditor.name), {
        method: "PATCH",
        body: {
          super_password: authEditor.password,
          providers: authEditor.all ? ["*"] : authEditor.picked,
        },
      });
      setAuthEditor(null);
      load();
      flash("ok", "供应商授权已更新");
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };
  const authLabel = (k: KeyRow) =>
    k.providers.includes("*")
      ? "全部供应商"
      : k.providers.length > 0
        ? k.providers.join(", ")
        : "未授权（无供应商）";

  return (
    <Box title="网关密钥环" hint="可调用 /api/v1/* 的子密钥；新建默认无供应商授权，勾选后仅可调用已授权供应商（池通道不受限）">
      <div className="pad">
        {created && (
          <div className="msg ok">新密钥 {created.name}：<span className="mono">{created.key}</span>（仅显示一次，请立即保存；默认无供应商授权，如需调用聚合供应商请在下方「授权」中勾选）</div>
        )}
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <input className="input" style={{ width: 220 }} placeholder="密钥名称"
            value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" onClick={create} disabled={!name.trim()}>新建密钥</button>
        </div>
        <div className="tbl-wrap">
          <table className="tbl tbl-gateway">
            <thead><tr><th>名称</th><th>掩码</th><th>供应商授权</th><th>创建时间</th><th></th></tr></thead>
            <tbody>
              {(keys ?? []).map((k) => (
                <tr key={k.name}>
                  <td>{k.name}</td><td className="mono">{k.key_mask}</td>
                  <td>{authLabel(k)}</td>
                  <td className="dim">{new Date(k.created_at).toLocaleString("zh-CN", { hour12: false })}</td>
                  <td>
                    <div className="btn-row">
                      <button className="btn small" onClick={() => openAuth(k)}>授权</button>
                      <button className="btn small danger" onClick={() => remove(k.name)}>删除</button>
                    </div>
                  </td>
                </tr>
              ))}
              {(keys ?? []).length === 0 && <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 20 }}>暂无密钥</td></tr>}
            </tbody>
          </table>
        </div>
        {authEditor && (
          <div style={{ marginTop: 12, padding: 12, border: "1px solid rgba(128,128,128,.35)", borderRadius: 8 }}>
            <div style={{ marginBottom: 8 }}>供应商授权：<b>{authEditor.name}</b></div>
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", marginRight: 16 }}>
              <input type="checkbox" checked={authEditor.all}
                onChange={(e) => setAuthEditor({ ...authEditor, all: e.target.checked })} />
              全部供应商
            </label>
            {!authEditor.all && (
              <span className="dim">不勾选 = 不授权任何供应商（该 key 将无法调用聚合供应商）</span>
            )}
            {!authEditor.all && providers.length === 0 && (
              <span className="dim">暂无可授权供应商，请先在下方添加</span>
            )}
            {!authEditor.all && providers.length > 0 && (
              <div className="probe-models" style={{ marginTop: 8 }}>
                {providers.map((p) => (
                  <label key={p}>
                    <input type="checkbox" checked={authEditor.picked.includes(p)}
                      onChange={() => toggleAuthProvider(p)} />
                    <span title={p}>{p}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="btn-row" style={{ marginTop: 10 }}>
              <input className="input" type="password" style={{ width: 200 }} placeholder="超级密码"
                value={authEditor.password}
                onChange={(e) => setAuthEditor({ ...authEditor, password: e.target.value })} />
              <button className="btn primary" onClick={saveAuth} disabled={!authEditor.password}>保存授权</button>
              <button className="btn" onClick={() => setAuthEditor(null)}>取消</button>
            </div>
          </div>
        )}
      </div>
    </Box>
  );
}

function ProvidersBox({ flash }: { flash: Flash }) {
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [form, setForm] = useState({ name: "", base_url: "", key: "", models: "" });
  const [probe, setProbe] = useState("");
  const [probeErr, setProbeErr] = useState(false);
  const [probeModels, setProbeModels] = useState<string[]>([]);

  const load = useCallback(() => {
    req<{ providers: ProviderRow[] }>("providers").then((r) => setRows(r.providers))
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [flash]);
  useEffect(load, [load]);
  useAutoRefresh(load, 30_000);
  usePanelRefresh(load);

  const create = async () => {
    try {
      await req("providers", { method: "POST", body: form });
      setForm({ name: "", base_url: "", key: "", models: "" });
      // 广播刷新：已挂载的「模型与档位」视图立即重载，不必等 120s 轮询。
      emitPanelRefresh();
      flash("ok", "供应商已添加");
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };
  const remove = async (n: string) => {
    // 删除供应商为权限级操作：与密钥授权同口径，超级密码二次确认。
    // 服务端会同事务从所有密钥授权里剔除该供应商名，避免幽灵授权。
    const password = window.prompt("删除供应商 " + n + " 需输入超级密码：");
    if (password === null) return;
    if (!password) { flash("err", "超级密码不能为空"); return; }
    try {
      await req("providers/" + encodeURIComponent(n), { method: "DELETE", body: { super_password: password } });
      emitPanelRefresh();
      flash("ok", "供应商已删除");
    }
    catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };
  const [probing, setProbing] = useState(false);
  const probeNow = async () => {
    setProbing(true);
    setProbe("探测中…");
    setProbeErr(false);
    try {
      const r = await req<{ models?: string[]; ok_count?: number; message?: string }>("providers/probe", { method: "POST", body: { base_url: form.base_url, key: form.key } });
      const models = r.models ?? [];
      setProbeModels(models);
      setProbe(models.length > 0 ? models.length + " 个模型" : "上游返回 0 个模型");
    } catch (e) {
      setProbeErr(true);
      setProbeModels([]);
      setProbe(e instanceof Error ? e.message : String(e));
    }
    finally { setProbing(false); }
  };

  const picked = form.models.split(",").map((s) => s.trim()).filter(Boolean);
  const toggleModel = (m: string) => {
    const next = picked.includes(m) ? picked.filter((x) => x !== m) : [...picked, m];
    setForm({ ...form, models: next.join(", ") });
  };

  // 模型白名单编辑器：编辑已有供应商的暴露模型集合（PATCH 落库，名称不可改）。
  // editor.name 记录目标供应商；models 为逗号分隔原文；probeModels 供勾选。
  const [editor, setEditor] = useState<{ name: string; models: string } | null>(null);
  const [editorProbe, setEditorProbe] = useState("");
  const [editorProbeErr, setEditorProbeErr] = useState(false);
  const [editorProbeModels, setEditorProbeModels] = useState<string[]>([]);
  const [editorProbing, setEditorProbing] = useState(false);
  const editorPicked = editor ? editor.models.split(",").map((s) => s.trim()).filter(Boolean) : [];

  const openEditor = (p: ProviderRow) => {
    setEditor({ name: p.name, models: p.models ?? "" });
    setEditorProbe("");
    setEditorProbeErr(false);
    setEditorProbeModels([]);
  };
  const editorToggle = (m: string) => {
    if (!editor) return;
    const next = editorPicked.includes(m) ? editorPicked.filter((x) => x !== m) : [...editorPicked, m];
    setEditor({ ...editor, models: next.join(", ") });
  };
  // 编辑探测用供应商当前 base_url + 已存 key 走服务端代理（前端拿不到原文 key，
  // 由 PATCH 前的 GET /providers/{name}/probe-models 接口代发，见下方接口）。
  const editorProbeNow = async () => {
    if (!editor) return;
    setEditorProbing(true);
    setEditorProbe("探测中…");
    setEditorProbeErr(false);
    try {
      const r = await req<{ models?: string[] }>("providers/" + encodeURIComponent(editor.name) + "/probe-models", { method: "POST" });
      const models = r.models ?? [];
      setEditorProbeModels(models);
      setEditorProbe(models.length > 0 ? models.length + " 个模型" : "上游返回 0 个模型");
    } catch (e) {
      setEditorProbeErr(true);
      setEditorProbeModels([]);
      setEditorProbe(e instanceof Error ? e.message : String(e));
    } finally { setEditorProbing(false); }
  };
  const saveEditor = async () => {
    if (!editor) return;
    try {
      await req("providers/" + encodeURIComponent(editor.name), { method: "PATCH", body: { models: editor.models } });
      setEditor(null);
      emitPanelRefresh();
      load();
      flash("ok", "供应商 " + editor.name + " 的模型白名单已更新");
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };

  return (
    <Box title="聚合供应商" hint="OpenAI 兼容上游，模型以「供应商名:模型」暴露">
      <div className="pad">
        <div className="form-grid" style={{ marginBottom: 10 }}>
          <div className="form-row"><label className="form-label">名称</label>
            <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="form-row"><label className="form-label">Base URL</label>
            <input className="input" placeholder="https://api.example.com/v1" value={form.base_url}
              onChange={(e) => setForm({ ...form, base_url: e.target.value })} /></div>
          <div className="form-row"><label className="form-label">API Key</label>
            <input className="input" type="password" value={form.key}
              onChange={(e) => setForm({ ...form, key: e.target.value })} /></div>
          <div className="form-row"><label className="form-label">模型白名单（逗号分隔，空=全部）</label>
            <input className="input" placeholder="留空 = 暴露上游全部模型" value={form.models}
              onChange={(e) => setForm({ ...form, models: e.target.value })} /></div>
        </div>
        <div className="btn-row">
          <button className="btn primary" onClick={create} disabled={!form.name || !form.base_url || !form.key}>添加供应商</button>
          <button className="btn" onClick={probeNow} disabled={!form.base_url || !form.key || probing}>
            {probing ? "探测中…" : "获取模型列表"}
          </button>
          {probe && <span className={probeErr ? "" : "dim"} style={{ alignSelf: "center", ...(probeErr ? { color: "var(--err)", fontSize: 12 } : {}) }}>{probe}</span>}
        </div>
        {probeModels.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div className="btn-row" style={{ marginBottom: 6 }}>
              <button className="btn xs" onClick={() => setForm({ ...form, models: probeModels.join(", ") })}>全选</button>
              <button className="btn xs" onClick={() => setForm({ ...form, models: "" })}>清空勾选</button>
              <button className="btn xs" onClick={() => { void navigator.clipboard.writeText(probeModels.join(",")).then(() => flash("ok", "名单已复制")); }}>复制名单</button>
            </div>
            <div className="probe-models">
              {probeModels.map((m) => (
                <label key={m}>
                  <input type="checkbox" checked={picked.includes(m)} onChange={() => toggleModel(m)} />
                  <span title={m}>{m}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="tbl-wrap" style={{ marginTop: 14 }}>
          <table className="tbl tbl-gateway">
            <thead><tr><th>名称</th><th>Base URL</th><th>Key 掩码</th><th>模型白名单</th><th></th></tr></thead>
            <tbody>
              {(rows ?? []).map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td><td className="mono">{p.base_url}</td><td className="mono">{p.key_mask}</td>
                  <td className="dim" style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                    title={p.models || "全部"}>{p.models ? p.models.split(",").length + " 个：" + p.models : "全部"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button className="btn small" onClick={() => openEditor(p)}>修改模型</button>{" "}
                    <button className="btn small danger" onClick={() => remove(p.name)}>删除</button>
                  </td>
                </tr>
              ))}
              {(rows ?? []).length === 0 && <tr><td colSpan={5} className="dim" style={{ textAlign: "center", padding: 20 }}>暂无供应商</td></tr>}
            </tbody>
          </table>
        </div>
        {editor && (
          <div style={{ marginTop: 12, padding: 12, border: "1px solid rgba(128,128,128,.35)", borderRadius: 8 }}>
            <div style={{ marginBottom: 8 }}>
              修改 <b>{editor.name}</b> 的模型白名单：<span className="dim">留空 = 暴露上游全部模型</span>
            </div>
            <div className="form-row" style={{ marginBottom: 8 }}>
              <input className="input" placeholder="留空 = 全部模型；逗号分隔 = 只暴露白名单"
                value={editor.models}
                onChange={(e) => setEditor({ ...editor, models: e.target.value })} />
            </div>
            <div className="btn-row" style={{ marginBottom: editorProbeModels.length ? 8 : 0 }}>
              <button className="btn" onClick={editorProbeNow} disabled={editorProbing}>
                {editorProbing ? "探测中…" : "获取上游模型列表"}
              </button>
              {editorProbeModels.length > 0 && (<>
                <button className="btn xs" onClick={() => setEditor({ ...editor, models: editorProbeModels.join(", ") })}>全选</button>
                <button className="btn xs" onClick={() => setEditor({ ...editor, models: "" })}>清空勾选</button>
              </>)}
              {editorProbe && <span className={editorProbeErr ? "" : "dim"} style={{ alignSelf: "center", ...(editorProbeErr ? { color: "var(--err)", fontSize: 12 } : {}) }}>{editorProbe}</span>}
            </div>
            {editorProbeModels.length > 0 && (
              <div className="probe-models" style={{ marginBottom: 8 }}>
                {editorProbeModels.map((m) => (
                  <label key={m}>
                    <input type="checkbox" checked={editorPicked.includes(m)} onChange={() => editorToggle(m)} />
                    <span title={m}>{m}</span>
                  </label>
                ))}
              </div>
            )}
            <div className="btn-row">
              <button className="btn primary" onClick={saveEditor}>保存</button>
              <button className="btn" onClick={() => setEditor(null)}>取消</button>
            </div>
          </div>
        )}
      </div>
    </Box>
  );
}
