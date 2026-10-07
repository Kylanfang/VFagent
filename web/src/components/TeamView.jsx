import React, { useCallback, useEffect, useState } from "react";
import { teamEmployees, teamCreateEmployee, teamUpdateEmployee, teamTransferEmployee, teamList, teamCreate, teamDisband, adminUsers, teamGrantIssue, teamGrantList } from "../lib/api.js";
import TopologyCanvas from "./TopologyCanvas.jsx";

/**
 * AI 员工自助工作台（全员可见）：
 * - 成员经 API 自建 AI 员工并设定身份；公共 API（含管理员接入的）也可绑定
 * - 转交 API 调用权给其他成员
 * - 组建临时部门（多 AI 协作单位，任务派活时选部门即接力执行）
 */
export default function TeamView({ user }) {
  const [employees, setEmployees] = useState(null);
  const [teams, setTeams] = useState(null);
  const [humans, setHumans] = useState(null);
  const [notice, setNotice] = useState("");
  const [sub, setSub] = useState("manage"); // manage=组织管理 | topo=组织拓扑
  const [editingId, setEditingId] = useState(null);
  const [identityDraft, setIdentityDraft] = useState("");
  const [newEmp, setNewEmp] = useState({ name: "", identity: "", mode: "bind", providerId: "", label: "", baseUrl: "", model: "", apiKey: "" });
  const [newTeam, setNewTeam] = useState({ name: "", purpose: "", memberIds: [], grantCode: "" });
  const [grants, setGrants] = useState(null);
  const isStaff = user?.role === "boss" || user?.role === "observer";

  const load = useCallback(async () => {
    try {
      setEmployees(await teamEmployees());
      setTeams(await teamList());
      if (user?.role === "boss") {
        adminUsers().then(setHumans).catch((e) => console.warn("[load]", String(e?.message ?? e)));
        teamGrantList().then((r) => setGrants(r?.grants ?? [])).catch((e) => console.warn("[load]", String(e?.message ?? e)));
      }
    } catch (e) {
      setNotice(`加载失败: ${e?.message ?? e}`);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const issueGrant = async () => {
    try {
      const g = await teamGrantIssue();
      flash(`已签发授权码：${g.code}（48 小时内有效，一次性）`);
      teamGrantList().then((r) => setGrants(r?.grants ?? [])).catch((e) => console.warn("[load]", String(e?.message ?? e)));
    } catch (e) { flash(String(e?.message ?? e)); }
  };

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(""), 4000); };
  const publicProviders = (employees ?? []).filter((e) => e.owner_user_id == null && e.id.startsWith("emp_") && !e.id.startsWith("emp_u_") && !e.id.startsWith("emp_central"));

  const createEmployee = async () => {
    try {
      const payload = { name: newEmp.name.trim(), identity: newEmp.identity.trim() || null };
      if (newEmp.mode === "bind") {
        if (newEmp.providerId === "") throw new Error("请选择要绑定的公共 API");
        payload.providerId = newEmp.providerId;
      } else {
        payload.providerFields = { label: newEmp.label.trim() || newEmp.name.trim(), baseUrl: newEmp.baseUrl.trim(), model: newEmp.model.trim(), apiKey: newEmp.apiKey.trim() };
      }
      const created = await teamCreateEmployee(payload);
      flash(`已创建 AI 员工「${created.name}」${created.owner_user_id ? "（归属你）" : ""}，已可在对话页选择使用`);
      window.dispatchEvent(new Event("vfletch:employees-changed"));
      setNewEmp({ name: "", identity: "", mode: "bind", providerId: "", label: "", baseUrl: "", model: "", apiKey: "" });
      await load();
    } catch (e) { flash(String(e?.message ?? e)); }
  };

  const saveIdentity = async (emp) => {
    try {
      await teamUpdateEmployee(emp.id, { identity: identityDraft });
      window.dispatchEvent(new Event("vfletch:employees-changed"));
      setEditingId(null);
      flash(`已更新「${emp.name}」的身份设定`);
      await load();
    } catch (e) { flash(String(e?.message ?? e)); }
  };

  const transfer = async (emp) => {
    const to = window.prompt(`把「${emp.name}」的 API 调用权转给哪位成员？（输入用户名，如 member03）`);
    if (to == null || to.trim() === "") return;
    try {
      const r = await teamTransferEmployee(emp.id, to.trim());
      window.dispatchEvent(new Event("vfletch:employees-changed"));
      flash(`已转交给 ${r.transferredTo ?? to.trim()}`);
      await load();
    } catch (e) { flash(String(e?.message ?? e)); }
  };

  const createTeamFn = async () => {
    try {
      await teamCreate({ name: newTeam.name.trim(), purpose: newTeam.purpose.trim() || null, memberIds: newTeam.memberIds, grantCode: newTeam.grantCode });
      flash(`临时部门「${newTeam.name.trim()}」已组建；任务派活时选择该部门即可接力协作`);
      setNewTeam({ name: "", purpose: "", memberIds: [], grantCode: "" });
      await load();
    } catch (e) { flash(String(e?.message ?? e)); }
  };

  const disband = async (id) => {
    try { await teamDisband(id); flash("部门已解散（历史任务留痕保留）"); await load(); } catch (e) { flash(String(e?.message ?? e)); }
  };

  const toggleTeamMember = (id) => {
    setNewTeam((t) => ({
      ...t,
      memberIds: t.memberIds.includes(id) ? t.memberIds.filter((m) => m !== id) : [...t.memberIds, id],
    }));
  };

  const empName = (id) => (employees ?? []).find((e) => e.id === id)?.name ?? id;

  return (
    <div className="view-pad">
      <header className="view-head">
        <h2 className="view-title">组织部门</h2>
        <div className="seg" style={{ alignSelf: "center" }}>
          <button className={sub === "manage" ? "on" : ""} onClick={() => setSub("manage")}>组织管理</button>
          <button className={sub === "topo" ? "on" : ""} onClick={() => setSub("topo")}>组织拓扑</button>
        </div>
        <span className="view-sub">{isStaff ? "管理员视角：可管理全部 AI 员工" : "经 API 自建 AI 员工 · 设定身份 · 转交调用权 · 组建临时部门"}</span>
        <div className="spacer" />
        <button className="ghost-btn" onClick={load}>刷新</button>
      </header>
      {notice ? <div className="msg-error" style={{ marginBottom: 10 }}>{notice}</div> : null}

      {sub === "topo" ? (
        <TopologyCanvas employees={employees ?? []} teams={teams ?? []} users={humans ?? []} isStaff={isStaff} />
      ) : (
      <>

      <div className="grid-2" style={{ alignItems: "start" }}>
        <section className="card" style={{ marginBottom: 14 }}>
          <h3>添加 AI 员工 <small className="dim">（成员可用；API 进共享池，AI 员工归属你）</small></h3>
          <div style={{ display: "grid", gap: 8 }}>
            <label style={labelStyle}>名称<input value={newEmp.name} onChange={(e) => setNewEmp({ ...newEmp, name: e.target.value })} placeholder="如 财务分析专员" /></label>
            <label style={labelStyle}>身份设定（注入其系统提示：职责/口吻/边界）<textarea rows={2} value={newEmp.identity} onChange={(e) => setNewEmp({ ...newEmp, identity: e.target.value })} placeholder="如：你是财务分析专员，专注报表测算与风险提示，回答必须给出数字依据" /></label>
            <div className="seg">
              <button className={newEmp.mode === "bind" ? "on" : ""} onClick={() => setNewEmp({ ...newEmp, mode: "bind" })}>绑定公共 API</button>
              <button className={newEmp.mode === "new" ? "on" : ""} onClick={() => setNewEmp({ ...newEmp, mode: "new" })}>新建 API 接入</button>
            </div>
            {newEmp.mode === "bind" ? (
              <label style={labelStyle}>选择公共 API
                <select value={newEmp.providerId} onChange={(e) => setNewEmp({ ...newEmp, providerId: e.target.value })}>
                  <option value="">选择…</option>
                  {publicProviders.map((p) => <option key={p.id} value={p.source_provider ?? p.provider_id}>{p.name}（{p.model ?? p.source_provider}）</option>)}
                </select>
              </label>
            ) : (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <label style={labelStyle}>Base URL<input value={newEmp.baseUrl} onChange={(e) => setNewEmp({ ...newEmp, baseUrl: e.target.value })} placeholder="https://api.deepseek.com/v1" /></label>
                  <label style={labelStyle}>模型 ID<input value={newEmp.model} onChange={(e) => setNewEmp({ ...newEmp, model: e.target.value })} placeholder="deepseek-chat" /></label>
                </div>
                <label style={labelStyle}>API Key<input type="password" value={newEmp.apiKey} onChange={(e) => setNewEmp({ ...newEmp, apiKey: e.target.value })} placeholder="sk-…" /></label>
              </>
            )}
            <div><button className="ghost-btn" onClick={createEmployee} disabled={newEmp.name.trim() === ""}>创建 AI 员工</button></div>
          </div>
        </section>

        <section className="card" style={{ marginBottom: 14 }}>
          <h3>组建临时部门 <small className="dim">（2-6 名 AI 员工；任务派活选部门即接力协作）</small></h3>
          <div style={{ display: "grid", gap: 8 }}>
            <label style={labelStyle}>部门名称<input value={newTeam.name} onChange={(e) => setNewTeam({ ...newTeam, name: e.target.value })} placeholder="如 尽调突击组" /></label>
            <label style={labelStyle}>职责（可选）<input value={newTeam.purpose} onChange={(e) => setNewTeam({ ...newTeam, purpose: e.target.value })} placeholder="如 负责本季度科创客户尽调" /></label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(employees ?? []).map((e) => (
                <button key={e.id} className={`ghost-btn tiny ${newTeam.memberIds.includes(e.id) ? "on" : ""}`} onClick={() => toggleTeamMember(e.id)}>
                  {e.name}
                </button>
              ))}
            </div>
            {!isStaff ? (
              <label style={labelStyle}>主控授权码 *<input value={newTeam.grantCode} onChange={(e) => setNewTeam({ ...newTeam, grantCode: e.target.value.toUpperCase() })} placeholder="向主控获取（如 TD-XXXX-XXXX）" /></label>
            ) : null}
            <div>
              <button className="ghost-btn" onClick={createTeamFn} disabled={newTeam.name.trim() === "" || newTeam.memberIds.length < 2}>组建（已选 {newTeam.memberIds.length}）</button>
              {isStaff ? <span className="dim small" style={{ marginLeft: 10 }}>主控/管理员无需授权码</span> : null}
            </div>
          </div>
          {isStaff && user?.role === "boss" ? (
            <div style={{ marginTop: 12, borderTop: "1px dashed var(--border)", paddingTop: 10 }}>
              <button className="ghost-btn tiny" onClick={issueGrant}>签发部门授权码（48h·一次性）</button>
              {(grants ?? []).length > 0 ? (
                <div style={{ marginTop: 8 }}>
                  {(grants ?? []).slice(0, 5).map((g) => (
                    <div key={g.code} className="dim small" style={{ fontFamily: "var(--mono)", marginBottom: 2 }}>
                      {g.code} · {g.usedBy ? `已被 ${g.usedBy} 使用` : `有效至 ${g.expiresAt.slice(0, 16)}`}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {(teams ?? []).length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <h4 style={{ margin: "6px 0" }}>现有部门</h4>
              {(teams ?? []).map((t) => (
                <div key={t.id} className="conflict-row" style={{ marginBottom: 6 }}>
                  <span className="pill pill-ok">部门</span>
                  <span className="conflict-msg"><strong>{t.name}</strong> · {t.member_ids.map(empName).join(" → ")}</span>
                  <button className="ghost-btn tiny" onClick={() => disband(t.id)}>解散</button>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      </div>

      <section className="card">
        <h3>AI 员工（{(employees ?? []).length} 名{isStaff ? "" : "，含公共与本人"}）</h3>
        <div className="table-wrap">
          <table className="entity-table">
            <thead><tr><th>名称</th><th>归属</th><th>绑定 API</th><th>身份设定</th><th>操作</th></tr></thead>
            <tbody>
              {(employees ?? []).map((e) => (
                <tr key={e.id}>
                  <td>{e.name}</td>
                  <td>{e.owner_user_id == null ? <span className="pill">公共</span> : <span className="pill pill-ok">{e.owner_user_id === user?.id ? "本人" : "成员"}</span>}</td>
                  <td>{e.source_provider ?? e.provider_id ?? "—"}</td>
                  <td style={{ maxWidth: 320 }}>
                    {editingId === e.id ? (
                      <div style={{ display: "flex", gap: 6, width: "100%" }}>
                        <textarea rows={2} style={{ flex: 1 }} value={identityDraft} onChange={(ev) => setIdentityDraft(ev.target.value)} />
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          <button className="ghost-btn tiny" onClick={() => saveIdentity(e)}>保存</button>
                          <button className="ghost-btn tiny" onClick={() => setEditingId(null)}>取消</button>
                        </div>
                      </div>
                    ) : (
                      <span className="dim" title={e.identity ?? ""}>{e.identity ? e.identity.slice(0, 60) : "（未设定）"}</span>
                    )}
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    {editingId === e.id ? null : (
                      <>
                        <button className="ghost-btn tiny" onClick={() => { setEditingId(e.id); setIdentityDraft(e.identity ?? ""); }}>设身份</button>{" "}
                        {(e.owner_user_id === user?.id || isStaff) ? <button className="ghost-btn tiny" onClick={() => transfer(e)}>转交</button> : null}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="dim small">成员聊天时可在输入框左下选择自己的 AI 员工（身份设定会注入其系统提示）；转交后对方立即获得该 API 的调用权。</p>
      </section>
      </>
      )}
    </div>
  );
}

const labelStyle = {
  fontSize: 12, display: "flex", flexDirection: "column", gap: 4,
};
