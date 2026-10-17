"use client";
// 供应商与密钥视图（对齐 Go view-gateway：密钥环 + 聚合供应商合一页）。
import React, { useCallback, useEffect, useState } from "react";
import { req, useAutoRefresh } from "../lib";
import { Box, type Flash } from "../components/ui";

interface KeyRow { name: string; key_mask: string; created_at: string }
interface ProviderRow { name: string; base_url: string; key_mask: string; created_at: string }

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

  const load = useCallback(() => {
    req<{ keys: KeyRow[] }>("keys").then((r) => setKeys(r.keys))
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [flash]);
  useEffect(load, [load]);
  useAutoRefresh(load, 30_000);

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

  return (
    <Box title="网关密钥环" hint="可调用 /api/v1/* 的子密钥，用于分发给他人">
      <div className="pad">
        {created && (
          <div className="msg ok">新密钥 {created.name}：<span className="mono">{created.key}</span>（仅显示一次，请立即保存）</div>
        )}
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <input className="input" style={{ width: 220 }} placeholder="密钥名称"
            value={name} onChange={(e) => setName(e.target.value)} />
          <button className="btn primary" onClick={create} disabled={!name.trim()}>新建密钥</button>
        </div>
        <div className="tbl-wrap">
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
              {(keys ?? []).length === 0 && <tr><td colSpan={4} className="dim" style={{ textAlign: "center", padding: 20 }}>暂无密钥</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Box>
  );
}

function ProvidersBox({ flash }: { flash: Flash }) {
  const [rows, setRows] = useState<ProviderRow[] | null>(null);
  const [form, setForm] = useState({ name: "", base_url: "", key: "", models: "" });
  const [probe, setProbe] = useState("");
  const [probeModels, setProbeModels] = useState<string[]>([]);

  const load = useCallback(() => {
    req<{ providers: ProviderRow[] }>("providers").then((r) => setRows(r.providers))
      .catch((e) => flash("err", e instanceof Error ? e.message : String(e)));
  }, [flash]);
  useEffect(load, [load]);
  useAutoRefresh(load, 30_000);

  const create = async () => {
    try {
      await req("providers", { method: "POST", body: form });
      setForm({ name: "", base_url: "", key: "", models: "" }); load();
      flash("ok", "供应商已添加");
    } catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };
  const remove = async (n: string) => {
    if (!window.confirm("确认删除供应商 " + n + "？")) return;
    try { await req("providers/" + encodeURIComponent(n), { method: "DELETE" }); load(); flash("ok", "供应商已删除"); }
    catch (e) { flash("err", e instanceof Error ? e.message : String(e)); }
  };
  const [probing, setProbing] = useState(false);
  const probeNow = async () => {
    setProbing(true);
    setProbe("探测中…");
    try {
      const r = await req<{ models?: string[]; ok_count?: number; message?: string }>("providers/probe", { method: "POST", body: { base_url: form.base_url, key: form.key } });
      const models = r.models ?? [];
      setProbeModels(models);
      setProbe(models.length + " 个模型");
    } catch (e) { setProbe(e instanceof Error ? e.message : String(e)); }
    finally { setProbing(false); }
  };

  const picked = form.models.split(",").map((s) => s.trim()).filter(Boolean);
  const toggleModel = (m: string) => {
    const next = picked.includes(m) ? picked.filter((x) => x !== m) : [...picked, m];
    setForm({ ...form, models: next.join(", ") });
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
          {probe && <span className="dim" style={{ alignSelf: "center" }}>{probe}</span>}
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
          <table className="tbl">
            <thead><tr><th>名称</th><th>Base URL</th><th>Key 掩码</th><th></th></tr></thead>
            <tbody>
              {(rows ?? []).map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td><td className="mono">{p.base_url}</td><td className="mono">{p.key_mask}</td>
                  <td><button className="btn small danger" onClick={() => remove(p.name)}>删除</button></td>
                </tr>
              ))}
              {(rows ?? []).length === 0 && <tr><td colSpan={4} className="dim" style={{ textAlign: "center", padding: 20 }}>暂无供应商</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </Box>
  );
}
