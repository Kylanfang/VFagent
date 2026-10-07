import React, { useEffect, useState } from "react";
import { getAuditOverview, auditSaveRecord, auditEdits, auditEditsMine, auditEditApply, auditEditReject } from "../lib/api.js";
import { StatCard, HeatGrid, Sparkline, ShareBars } from "./ui.jsx";
import { fieldLabel } from "../lib/auditLabels.js";

// 实体键显示名：先查页面级 KEY_LABEL，再退回字段名规则
const keyLabel = (k) => KEY_LABEL[k] || fieldLabel(k);

/** 值渲染：数组→按项摘要；对象→取 name/title/id 摘要；不再把原始 JSON 铺在界面上 */
function cellText(value) {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    if (value.every((v) => v == null || typeof v !== "object")) {
      const joined = value.map((v) => String(v ?? "")).join("、");
      return joined.length > 48 ? joined.slice(0, 48) + "…" : joined;
    }
    const first = value[0];
    const head = first?.name ?? first?.title ?? first?.id ?? "";
    return `${value.length} 项${head ? `：${String(head).slice(0, 16)}…` : ""}`;
  }
  if (typeof value === "object") {
    const head = value.name ?? value.title ?? value.id ?? value.status ?? value.result;
    return head != null ? String(head).slice(0, 48) : `${Object.keys(value).length} 个字段`;
  }
  const s = String(value);
  return s.length > 48 ? s.slice(0, 48) + "…" : s;
}

/** 记录编辑弹层：任意实体对象 → 键值表单（对象/数组值用 JSON 文本域） */
function RecordEditor({ title, record, onClose, onSave }) {
  const keys = Object.keys(record ?? {});
  const [draft, setDraft] = useState(() => {
    const d = {};
    for (const k of keys) {
      const v = record[k];
      d[k] = v == null || typeof v !== "object" ? String(v ?? "") : JSON.stringify(v, null, 1);
    }
    return d;
  });
  const [err, setErr] = useState("");

  const submit = () => {
    const patch = {};
    for (const k of keys) {
      const raw = draft[k];
      const orig = record[k];
      try {
        if (orig != null && typeof orig === "object") {
          const trimmed = raw.trim();
          patch[k] = trimmed === "" ? null : JSON.parse(trimmed);
        } else if (typeof orig === "number") {
          patch[k] = raw.trim() === "" ? null : Number(raw);
        } else if (typeof orig === "boolean") {
          patch[k] = raw === "true";
        } else {
          patch[k] = raw;
        }
      } catch {
        setErr(`字段「${fieldLabel(k)}」不是合法 JSON`);
        return;
      }
    }
    onSave(patch);
  };

  return (
    <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-body">
        <h3 style={{ margin: "0 0 12px" }}>{title}</h3>
        {keys.length === 0 ? <div className="chart-empty">该记录无字段（对象数组请用 JSON 编辑）</div> : null}
        <div className="record-editor">
          {keys.map((k) => {
            const isJson = record[k] != null && typeof record[k] === "object";
            return (
              <label key={k} className="record-field">
                <span className="record-key" title={k}>{fieldLabel(k)}</span>
                {isJson || String(draft[k] ?? "").length > 60 ? (
                  <textarea rows={3} value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                ) : (
                  <input value={draft[k]} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
                )}
              </label>
            );
          })}
        </div>
        {err ? <div className="msg-error" style={{ margin: "8px 0" }}>{err}</div> : null}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button className="ghost-btn" onClick={onClose}>取消</button>
          <button className="ghost-btn primary" onClick={submit}>保存</button>
        </div>
      </div>
    </div>
  );
}

/** 通用实体表：数组 → 表格；对象 → 键值表。管理员可增改删 */
function EntityTable({ value, keyName, editable, onSaveRecord }) {
  const [editing, setEditing] = useState(null); // { mode: "edit"|"add", index }

  if (value == null) return <div className="chart-empty">无数据</div>;

  const save = async (action, index, payload) => {
    try {
      await onSaveRecord({ key: keyName, action, index, ...payload });
      setEditing(null);
    } catch (e) {
      window.alert(String(e?.message ?? e));
    }
  };

  if (!Array.isArray(value)) {
    return (
      <>
        <div className="kv-table">
          {Object.entries(value).slice(0, 14).map(([k, v]) => (
            <div key={k} className="kv-row">
              <span className="kv-key" title={k}>{fieldLabel(k)}</span>
              <span className="kv-val">{cellText(v)}</span>
            </div>
          ))}
        </div>
        {editable ? (
          <div style={{ marginTop: 8 }}>
            <button className="ghost-btn tiny" onClick={() => setEditing({ mode: "edit", index: null })}>编辑</button>
          </div>
        ) : null}
        {editing ? (
          <RecordEditor
            title={`编辑${keyLabel(keyName)}`}
            record={value}
            onClose={() => setEditing(null)}
            onSave={(patch) => save("update", null, { patch })}
          />
        ) : null}
      </>
    );
  }

  if (value.length === 0) return <div className="chart-empty">空列表</div>;
  const cols = [...new Set(value.slice(0, 6).flatMap((row) => Object.keys(row ?? {})))].slice(0, 6);
  return (
    <div className="table-wrap">
      <table className="entity-table">
        <thead>
          <tr>
            {cols.map((c) => <th key={c} title={c}>{fieldLabel(c)}</th>)}
            {editable ? <th>操作</th> : null}
          </tr>
        </thead>
        <tbody>
          {value.slice(0, 10).map((row, i) => (
            <tr key={i}>
              {cols.map((c) => <td key={c} title={typeof row[c] === "object" ? JSON.stringify(row[c], null, 2).slice(0, 800) : String(row[c] ?? "")}>{cellText(row[c])}</td>)}
              {editable ? (
                <td style={{ whiteSpace: "nowrap" }}>
                  <button className="ghost-btn tiny" onClick={() => setEditing({ mode: "edit", index: i })}>编辑</button>{" "}
                  <button className="ghost-btn tiny" onClick={() => { if (window.confirm("确认删除该记录？")) save("delete", i, {}); }}>删除</button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="table-more">
        {value.length > 10 ? `共 ${value.length} 条，显示前 10 条（可用对话查询全部）` : `共 ${value.length} 条`}
        {editable ? <button className="ghost-btn tiny" style={{ marginLeft: 10 }} onClick={() => setEditing({ mode: "add", index: null })}>+ 新增</button> : null}
      </div>
      {editing ? (
        <RecordEditor
          title={editing.mode === "add" ? `新增${keyLabel(keyName)}记录` : `编辑${keyLabel(keyName)} #${editing.index + 1}`}
          record={editing.mode === "add" ? Object.fromEntries(cols.map((c) => [c, ""])) : value[editing.index] ?? {}}
          onClose={() => setEditing(null)}
          onSave={(patch) => save(editing.mode === "add" ? "add" : "update", editing.index, editing.mode === "add" ? { record: patch } : { patch })}
        />
      ) : null}
    </div>
  );
}

function DashboardTab({ d, editable, onSaveRecord }) {
  const s = d.dashboardStats ?? {};
  const [editStats, setEditStats] = useState(false);
  const [editAlert, setEditAlert] = useState(null);
  const trend = (d.riskTrend ?? []).map((t) => ({ label: t.date, value: t.count }));
  const dist = (d.riskDistribution ?? []).map((x) => ({ label: x.type, value: x.count }));
  const hm = d.riskHeatmapData;
  return (
    <>
      <div className="kpi-row">
        <StatCard label="风险总数" value={s.totalRisks ?? "—"} tone="high" />
        <StatCard label="待整改工单" value={s.pendingTickets ?? "—"} tone="warn" />
        <StatCard label="账号健康度" value={s.accountHealth ?? "—"} unit="%" tone="ok" />
        <StatCard label="交易异常率" value={s.transactionAnomalyRate ?? "—"} unit="%" />
        {editable ? (
          <div style={{ alignSelf: "center" }}>
            <button className="ghost-btn tiny" onClick={() => setEditStats(true)}>编辑指标</button>
          </div>
        ) : null}
      </div>
      <div className="grid-2">
        <section className="card">
          <h3>风险趋势</h3>
          <Sparkline data={trend} width={440} height={90} />
        </section>
        <section className="card">
          <h3>风险类型分布</h3>
          <ShareBars items={dist} />
        </section>
      </div>
      {hm ? (
        <section className="card">
          <h3>部门 × 维度 热力图 <small className="dim">（{hm.period}，数字为风险分）</small></h3>
          <HeatGrid cells={hm.cells} dimensions={hm.dimensions} />
        </section>
      ) : null}
      <section className="card">
        <h3>高风险告警 {editable ? <small className="dim">（点击状态可改）</small> : null}</h3>
        <div className="alert-list">
          {(d.highRiskAlerts ?? []).map((a, i) => (
            <div key={a.id ?? i} className={`alert-row ${a.status === "已销号" ? "done" : ""}`}>
              <span className={`dot ${a.status === "已销号" ? "ok" : "bad"}`} />
              <div className="alert-main">
                <div className="alert-title">{a.title}</div>
                <div className="alert-sub">{a.type} · {a.department} · {a.createdAt?.slice(5, 16)}</div>
              </div>
              {editable ? (
                <button
                  className={`pill ${a.status === "已销号" ? "pill-ok" : "pill-bad"}`}
                  style={{ cursor: "pointer" }}
                  title="点击编辑告警"
                  onClick={() => setEditAlert(i)}
                >
                  {a.status}
                </button>
              ) : (
                <span className={`pill ${a.status === "已销号" ? "pill-ok" : "pill-bad"}`}>{a.status}</span>
              )}
            </div>
          ))}
        </div>
      </section>
      {editStats ? (
        <RecordEditor title="编辑仪表盘指标" record={s} onClose={() => setEditStats(false)}
          onSave={async (patch) => { try { await onSaveRecord({ key: "dashboardStats", action: "update", patch }); setEditStats(false); } catch (e) { window.alert(String(e?.message ?? e)); } }} />
      ) : null}
      {editAlert != null ? (
        <RecordEditor title={`编辑告警 ${d.highRiskAlerts?.[editAlert]?.id ?? editAlert}`} record={d.highRiskAlerts[editAlert] ?? {}} onClose={() => setEditAlert(null)}
          onSave={async (patch) => { try { await onSaveRecord({ key: "highRiskAlerts", action: "update", index: editAlert, patch }); setEditAlert(null); } catch (e) { window.alert(String(e?.message ?? e)); } }} />
      ) : null}
    </>
  );
}

const KEY_LABEL = {
  auditTasks: "审计任务", workPapers: "审计底稿", workPaperTemplates: "底稿模板", evidences: "审计证据",
  complianceRules: "合规规则", complianceCheckResults: "检查结果", complianceGaps: "合规差距",
  employees: "员工名录", recruitmentAudits: "招聘审计", workMonitors: "用工监控", personnelChanges: "人事变更",
  departureAudits: "离职审计", personnelArchives: "人事档案",
  aiModels: "AI 模型管理", riskHeatmapData: "风险热力图", multimodalTasks: "多模态分析任务", fraudClues: "舞弊线索",
  riskTrendComparisons: "风险趋势对比", riskMigrations: "风险迁移", riskQuantifications: "风险量化",
  textAnalysisResults: "文本分析", ocrResults: "OCR 识别", voiceTranscriptionResults: "语音转写", crossSystemAnalyses: "跨系统分析",
  accounts: "账号清单", permissionMappings: "权限映射", accountRequests: "账号申请", accountChanges: "账号变更",
  departureAccounts: "离职账号排查", reconResult: "对账结果", anomalyRecords: "异常记录",
  workflowTickets: "整改工单",
  modelConfigs: "模型配置", ruleConfigs: "规则配置", systemLogs: "系统日志",
};

export default function AuditView({ user }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [module, setModule] = useState("dashboard");
  const [notice, setNotice] = useState("");
  const [requests, setRequests] = useState([]); // 主控：待审批；其他人：我的申请
  const isBoss = user?.role === "boss";

  const reload = () => getAuditOverview().then(setData).catch((e) => setError(String(e?.message ?? e)));
  const reloadRequests = () => (isBoss ? auditEdits() : auditEditsMine()).then((r) => setRequests(r?.requests ?? [])).catch((e) => console.warn("[load]", String(e?.message ?? e)));
  useEffect(() => { reload(); reloadRequests(); }, []);

  // 分权：所有登录用户都可发起修改；服务端判定"本人/本部门"直接生效，其余进入主控审批
  const editable = user != null;

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(""), 6000); };
  const saveRecord = async (payload) => {
    const r = await auditSaveRecord(payload);
    if (r?.pending) {
      flash(r.message ?? "已提交主控审批，批准后生效");
      reloadRequests();
      return;
    }
    flash("已保存并生效");
    await reload();
  };
  const decide = async (id, ok) => {
    try {
      if (ok) await auditEditApply(id); else await auditEditReject(id);
      flash(ok ? "已批准并应用" : "已驳回");
      await Promise.all([reload(), reloadRequests()]);
    } catch (e) { flash(String(e?.message ?? e)); }
  };
  const describeReq = (q) => `${KEY_LABEL[q.key] ?? fieldLabel(q.key ?? "")} · ${q.action === "add" ? "新增" : q.action === "delete" ? "删除" : "修改"}${q.index != null ? ` #${q.index + 1}` : ""}`;

  if (error) return <div className="view-pad"><div className="msg-error">审计数据加载失败：{error}</div></div>;
  if (!data) return <div className="view-pad"><div className="chart-empty">加载中…</div></div>;

  const modules = data._modules ?? [];

  return (
    <div className="view-pad">
      <header className="view-head">
        <h2 className="view-title">审计风控</h2>
        {editable ? <span className="pill pill-ok" style={{ alignSelf: "center" }}>可编辑</span> : null}
        <span className="pill" style={{ alignSelf: "center", background: "#fff4e5", color: "#9a5b00" }} title="审计库当前为内置演示数据集（2024 年 6 月样例），可在线编辑替换为真实数据；AI 回答引用时会注明来源">演示数据</span>
        {!isBoss ? <span className="dim" style={{ alignSelf: "center", fontSize: 12 }} title="分权规则：本人或本部门的记录可直接修改；其他记录会提交主控审批">可改本人/本部门{user?.department ? `（${user.department}）` : "（未分配部门）"}，其余需主控审批</span> : null}
        <div className="seg">
          {modules.map((m) => (
            <button key={m.id} className={module === m.id ? "on" : ""} onClick={() => setModule(m.id)}>
              {m.label}
            </button>
          ))}
        </div>
      </header>

      {notice ? <div className="msg-notice" style={{ margin: "0 0 10px" }}>{notice}</div> : null}
      {requests.length > 0 ? (
        <section className="card" style={{ marginBottom: 12 }}>
          <h3>{isBoss ? `待审批的修改申请（${requests.length}）` : "我的修改申请"}</h3>
          <div className="alert-list">
            {requests.map((q) => (
              <div key={q.id} className="alert-row">
                <span className={`dot ${q.status === "applied" ? "ok" : q.status === "rejected" ? "bad" : ""}`} />
                <div className="alert-main">
                  <div className="alert-title">{describeReq(q)}{isBoss ? ` · 申请人 ${q.requestedBy}` : ""}</div>
                  <div className="alert-sub">
                    {q.reason ? `${q.reason} · ` : ""}{String(q.createdAt ?? "").slice(0, 16)}
                    {q.payload?.patch ? ` · 改动：${Object.entries(q.payload.patch).slice(0, 4).map(([k, v]) => `${fieldLabel(k)}=${typeof v === "object" ? JSON.stringify(v).slice(0, 30) : String(v).slice(0, 30)}`).join("，")}` : ""}
                    {q.payload?.record ? ` · 新记录：${Object.entries(q.payload.record).slice(0, 3).map(([k, v]) => `${fieldLabel(k)}=${String(v).slice(0, 20)}`).join("，")}` : ""}
                  </div>
                </div>
                {isBoss ? (
                  <span style={{ display: "flex", gap: 6 }}>
                    <button className="ghost-btn tiny" onClick={() => decide(q.id, true)}>批准</button>
                    <button className="ghost-btn tiny" onClick={() => decide(q.id, false)}>驳回</button>
                  </span>
                ) : (
                  <span className={`pill ${q.status === "applied" ? "pill-ok" : q.status === "rejected" ? "pill-bad" : ""}`}>{q.status === "applied" ? "已批准" : q.status === "rejected" ? "已驳回" : "待审批"}</span>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}
      {module === "dashboard" ? (
        <DashboardTab d={data} editable={editable} onSaveRecord={saveRecord} />
      ) : (
        <div className="module-view">
          {(modules.find((m) => m.id === module)?.keys ?? []).map((key) => (
            <section key={key} className="card">
              <h3>{KEY_LABEL[key] ?? fieldLabel(key)}{Array.isArray(data[key]) ? <small className="dim">（{data[key].length} 条）</small> : null}</h3>
              {key === "riskHeatmapData" && data[key]?.cells ? (
                <>
                  <div className="dim" style={{ marginBottom: 8 }}>{data[key].period}{data[key].type ? ` · ${data[key].type}` : ""}（数字为风险分）</div>
                  <HeatGrid cells={data[key].cells} dimensions={data[key].dimensions} />
                  {Array.isArray(data[key].dimensions) ? (
                    <div className="dim" style={{ marginTop: 8, fontSize: 12 }}>
                      维度权重：{data[key].dimensions.map((d) => `${d.name} ${Math.round((d.weight ?? 0) * 100)}%`).join(" · ")}
                    </div>
                  ) : null}
                </>
              ) : (
                <EntityTable value={data[key]} keyName={key} editable={editable} onSaveRecord={saveRecord} />
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
