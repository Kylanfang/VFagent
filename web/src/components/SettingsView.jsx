import React, { useCallback, useEffect, useState } from "react";
import { getSettings, saveProvider, setActiveProvider, deleteProvider, saveMcpServers, getMcp, adminUsers, adminCreateUser, adminSetUserStatus, adminResetPassword, adminSetUserRole, adminShutdown, getMeta } from "../lib/api.js";
import { StatCard, Bars, ShareBars } from "./ui.jsx";

const fmt = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n ?? 0));
// 统计卡片用：数字与"万"拆开，单位统一走小号 unit 槽，避免数字与汉字一大一小
const fmtParts = (n, suffix = "") => {
  const v = Number(n ?? 0);
  return v >= 10000
    ? { value: (v / 10000).toFixed(1), unit: `万${suffix}` }
    : { value: String(v), unit: suffix || undefined };
};

const BLANK = {
  id: "",
  label: "",
  protocol: "openai-compatible",
  model: "",
  baseUrl: "",
  apiKey: "",
  supportsTools: true,
  supportsStream: true,
  contextWindow: "",
  notes: "",
};

export default function SettingsView({ usage, onRefreshUsage, mcp, onRefreshBackend, user }) {
  // 观察员（非主控）视图：GET 不下发 baseUrl/configFile，保存时服务端保留原值——
  // 表单据此放开"Base URL 必填"的保存限制（否则观察员编辑现有 API 时按钮永远禁用，什么都存不了）
  const isBoss = user?.role === "boss";
  const [settings, setSettings] = useState(null);
  const [editing, setEditing] = useState(null); // null | provider 对象（含 isNew）
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [tab, setTab] = useState("models");
  const [selectedId, setSelectedId] = useState(null); // 点选高亮（蓝外框），与“当前激活”解耦
  const [activatingId, setActivatingId] = useState(null); // 正在切换的供应商
  const [flashId, setFlashId] = useState(null); // 刚切换成功的高亮行
  const [users, setUsers] = useState(null); // 账号管理（主控）
  const [newUser, setNewUser] = useState({ username: "", password: "", display_name: "", role: "employee" });

  const loadUsers = useCallback(async () => {
    if (!isBoss) return;
    try { setUsers(await adminUsers()); } catch (e) { setNotice(`账号列表加载失败: ${e?.message ?? e}`); }
  }, [isBoss]);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const createUser = async () => {
    try {
      await adminCreateUser(newUser);
      setNotice(`已创建账号 ${newUser.username}（${newUser.role === "boss" ? "主控" : "员工"}）`);
      setNewUser({ username: "", password: "", display_name: "", role: "employee" });
      await loadUsers();
    } catch (e) { setNotice(String(e?.message ?? e)); }
  };

  const load = useCallback(async () => {
    try {
      const s = await getSettings();
      setSettings(s);
      setSelectedId((prev) => prev ?? s.active ?? null);
    } catch (e) {
      setNotice(`加载失败: ${e?.message ?? e}`);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startNew = () => setEditing({ ...BLANK, isNew: true });
  const startEdit = (p) =>
    setEditing({
      ...BLANK,
      ...p,
      apiKey: "",
      isNew: false,
    });

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setNotice(null);
    try {
      const fields = {
        label: editing.label || editing.id,
        protocol: editing.protocol,
        model: editing.model,
        baseUrl: editing.baseUrl,
        supportsTools: editing.supportsTools,
        supportsStream: editing.supportsStream,
        contextWindow: editing.contextWindow ? Number(editing.contextWindow) : null,
        notes: editing.notes,
      };
      if (editing.apiKey.trim() !== "") fields.apiKey = editing.apiKey.trim();
      // 激活模型是主控专属（观察员白名单不含 /api/settings/active）：观察员保存只改所编条目，不切激活
      const saved = await saveProvider({ id: editing.id, fields, active: isBoss ? true : undefined });
      const savedId = saved?.id ?? editing.id;
      await load();
      onRefreshBackend?.();
      setSelectedId(savedId);
      setNotice(`已保存 ${savedId}${isBoss ? " 并激活" : ""}${saved?.renamedFrom != null ? `（ID 已自动生成）` : ""}`);
      setFlashId(savedId);
      setTimeout(() => setFlashId(null), 900);
      setEditing(null);
    } catch (e) {
      setNotice(`保存失败: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    try {
      await deleteProvider(id);
      await load();
      onRefreshBackend?.();
      setNotice(`已删除 ${id}`);
    } catch (e) {
      setNotice(`删除失败: ${e?.message ?? e}`);
    }
  };

  const activate = async (id) => {
    if (activatingId != null) return;
    setActivatingId(id);
    setSelectedId(id);
    try {
      await setActiveProvider(id);
      await load();
      onRefreshBackend?.();
      setNotice(`已切换到 ${id}`);
      setFlashId(id);
      setTimeout(() => setFlashId(null), 900);
    } catch (e) {
      setNotice(`切换失败: ${e?.message ?? e}`);
    } finally {
      setActivatingId(null);
    }
  };

  const toggleServer = async (serverId) => {
    if (!settings) return;
    const servers = settings.mcpServers.map((s) => (s.id === serverId ? { ...s, enabled: !s.enabled } : s));
    try {
      await saveMcpServers(servers);
      await load();
      onRefreshBackend?.();
      setNotice(`已更新 ${serverId}，重新扫描完成`);
    } catch (e) {
      setNotice(`保存失败: ${e?.message ?? e}`);
    }
  };

  // 内置服务（如记忆库）开关：把 enabled 标志写进 mcp.json 覆盖默认注入
  const toggleBuiltin = async (id) => {
    if (!settings) return;
    const servers = [...(settings.mcpServers ?? [])];
    const live = (mcp?.servers ?? []).find((s) => s.id === id);
    const nextEnabled = live ? live.status === "disabled" : true;
    const entry = { id, builtin: id, name: id, transport: "builtin", args: [], env: {}, enabled: nextEnabled };
    const idx = servers.findIndex((s) => s.id === id);
    if (idx >= 0) servers[idx] = { ...servers[idx], enabled: nextEnabled };
    else servers.push(entry);
    try {
      await saveMcpServers(servers);
      await load();
      onRefreshBackend?.();
      setNotice(`记忆库已${nextEnabled ? "启用" : "停用"}（${nextEnabled ? "检索仍需用户授权" : "模型将无法访问任何记忆工具"}）`);
    } catch (e) {
      setNotice(`保存失败: ${e?.message ?? e}`);
    }
  };

  const u = usage ?? {};
  const dayBars = (u.days ?? []).map((d) => ({ label: d.day.slice(5), value: d.totalTokens }));
  const providerBars = (u.providers ?? []).map((p) => ({ label: `${p.provider}`, value: p.totalTokens }));

  return (
    <div className="view-pad">
      <header className="view-head">
        <h2 className="view-title">设置</h2>
        <div className="seg">
          <button className={tab === "models" ? "on" : ""} onClick={() => setTab("models")}>模型 API</button>
          <button className={tab === "usage" ? "on" : ""} onClick={() => { setTab("usage"); onRefreshUsage?.(); }}>用量</button>
          <button className={tab === "mcp" ? "on" : ""} onClick={() => setTab("mcp")}>MCP 配置</button>
          {isBoss ? <button className={tab === "ops" ? "on" : ""} onClick={() => setTab("ops")}>本机运维</button> : null}
          {isBoss ? <button className={tab === "accounts" ? "on" : ""} onClick={() => setTab("accounts")}>账号</button> : null}
        </div>
      </header>

      {notice ? <div className="notice">{notice}</div> : null}

      {tab === "models" && (
        <div className="settings-split">
          <aside className="settings-list">
            {Object.values(settings?.providers ?? {}).map((p) => (
              <div
                key={p.id}
                className={`provider-row ${settings.active === p.id ? "active" : ""} ${selectedId === p.id ? "selected" : ""} ${flashId === p.id ? "flash" : ""}`}
                onClick={() => { setSelectedId(p.id); startEdit(p); }}
              >
                <button className="provider-btn" onClick={(e) => { e.stopPropagation(); setSelectedId(p.id); startEdit(p); }}>
                  <strong>{p.label || p.id}</strong>
                  <small>{p.model || "未填模型"}{p.hasApiKey ? "" : " · 缺 Key"}</small>
                </button>
                {settings.active === p.id ? <span className="pill pill-ok">当前</span> : (
                  <button
                    className="ghost-btn tiny"
                    disabled={activatingId != null}
                    onClick={(e) => { e.stopPropagation(); activate(p.id); }}
                  >
                    {activatingId === p.id ? "切换中…" : "启用"}
                  </button>
                )}
              </div>
            ))}
            <button className="ghost-btn block" onClick={startNew}>+ 添加模型 API</button>
          </aside>

          <section className="settings-editor">
            {!editing ? (
              Object.keys(settings?.providers ?? {}).length > 0 ? (
                <div className="chart-empty">
                  ← 从左侧选择一个模型 API 查看或编辑；当前默认使用「{settings?.providers?.[settings?.active]?.label ?? settings?.active ?? "未设置"}」。<br />
                  也可点击左下角「+ 添加模型 API」接入新的模型。
                </div>
              ) : (
                <div className="chart-empty">
                  尚未接入任何模型 API —— 当前仅有内置「VF 前台助手」负责接待问答。<br />
                  点击左下角「+ 添加模型 API」接入真实模型（DeepSeek / Qwen / 本地 vLLM 等），
                  保存后系统会自动生成对应的 AI 员工，即可正式办公与委派任务。
                </div>
              )
            ) : (
              <div className="form" key={editing.isNew ? "new" : editing.id}>
                <h3>{editing.isNew ? "添加模型 API" : `编辑 ${editing.id}`}</h3>
                {editing.isNew ? (
                  <label>ID <small className="dim">（可留空，自动生成；仅字母数字）</small><input value={editing.id} onChange={(e) => setEditing({ ...editing, id: e.target.value.trim() })} placeholder="留空自动生成，或填 openrouter / local" /></label>
                ) : null}
                <label>显示名称<input value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} /></label>
                <label>Base URL{!editing.isNew && !isBoss ? <small className="dim">（已由主控隐藏：编辑时保留原值）</small> : null}<input value={editing.baseUrl} onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })} disabled={!editing.isNew && !isBoss} placeholder={!editing.isNew && !isBoss ? "已由主控隐藏 · 保存将保留原值" : "https://.../v1（OpenAI 兼容）"} /></label>
                <label>模型 ID<input value={editing.model} onChange={(e) => setEditing({ ...editing, model: e.target.value })} placeholder="如 gpt-4o / deepseek-chat" /></label>
                <label>API Key<input type="password" value={editing.apiKey} onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })} placeholder={editing.isNew ? "sk-... 或 env:VAR_NAME" : "留空 = 不修改"} /></label>
                <div className="form-row2">
                  <label>协议
                    <select value={editing.protocol} onChange={(e) => setEditing({ ...editing, protocol: e.target.value })}>
                      <option value="openai-compatible">OpenAI 兼容</option>
                      <option value="custom">自定义适配器</option>
                    </select>
                  </label>
                  <label>上下文窗口<input value={editing.contextWindow ?? ""} onChange={(e) => setEditing({ ...editing, contextWindow: e.target.value })} placeholder="如 128000" /></label>
                </div>
                <div className="form-checks">
                  <label><input type="checkbox" checked={editing.supportsTools} onChange={(e) => setEditing({ ...editing, supportsTools: e.target.checked })} /> 支持 Function Calling</label>
                  <label><input type="checkbox" checked={editing.supportsStream} onChange={(e) => setEditing({ ...editing, supportsStream: e.target.checked })} /> 支持流式</label>
                </div>
                <div className="form-actions">
                  <button className="primary" onClick={save} disabled={saving || !editing.model || ((editing.isNew || isBoss) && !editing.baseUrl)}>
                    {saving ? "保存中…" : isBoss ? "保存并启用" : "保存"}
                  </button>
                  <button className="ghost-btn" onClick={() => setEditing(null)}>取消</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {tab === "usage" && (
        <div className="usage-view">
          <div className="kpi-row">
            <StatCard label="总调用" {...fmtParts(u.totals?.records, "次")} />
            <StatCard label="输入 tokens" {...fmtParts(u.totals?.promptTokens)} tone="default" />
            <StatCard label="输出 tokens" {...fmtParts(u.totals?.completionTokens)} tone="ok" />
            <StatCard label="总 tokens" {...fmtParts(u.totals?.totalTokens)} tone="warn" hint="无真实 usage 时按字符数估算" />
          </div>
          <section className="card">
            <h3>近 30 天用量</h3>
            <Bars data={dayBars} height={140} format={fmt} />
          </section>
          <section className="card">
            <h3>按供应商分布</h3>
            <ShareBars items={providerBars} format={fmt} />
          </section>
        </div>
      )}

      {tab === "mcp" && (
        <div className="usage-view">
          <section className="card">
            <h3>已配置 Server（点击启用/停用，自动重扫）</h3>
            <div className="mcpcfg-list">
              {(settings?.mcpServers ?? []).map((s) => (
                <div key={s.id} className="conflict-row">
                  <span className={`pill ${s.enabled ? "pill-ok" : ""}`}>{s.enabled ? "启用" : "停用"}</span>
                  <span className="conflict-msg">
                    <strong>{s.name}</strong> · {s.builtin ? "内置" : s.transport} {s.command ? `· ${s.command}` : ""}
                  </span>
                  {!s.builtin ? <button className="ghost-btn tiny" onClick={() => toggleServer(s.id)}>{s.enabled ? "停用" : "启用"}</button> : null}
                </div>
              ))}
            </div>
            <p className="dim small">添加新 server：编辑配置文件 mcp.json（设置页保存后自动生效）。当前文件位于应用数据目录。</p>
          </section>
          {mcp ? (
            <section className="card">
              <h3>实时状态</h3>
              <div className="conflict-list">
                {mcp.servers.map((s) => (
                  <div key={s.id} className="conflict-row">
                    <span className={`dot ${s.status === "connected" ? "ok" : "bad"}`} />
                    <span className="conflict-msg">{s.name}：{s.status === "connected" ? `${s.toolCount} 个工具` : s.status}</span>
                    {s.id === "memory" ? (
                      <button className="ghost-btn tiny" onClick={() => toggleBuiltin("memory")}>
                        {s.status === "disabled" ? "启用记忆库" : "停用记忆库"}
                      </button>
                    ) : null}
                  </div>
                ))}
              </div>
              <p className="dim small">隐私策略：记忆库不记录本机/系统环境信息；模型检索记忆需用户在消息中提及历史（“之前/上次/还记得”）方可执行；摘要不再自动注入。</p>
            </section>
          ) : null}
        </div>
      )}
      {tab === "ops" && isBoss && (
        <OpsTab onFlash={(m) => setNotice(m)} />
      )}
      {tab === "accounts" && isBoss && (
        <div className="usage-view">
          <section className="card">
            <h3>新建账号 <small className="dim">（员工账号自动关联专属 AI 员工档案，对话与留痕按人分账）</small></h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, maxWidth: 860 }}>
              <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                用户名（3-24 位小写字母/数字/_）
                <input value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value.trim().toLowerCase() })} placeholder="如 tester01（大写会自动转小写）" />
              </label>
              <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                显示名称
                <input value={newUser.display_name} onChange={(e) => setNewUser({ ...newUser, display_name: e.target.value })} placeholder="如 张测试" />
              </label>
              <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                初始密码（≥6 位）
                <input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
              </label>
              <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                角色
                <select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}>
                  <option value="employee">员工（仅对话办公）</option>
                  <option value="boss">主控（全景监管）</option>
                </select>
              </label>
            </div>
            <div style={{ marginTop: 10 }}>
              <button className="ghost-btn" onClick={createUser} disabled={newUser.username === "" || newUser.password.length < 6}>创建账号</button>
            </div>
          </section>
          <section className="card">
            <h3>账号列表（{(users ?? []).length} 个）</h3>
            <div className="table-wrap">
              <table className="entity-table">
                <thead><tr><th>用户名</th><th>名称</th><th>登录IP/归属地</th><th>角色</th><th>状态</th><th>会话</th><th>操作</th></tr></thead>
                <tbody>
                  {(users ?? []).map((u) => (
                    <tr key={u.id} style={{ opacity: u.status === "active" ? 1 : 0.55 }}>
                      <td>{u.username}</td>
                      <td>{u.display_name}</td>
                      <td>
                        <div>{u.lastLoginIp ?? "—"}</div>
                        {u.lastIpRegion ? <small className="dim">{u.lastIpRegion}</small> : null}
                      </td>
                      <td>{u.role === "boss" ? "管理员账号" : u.role === "observer" ? "管理员" : "成员"}</td>
                      <td>{u.status === "active" ? <span className="pill pill-ok">正常</span> : <span className="pill">停用</span>}</td>
                      <td>{u.conversation_count ?? 0}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {u.role === "boss" ? <span className="dim">—</span> : (
                          <>
                            <button className="ghost-btn tiny" onClick={async () => { try { await adminSetUserRole(u.id, u.role === "observer" ? "employee" : "observer"); await loadUsers(); } catch (e) { setNotice(String(e?.message ?? e)); } }}>
                              {u.role === "observer" ? "取消授权" : "授权监管视图"}
                            </button>{" "}
                            <button className="ghost-btn tiny" onClick={async () => { try { await adminSetUserStatus(u.id, u.status === "active" ? "disabled" : "active"); await loadUsers(); } catch (e) { setNotice(String(e?.message ?? e)); } }}>
                              {u.status === "active" ? "停用" : "启用"}
                            </button>{" "}
                            <button className="ghost-btn tiny" onClick={async () => {
                              const pwd = window.prompt(`为 ${u.username} 设置新密码（≥6 位）：`);
                              if (pwd == null) return;
                              try { await adminResetPassword(u.id, pwd); setNotice(`已重置 ${u.username} 的密码`); } catch (e) { setNotice(String(e?.message ?? e)); }
                            }}>重置密码</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="dim small">停用立即踢下线；员工登录后仅见对话页（模型与上下文由主控统一配置——共用一个大脑）。</p>
          </section>
        </div>
      )}
    </div>
  );
}

/** 本机运维（仅管理员账号）：版本 / 运行状态 / 本机账号与登录足迹 */
function OpsTab({ onFlash }) {
  const [meta, setMeta] = useState(null);
  const [users, setUsers] = useState([]);

  const load = useCallback(async () => {
    try { setMeta(await getMeta()); } catch {}
    try { setUsers(await adminUsers()); } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const shutdown = async () => {
    if (!window.confirm("确认停止本机服务？3 秒后退出，需手动重启。")) return;
    try {
      const r = await adminShutdown();
      onFlash(r?.message ?? "已发出停止指令");
    } catch (e) { onFlash(String(e?.message ?? e)); }
  };

  const online = users.filter((u) => u.lastLoginIp);

  return (
    <div className="usage-view">
      <div className="kpi-row">
        <StatCard label="注册账号" value={String(users.length)} unit="个" hint={`最近登录 ${online.length} 人`} />
        <StatCard label="版本" value={meta?.version ?? "—"} hint={meta?.startedAt ?? ""} />
        <StatCard label="运行状态" value="本地服务运行中" tone="ok" hint="本页仅管理员账号可见" />
      </div>
      <section className="card">
        <h3>本机控制</h3>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="ghost-btn" style={{ color: "#b3372c", borderColor: "rgba(179,55,44,.4)" }} onClick={shutdown}>停止本机服务</button>
          <button className="ghost-btn" onClick={load}>刷新</button>
        </div>
        <p className="dim small" style={{ marginTop: 10 }}>停止本机服务：本机进程 3 秒后退出（需手动重启）。</p>
      </section>
      <section className="card">
        <h3>登录足迹（最近）</h3>
        <div className="table-wrap">
          <table className="entity-table">
            <thead><tr><th>账号</th><th>最近登录 IP</th><th>归属地</th><th>状态</th></tr></thead>
            <tbody>
              {online.slice(0, 10).map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 600 }}>{u.display_name || u.username}</td>
                  <td style={{ fontFamily: "monospace", fontSize: 12 }}>{u.lastLoginIp ?? "—"}</td>
                  <td>{u.lastIpRegion ?? "—"}</td>
                  <td>{u.status === "active" ? <span className="pill pill-ok">正常</span> : <span className="pill">停用</span>}</td>
                </tr>
              ))}
              {online.length === 0 ? <tr><td colSpan={4} className="dim">暂无登录记录</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
