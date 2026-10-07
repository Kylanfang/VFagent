import React, { useMemo, useState, useCallback, useEffect } from "react";
import { reloadMcp, probeMcp, mcpInstall, mcpUninstall, mcpDefinition, mcpProposals, mcpProposalApprove, mcpProposalReject } from "../lib/api.js";
import { StatusRing } from "./ui.jsx";

/** 停用草稿的「补密钥并启用」表单（仅主控）：需密钥的目录条目批准后先落盘为停用，在此填 env 后启用 */
function DraftEnable({ server, onDone, onError }) {
  const [def, setDef] = useState(null);
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    mcpDefinition(server.id)
      .then((d) => { if (live) setDef(d); })
      .catch((e) => { if (live) onError(String(e?.message ?? e)); });
    return () => { live = false; };
  }, [server.id]);
  if (def == null) return <div style={{ fontSize: 12, color: "var(--sub)" }}>读取配置中…</div>;
  const envKeys = Object.keys(def.env ?? {});
  const enable = async () => {
    setBusy(true);
    try {
      const env = { ...(def.env ?? {}) };
      for (const [k, v] of Object.entries(values)) {
        if (String(v).trim() !== "") env[k] = String(v).trim();
      }
      await mcpInstall({ ...def, env, enabled: true, draft: false });
      onDone(`${def.name ?? def.id} 已启用`);
    } catch (e) { onError(String(e?.message ?? e)); }
    setBusy(false);
  };
  return (
    <div style={{ margin: "6px 0", padding: "8px 10px", border: "1px dashed var(--line,#d8d2c8)", borderRadius: 8, fontSize: 12 }}>
      <div style={{ marginBottom: 6, color: "#b06018" }}>⏸ 停用草稿{envKeys.length > 0 ? "：填写密钥后启用" : ""}</div>
      {envKeys.map((k) => (
        <label key={k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontFamily: "var(--mono)", minWidth: 120 }}>{k}</span>
          <input
            type="password"
            autoComplete="off"
            placeholder={String(def.env?.[k] ?? "").startsWith("env:") ? "引用系统环境变量（可直接留空）" : "填写值"}
            value={values[k] ?? ""}
            onChange={(e) => setValues({ ...values, [k]: e.target.value })}
            style={{ flex: 1 }}
          />
        </label>
      ))}
      <button className="ghost-btn tiny" disabled={busy} onClick={enable}>{busy ? "启用中…" : "保存并启用"}</button>
    </div>
  );
}

/** 添加 MCP Server 表单（仅主控）：stdio（command/args/env）或 http（url/headers） */
function AddServerForm({ onDone, onError }) {
  const [transport, setTransport] = useState("stdio");
  const [f, setF] = useState({ id: "", name: "", command: "node", args: "", env: "", url: "", headers: "" });
  const [busy, setBusy] = useState(false);
  const parseKV = (text, sep) => Object.fromEntries(
    text.split("\n").map((l) => l.trim()).filter((l) => l.includes(sep)).map((l) => [l.slice(0, l.indexOf(sep)).trim(), l.slice(l.indexOf(sep) + sep.length).trim()])
  );
  const submit = async () => {
    const id = f.id.trim().toLowerCase().replace(/\s+/g, "-");
    if (id === "") { onError("Server ID 必填"); return; }
    const definition = { id, name: f.name.trim() || id, enabled: true, transport };
    if (transport === "stdio") {
      definition.command = f.command.trim();
      definition.args = f.args.split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean);
      definition.env = parseKV(f.env, "=");
    } else {
      definition.url = f.url.trim();
      definition.headers = parseKV(f.headers, ":");
    }
    setBusy(true);
    try { await mcpInstall(definition); onDone(`已添加并连接 ${id}`); }
    catch (e) { onError(String(e?.message ?? e)); }
    setBusy(false);
  };
  return (
    <section className="card" style={{ marginBottom: 14 }}>
      <h3>添加 MCP Server <small className="dim">（主控专用 · stdio 随引擎本地运行 / http 连远程服务）</small></h3>
      <div className="seg" style={{ marginBottom: 10 }}>
        <button className={transport === "stdio" ? "on" : ""} onClick={() => setTransport("stdio")}>stdio（本地进程）</button>
        <button className={transport === "http" ? "on" : ""} onClick={() => setTransport("http")}>http（远程）</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
        <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>Server ID *<input value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} placeholder="如 my-tools" /></label>
        <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>名称<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="显示名称" /></label>
        {transport === "stdio" ? (
          <>
            <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>Command（node = 引擎自带运行时）<input value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder="node / npx.cmd" /></label>
            <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>环境变量（每行 KEY=VALUE）<input value={f.env} onChange={(e) => setF({ ...f, env: e.target.value })} placeholder="TUSHARE_TOKEN=xxx" /></label>
            <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>参数（每行一个，支持占位符 APP 与 WORKSPACE）<textarea rows={2} value={f.args} onChange={(e) => setF({ ...f, args: e.target.value })} style={{ fontFamily: "var(--mono)" }} /></label>
          </>
        ) : (
          <>
            <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>URL *<input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://example.com/mcp" /></label>
            <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4, gridColumn: "1 / -1" }}>Headers（每行 KEY: VALUE）<textarea rows={2} value={f.headers} onChange={(e) => setF({ ...f, headers: e.target.value })} style={{ fontFamily: "var(--mono)" }} /></label>
          </>
        )}
      </div>
      <div style={{ marginTop: 10 }}>
        <button className="ghost-btn" onClick={submit} disabled={busy || f.id.trim() === ""}>{busy ? "连接中…" : "添加并连接"}</button>
      </div>
    </section>
  );
}

const SEV_LABEL = { error: "错误", warning: "警告", info: "提示" };
const DISMISS_KEY = "vfletch.dismissedAlerts";

function readDismissed() {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function writeDismissed(set) {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...set].slice(-50)));
  } catch {
    /* localStorage 不可用时仅本次会话内生效 */
  }
}

/** 告警签名：内容变了就重新提醒，内容没变且已关闭则不再打扰 */
function signatureOf(list) {
  return list
    .map((c) => `${c.severity}|${c.message}`)
    .join("\n")
    .replace(/\s+/g, " ");
}

function simpleHash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) {
    h = (h * 31 + text.charCodeAt(i)) | 0;
  }
  return `a${(h >>> 0).toString(36)}`;
}

export default function McpView({ mcp, onRefresh, user }) {
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set());
  const [showDiag, setShowDiag] = useState(true);
  const [probing, setProbing] = useState(null);
  const [probeResults, setProbeResults] = useState({});
  const isBoss = user?.role === "boss";
  // 安装提案（发现→审批→安装 的人工闸门）：主控在此批准/驳回
  const [proposals, setProposals] = useState([]);
  const loadProposals = useCallback(async () => {
    if (!isBoss) return;
    try { const r = await mcpProposals(); setProposals(r?.proposals ?? []); } catch { setProposals([]); }
  }, [isBoss]);
  // 已关闭的告警签名（持久化）；内容变化会生成新签名，届时会再次提醒
  const [dismissed, setDismissed] = useState(readDismissed);
  const [showAdd, setShowAdd] = useState(false);
  const [flash, setFlash] = useState("");
  const notify = (m) => { setFlash(m); setTimeout(() => setFlash(""), 3500); };

  const servers = mcp?.servers ?? [];
  const connected = servers.filter((s) => s.status === "connected");
  const totalTools = mcp?.toolCount ?? 0;
  const conflicts = mcp?.conflicts ?? [];
  const errors = conflicts.filter((c) => c.severity === "error");
  const warns = conflicts.filter((c) => c.severity === "warning");

  const alertSig = useMemo(() => simpleHash(signatureOf(errors)), [errors]);
  const alertVisible = errors.length > 0 && !dismissed.has(alertSig);

  const dismissAlert = () => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(alertSig);
      writeDismissed(next);
      return next;
    });
  };

  useEffect(() => { loadProposals(); }, [loadProposals]);

  const testServer = async (server) => {
    setProbing(server.id);
    setProbeResults((prev) => ({ ...prev, [server.id]: { busy: true } }));
    try {
      const result = await probeMcp({ url: server.url, headers: server.headers ?? {} });
      setProbeResults((prev) => ({ ...prev, [server.id]: result }));
    } catch (error) {
      setProbeResults((prev) => ({ ...prev, [server.id]: { ok: false, error: String(error?.message ?? error) } }));
    } finally {
      setProbing(null);
    }
  };

  const reload = async () => {
    setBusy(true);
    try {
      await reloadMcp();
      await onRefresh();
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 点击 MCP 卡片即视为"我看到了"，同步 dismiss 顶部红色告警。
  // 这样即使用户没注意到那个小 ×，展开任意一个 server 卡也能立刻收掉冒泡。
  const handleCardInteract = (id) => {
    toggle(id);
    if (alertVisible) dismissAlert();
  };

  return (
    <div className="view-pad">
      <header className="view-head">
        <h2 className="view-title">MCP 中心</h2>
        <button className="ghost-btn" onClick={reload} disabled={busy}>
          {busy ? "刷新中…" : "重新扫描"}
        </button>
      </header>

      <div className="mcp-hero">
        <StatusRing value={connected.length} total={servers.length} label="服务在线" size={130} />
        <div className="hero-facts">
          <div className="fact">
            <span className="fact-num">{totalTools}</span>
            <span className="fact-label">可用工具</span>
          </div>
          <div className="fact">
            <span className={`fact-num ${errors.length > 0 ? "bad" : "ok"}`}>{errors.length}</span>
            <span className="fact-label">错误</span>
          </div>
          <div className="fact">
            <span className="fact-num">{warns.length}</span>
            <span className="fact-label">警告</span>
          </div>
        </div>
      </div>

      {isBoss ? (
        <div style={{ marginBottom: 12 }}>
          {flash ? <div className="notice" style={{ marginBottom: 10 }}>{flash}</div> : null}
          {!showAdd ? (
            <button className="ghost-btn" onClick={() => setShowAdd(true)}>+ 添加 MCP Server</button>
          ) : (
            <AddServerForm onDone={(m) => { notify(m); setShowAdd(false); onRefresh?.(); }} onError={notify} />
          )}
        </div>
      ) : null}

      {alertVisible && (
        <div className="alert-band">
          <button className="alert-close" onClick={dismissAlert} title="关闭此提醒" aria-label="关闭">×</button>
          {errors.slice(0, 3).map((c, i) => (
            <div key={i} className="alert-line">⚠ {c.message}</div>
          ))}
          {errors.length > 3 ? <div className="alert-line dim">…另有 {errors.length - 3} 条，见下方诊断详情</div> : null}
        </div>
      )}

      <div className="server-grid">
        {servers.map((s) => {
          const isOpen = expanded.has(s.id);
          const ok = s.status === "connected";
          return (
            <section key={s.id} className={`server-card ${ok ? "" : "down"}`}>
              <div className="server-top" onClick={() => handleCardInteract(s.id)}>
                <span className={`dot ${ok ? "ok" : s.status === "connecting" ? "wait" : "bad"}`} />
                <div className="server-name">
                  <strong>{s.name}</strong>
                  <small>{s.transport}{s.command ? ` · ${s.command}` : ""}{s.url ? ` · ${s.url.replace(/^https?:\/\//, "").slice(0, 28)}` : ""}</small>
                </div>
                <div className="server-count">
                  {ok ? <>{s.toolCount} 工具</> : s.status === "disabled" ? "已停用" : "离线"}
                  {s.toolCount > 0 ? <span className="chev">{isOpen ? "▾" : "▸"}</span> : null}
                </div>
              </div>
              {s.error ? <div className="server-err">{s.error}</div> : null}
              {isBoss && s.status === "disabled" ? (
                <DraftEnable server={s} onDone={async (m) => { notify(m); await onRefresh?.(); }} onError={notify} />
              ) : null}
              {isBoss && s.transport === "stdio" ? (
                <div style={{ margin: "4px 0" }}>
                  <button
                    className="ghost-btn tiny"
                    style={{ color: "#b3372c" }}
                    onClick={async () => {
                      if (!window.confirm(`移除 MCP Server「${s.id}」？`)) return;
                      try { await mcpUninstall(s.id); notify(`已移除 ${s.id}`); await onRefresh?.(); } catch (e) { notify(String(e?.message ?? e)); }
                    }}
                  >移除</button>
                </div>
              ) : null}
              {s.transport === "http" && s.url ? (
                <div className="server-probe">
                  <button className="ghost-btn tiny" disabled={probing === s.id} onClick={() => testServer(s)}>
                    {probing === s.id ? "检测中…" : "检测连通性"}
                  </button>
                  {probeResults[s.id]?.busy ? null : probeResults[s.id] ? (
                    <span className={`probe-result ${probeResults[s.id].ok ? "ok" : "bad"}`}>
                      {probeResults[s.id].ok
                        ? `✓ 可达 · ${probeResults[s.id].latencyMs}ms` +
                          (probeResults[s.id].serverInfo ? ` · ${probeResults[s.id].serverInfo.name ?? ""}` : "")
                        : `✗ ${probeResults[s.id].error ?? "未知错误"}`}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {isOpen && (
                <div className="tool-grid">
                  {s.tools.map((t) => (
                    <div key={t.exposedName} className="tool-tile" title={t.description ?? ""}>
                      <div className="tile-name">{t.originalName}</div>
                      <div className="tile-sub">{t.exposedName}</div>
                    </div>
                  ))}
                  {s.tools.length === 0 ? <div className="tile-sub">无工具</div> : null}
                </div>
              )}
            </section>
          );
        })}
        {servers.length === 0 ? <div className="chart-empty">尚未配置任何 MCP server</div> : null}
      </div>

      {isBoss && proposals.length > 0 && (
        <div className="alert-panel" style={{ borderColor: "#f0a020" }}>
          <div className="alert-title">📥 安装提案待审批（{proposals.filter((p) => p.status === "pending").length}）<button className="ghost-btn tiny" style={{ marginLeft: "auto" }} onClick={() => { setProposals([]); }}>收起</button></div>
          {proposals.filter((p) => p.status === "pending").map((p) => (
            <div key={p.id} className="conflict-row" style={{ alignItems: "flex-start" }}>
              <span className="pill" style={{ color: "#f0a020" }}>待审批</span>
              <div className="conflict-msg">
                <strong>{p.spec?.name ?? p.catalog_id}</strong> · 申请人 {p.requested_by}
                <div style={{ fontSize: 12, color: "var(--sub)", marginTop: 2 }}>理由：{p.reason || "（未填写）"}</div>
                <div style={{ fontSize: 11, color: "var(--sub)" }}>安装方式：{p.spec?.command} {(p.spec?.args ?? []).join(" ")}{p.spec?.env && Object.keys(p.spec.env).length > 0 ? ` · 需环境变量：${Object.keys(p.spec.env).join(", ")}` : ""}</div>
              </div>
              <span style={{ whiteSpace: "nowrap" }}>
                <button className="ghost-btn tiny" onClick={async () => { try { const r = await mcpProposalApprove(p.id); notify(r?.draft ? `已批准 ${p.spec?.name ?? p.catalog_id}（停用草稿，请在下方卡片填密钥后启用）` : `已批准并安装 ${p.spec?.name ?? p.catalog_id}`); await Promise.all([onRefresh?.(), loadProposals()]); } catch (e) { notify(String(e?.message ?? e)); } }}>批准并安装</button>{" "}
                <button className="ghost-btn tiny" onClick={async () => { try { await mcpProposalReject(p.id); notify("已驳回"); await loadProposals(); } catch (e) { notify(String(e?.message ?? e)); } }}>驳回</button>
              </span>
            </div>
          ))}
        </div>
      )}
      {conflicts.length > 0 && (
        <section className="card">
          <h3 className="card-head-toggle" onClick={() => setShowDiag((v) => !v)} style={{ cursor: "pointer" }}>
            诊断详情
            <span className="chev" style={{ marginLeft: 8 }}>{showDiag ? "▾" : "▸"}</span>
          </h3>
          {showDiag && (
            <div className="conflict-list">
              {conflicts.map((c, i) => (
                <div key={i} className={`conflict-row sev-${c.severity}`}>
                  <span className="pill">{SEV_LABEL[c.severity] ?? c.severity}</span>
                  <span className="conflict-msg">{c.message}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
