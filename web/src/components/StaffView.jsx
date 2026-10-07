import React, { useCallback, useEffect, useState } from "react";
import { adminUsers, adminSetUserRole, adminSetUserStatus, adminResetPassword, adminDeleteUser, adminSetUserDepartment, teamEmployees, teamUpdateEmployee } from "../lib/api.js";

// 在线判定：服务端每次鉴权请求刷新 last_seen（前端 15s 轮询即心跳），3 分钟内视为在线
const ONLINE_MS = 3 * 60 * 1000;
function isOnline(u) {
  if (!u?.lastSeen) return false;
  const t = Date.parse(u.lastSeen);
  return Number.isFinite(t) && Date.now() - t < ONLINE_MS;
}

/**
 * 成员管理（仅管理员可见）：
 * - 管理真人成员：角色分配（成员↔管理员）、停用/启用、重置密码、移除账号（仅管理员可操作，管理员自身不可移除）
 * - 给 AI 员工赋予权限：设定身份/职责
 * - 实时显示登录 IP 与归属地
 */
export default function StaffView({ user }) {
  const [users, setUsers] = useState(null);
  const [aiEmployees, setAiEmployees] = useState(null);
  const [notice, setNotice] = useState("");
  const [editingEmp, setEditingEmp] = useState(null);
  const [identityDraft, setIdentityDraft] = useState("");

  const load = useCallback(async () => {
    try {
      const [u, e] = await Promise.all([adminUsers(), teamEmployees()]);
      setUsers(u);
      setAiEmployees(e);
    } catch (e2) {
      setNotice(`加载失败: ${e2?.message ?? e2}`);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const flash = (m) => { setNotice(m); setTimeout(() => setNotice(""), 4000); };
  const isBoss = user?.role === "boss";

  const setRole = async (u, role) => {
    try { await adminSetUserRole(u.id, role); flash(`${u.username} → ${role === "observer" ? "管理员" : "成员"}`); await load(); }
    catch (e) { flash(String(e?.message ?? e)); }
  };
  const toggleStatus = async (u) => {
    try { await adminSetUserStatus(u.id, u.status === "active" ? "disabled" : "active"); await load(); }
    catch (e) { flash(String(e?.message ?? e)); }
  };
  const resetPwd = async (u) => {
    const pwd = window.prompt(`为 ${u.username} 设置新密码（≥6位）：`);
    if (pwd == null || pwd.length < 6) return;
    try { await adminResetPassword(u.id, pwd); flash(`已重置 ${u.username} 密码`); }
    catch (e) { flash(String(e?.message ?? e)); }
  };
  const removeUser = async (u) => {
    const ok = window.confirm(
      `确定移除账号「${u.username}」（${u.display_name}）？\n\n` +
      `• 该账号将立即下线且无法再登录\n` +
      `• 其 AI 身份记录与团队成员引用会一并清理\n` +
      `• 历史对话与监管留痕保留（共 ${u.conversation_count ?? 0} 个会话）\n\n` +
      `此操作不可撤销。`,
    );
    if (!ok) return;
    try { await adminDeleteUser(u.id); flash(`已移除账号 ${u.username}`); await load(); }
    catch (e) { flash(String(e?.message ?? e)); }
  };
  const saveIdentity = async (emp) => {
    try { await teamUpdateEmployee(emp.id, { identity: identityDraft }); setEditingEmp(null); flash(`已更新「${emp.name}」身份`); await load(); }
    catch (e) { flash(String(e?.message ?? e)); }
  };

  return (
    <div className="view-pad">
      <header className="view-head">
        <h2 className="view-title">成员管理</h2>
        <div className="spacer" />
        <button className="ghost-btn" onClick={load}>刷新</button>
      </header>
      {notice ? <div className="msg-error" style={{ marginBottom: 10 }}>{notice}</div> : null}

      {/* 真人成员 */}
      <section className="card" style={{ marginBottom: 16 }}>
        <h3>真人成员（{(users ?? []).length} 人）</h3>
        <div className="table-wrap">
          <table className="entity-table">
            <thead>
              <tr><th>用户名</th><th>名称</th><th>角色</th><th>部门</th><th>登录IP / 归属地</th><th>状态</th><th>操作</th></tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => (
                <tr key={u.id} style={{ opacity: u.status === "active" ? 1 : 0.5 }}>
                  <td style={{ fontWeight: 600 }}>{u.username}</td>
                  <td>{u.display_name}</td>
                  <td>
                    {u.role === "boss" ? (
                      <span className="pill pill-ok">管理员</span>
                    ) : u.role === "observer" ? (
                      <span className="pill" style={{ color: "#b26a00", borderColor: "rgba(255,152,0,.4)" }}>管理员</span>
                    ) : (
                      <span className="pill">成员</span>
                    )}
                  </td>
                  <td>
                    {isBoss ? (
                      <input
                        className="dept-input"
                        defaultValue={u.department ?? ""}
                        placeholder="未分配"
                        title="部门：审计分权按本人/本部门判定可直接修改的范围；回车或失焦保存"
                        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                        onBlur={async (e) => {
                          const v = e.currentTarget.value.trim();
                          if (v === (u.department ?? "")) return;
                          try { await adminSetUserDepartment(u.id, v); flash(`${u.username} 部门 → ${v || "未分配"}`); await load(); } catch (err) { flash(String(err?.message ?? err)); }
                        }}
                      />
                    ) : (u.department ?? <span className="dim">未分配</span>)}
                  </td>
                  <td>
                    <div style={{ fontFamily: "monospace", fontSize: 12 }}>{u.lastLoginIp ?? "—"}</div>
                    {u.lastIpRegion ? <small className="dim">{u.lastIpRegion}</small> : null}
                  </td>
                  <td>
                    {u.status === "active" ? <span className="pill pill-ok">正常</span> : <span className="pill">停用</span>}{" "}
                    {u.status === "active" ? (isOnline(u) ? <span className="pill" style={{ color: "#0a7a3c", background: "#e3f6ea", borderColor: "transparent" }} title={`最近活动 ${u.lastSeen ?? ""}`}>● 在线</span> : <span className="pill dim" title={u.lastSeen ? `最近活动 ${u.lastSeen}` : "从未登录"}>○ 离线</span>) : null}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {u.role !== "boss" ? (
                      <>
                        <button className="ghost-btn tiny" onClick={() => setRole(u, u.role === "observer" ? "employee" : "observer")}>
                          {u.role === "observer" ? "取消管理员" : "设为管理员"}
                        </button>{" "}
                        <button className="ghost-btn tiny" onClick={() => toggleStatus(u)}>
                          {u.status === "active" ? "停用" : "启用"}
                        </button>{" "}
                        <button className="ghost-btn tiny" onClick={() => resetPwd(u)}>重置密码</button>
                        {isBoss ? (
                          <>
                            {" "}
                            <button className="ghost-btn tiny" style={{ color: "#c62828", borderColor: "rgba(198,40,40,.4)" }} onClick={() => removeUser(u)}>移除</button>
                          </>
                        ) : null}
                      </>
                    ) : <span className="dim">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* AI 员工权限 */}
      <section className="card">
        <h3>AI 员工（{(aiEmployees ?? []).length} 名）<small className="dim"> — 点击「设身份」赋予职责与权限</small></h3>
        <div className="table-wrap">
          <table className="entity-table">
            <thead><tr><th>名称</th><th>归属</th><th>绑定 API</th><th>身份 / 职责</th><th>操作</th></tr></thead>
            <tbody>
              {(aiEmployees ?? []).map((e) => (
                <tr key={e.id}>
                  <td style={{ fontWeight: 600 }}>{e.name}</td>
                  <td>{e.owner_user_id == null ? <span className="pill">公共</span> : <span className="pill pill-ok">成员私有</span>}</td>
                  <td style={{ fontFamily: "monospace", fontSize: 11 }}>{e.source_provider ?? e.provider_id ?? "—"}</td>
                  <td style={{ maxWidth: 300 }}>
                    {editingEmp === e.id ? (
                      <div style={{ display: "flex", gap: 6, width: "100%" }}>
                        <textarea rows={2} style={{ flex: 1 }} value={identityDraft} onChange={(ev) => setIdentityDraft(ev.target.value)} placeholder="如：你是财务分析专员，专注报表测算与风险提示" />
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <button className="ghost-btn tiny" onClick={() => saveIdentity(e)}>保存</button>
                          <button className="ghost-btn tiny" onClick={() => setEditingEmp(null)}>取消</button>
                        </div>
                      </div>
                    ) : (
                      <span className="dim" title={e.identity ?? ""}>{e.identity ? e.identity.slice(0, 50) : "（未设定）"}</span>
                    )}
                  </td>
                  <td>
                    {editingEmp === e.id ? null : (
                      <button className="ghost-btn tiny" onClick={() => { setEditingEmp(e.id); setIdentityDraft(e.identity ?? ""); }}>设身份</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
