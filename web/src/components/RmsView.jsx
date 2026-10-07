import React, { useCallback, useEffect, useState } from "react";
import * as api from "../lib/api.js";

const TABS = [
  { id: "overview", label: "总览" },
  { id: "tasks", label: "任务派活" },
  { id: "events", label: "风控事件" },
  { id: "rules", label: "规则中心" },
  { id: "activity", label: "活动流水" },
  { id: "ingest", label: "成员端上报" },
  { id: "employees", label: "AI 员工" },
  { id: "sessions", label: "会话档案" },
];

const LEVEL_META = { info: "info", warning: "warn", critical: "high" };
const LEVEL_LABEL = { info: "提示", warning: "警告", critical: "严重" };
const STATUS_LABEL = { open: "待处置", resolved: "已闭环", active: "在职", suspended: "停用" };
const KIND_LABEL = { tool_error: "工具失败", long_run: "轮次打满", irreversible: "不可逆动作", sensitive_word: "敏感词命中", cost_spike: "成本突增", text_pattern: "自定义文本规则" };
const ACTION_LABEL = { record: "仅记录", alert: "告警", confirm: "需人工确认" };
const BUILTIN_KINDS = new Set(["tool_error", "long_run", "irreversible"]);

function ruleParamsSummary(rule) {
  const p = rule.params ?? {};
  if (Array.isArray(p.words) && p.words.length > 0) return `词表 ${p.words.length} 项`;
  if (Number(p.maxTurnTokens) > 0) return `阈值 ${p.maxTurnTokens} tok/轮`;
  if (typeof p.pattern === "string" && p.pattern !== "") return `正则 /${p.pattern}/`;
  return "内置判定";
}

function Kpi({ label, value, unit, tone }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ? `tone-${tone}` : ""}`}>
        {value}
        {unit ? <span className="stat-unit">{unit}</span> : null}
      </div>
    </div>
  );
}

export default function RmsView() {
  const [tab, setTab] = useState("overview");
  const [overview, setOverview] = useState(null);
  const [events, setEvents] = useState(null);
  const [activity, setActivity] = useState(null);
  const [employees, setEmployees] = useState(null);
  const [sessions, setSessions] = useState(null);
  const [ingest, setIngest] = useState(null);
  const [sessionDetail, setSessionDetail] = useState(null);
  const [rules, setRules] = useState(null);
  const [tasks, setTasks] = useState(null);
  const [employeesForTask, setEmployeesForTask] = useState(null);
  const [newTask, setNewTask] = useState({ title: "", detail: "", assigneeA: "", assigneeB: "" });
  const [editingCode, setEditingCode] = useState(null);
  const [draft, setDraft] = useState({});
  const [showNewRule, setShowNewRule] = useState(false);
  const [newRule, setNewRule] = useState({ code: "", name: "", kind: "sensitive_word", level: "warning", action: "alert", words: "", pattern: "", maxTurnTokens: 60000, description: "" });
  const [evStatus, setEvStatus] = useState("open");
  const [evLevel, setEvLevel] = useState("all");
  const [acType, setAcType] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const results = await Promise.all([
        api.rmsOverview(),
        api.rmsEvents({ status: "all", level: "all", limit: 60 }),
      ]);
      setOverview(results[0]);
      setEvents(results[1]);
    } catch (e) {
      setError(`监管数据读取失败：${String(e?.message ?? e)}`);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    setSessionDetail(null);
    if (tab === "events") {
      api.rmsEvents({ status: evStatus, level: evLevel, limit: 100 }).then(setEvents).catch((e) => console.warn("[load]", String(e?.message ?? e)));
    }
    if (tab === "rules") {
      api.rmsRules().then(setRules).catch((e) => console.warn("[load]", String(e?.message ?? e)));
    }
    if (tab === "tasks") {
      api.rmsTasks({ status: "all", limit: 60 }).then(setTasks).catch((e) => console.warn("[load]", String(e?.message ?? e)));
      api.rmsEmployees().then(setEmployeesForTask).catch((e) => console.warn("[load]", String(e?.message ?? e)));
    }
    if (tab === "activity") {
      api.rmsActivity({ limit: 80, type: acType === "all" ? undefined : acType }).then(setActivity).catch((e) => console.warn("[load]", String(e?.message ?? e)));
    }
    if (tab === "employees") {
      api.rmsEmployees().then(setEmployees).catch((e) => console.warn("[load]", String(e?.message ?? e)));
    }
    if (tab === "sessions") {
      api.rmsConversations({ limit: 60 }).then(setSessions).catch((e) => console.warn("[load]", String(e?.message ?? e)));
    }
    if (tab === "ingest") {
      api.ingestEvents().then((r) => setIngest(r?.events ?? [])).catch((e) => console.warn("[load]", String(e?.message ?? e)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, evStatus, evLevel, acType]);

  const resolve = async (id) => {
    try {
      await api.rmsResolveEvent(id);
      await load();
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  };

  const toggleEmployee = async (emp) => {
    setBusy(true);
    try {
      await api.rmsSetEmployeeStatus(emp.id, emp.status === "suspended" ? "active" : "suspended");
      const list = await api.rmsEmployees();
      setEmployees(list);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const openSession = async (id) => {
    setSessionDetail(await api.rmsConversationDetail(id).catch(() => null));
  };

  const jumpToSession = async (id) => {
    if (!id) return;
    setTab("sessions");
    await openSession(id);
  };

  // ---- 任务派活 ----
  const reloadTasks = async () => setTasks(await api.rmsTasks({ status: "all", limit: 60 }).catch(() => null));

  const createTask = async () => {
    const assignees = [newTask.assigneeA, newTask.assigneeB].filter(Boolean);
    if (newTask.title.trim() === "" || assignees.length === 0) {
      setError("任务需要标题和至少 1 名承接 AI 员工");
      return;
    }
    try {
      await api.rmsCreateTask({ title: newTask.title.trim(), detail: newTask.detail.trim() || null, assignees });
      setNewTask({ title: "", detail: "", assigneeA: "", assigneeB: "" });
      setError("");
      await reloadTasks();
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  };

  const runTask = async (id) => {
    try {
      await api.rmsRunTask(id);
      await reloadTasks();
      setTimeout(reloadTasks, 6000);
      setTimeout(reloadTasks, 20000);
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  };

  // ---- 规则中心 ----
  const reloadRules = async () => setRules(await api.rmsRules().catch(() => null));

  const startEdit = (rule) => {
    const p = rule.params ?? {};
    setEditingCode(rule.code);
    setDraft({
      level: rule.level,
      action: rule.action,
      words: Array.isArray(p.words) ? p.words.join("\n") : "",
      pattern: typeof p.pattern === "string" ? p.pattern : "",
      maxTurnTokens: Number(p.maxTurnTokens) > 0 ? Number(p.maxTurnTokens) : 60000,
    });
  };

  const patchRule = async (code, patch) => {
    try {
      await api.rmsUpdateRule(code, patch);
      await reloadRules();
      setError("");
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  };

  const saveEdit = async (rule) => {
    const patch = { level: draft.level, action: draft.action };
    if (rule.kind === "sensitive_word" || rule.kind === "text_pattern") {
      const words = String(draft.words ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
      if (rule.kind === "sensitive_word" || words.length > 0) patch.params = { ...(rule.params ?? {}), words };
      if (rule.kind === "text_pattern" && String(draft.pattern ?? "").trim() !== "") {
        patch.params = { ...(patch.params ?? rule.params ?? {}), pattern: String(draft.pattern).trim() };
      }
    }
    if (rule.kind === "cost_spike") patch.params = { maxTurnTokens: Number(draft.maxTurnTokens) || 60000 };
    await patchRule(rule.code, patch);
    setEditingCode(null);
  };

  const removeRule = async (code) => {
    try {
      await api.rmsDeleteRule(code);
      await reloadRules();
      setError("");
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  };

  const submitNewRule = async () => {
    const kind = newRule.kind;
    const payload = {
      code: newRule.code.trim().toUpperCase(),
      name: newRule.name.trim(),
      kind,
      level: newRule.level,
      action: newRule.action,
      description: newRule.description.trim() || null,
    };
    if (kind === "sensitive_word" || kind === "text_pattern") {
      const words = String(newRule.words ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
      if (kind === "sensitive_word" && words.length === 0) { setError("敏感词规则至少需要一个词（每行一个）"); return; }
      if (words.length > 0) payload.params = { words };
      if (kind === "text_pattern" && String(newRule.pattern ?? "").trim() !== "") payload.params = { ...(payload.params ?? {}), pattern: newRule.pattern.trim() };
    }
    if (kind === "cost_spike") payload.params = { maxTurnTokens: Number(newRule.maxTurnTokens) || 60000 };
    try {
      await api.rmsCreateRule(payload);
      setShowNewRule(false);
      setNewRule({ code: "", name: "", kind: "sensitive_word", level: "warning", action: "alert", words: "", pattern: "", maxTurnTokens: 60000, description: "" });
      await reloadRules();
      setError("");
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  };

  const o = overview ?? {};
  const stats = [
    { label: "今日会话", value: o?.conversations?.today ?? 0, unit: "场" },
    { label: "会话消息", value: o?.messages?.today ?? 0, unit: "条" },
    { label: "工具调用", value: o?.toolCalls?.total ?? 0, unit: "次", tone: o?.toolCalls?.errors > 0 ? "warn" : "" },
    { label: "工具失败", value: o?.toolCalls?.errors ?? 0, unit: "次", tone: o?.toolCalls?.errors > 0 ? "high" : "ok" },
    { label: "待办未完成", value: o?.todos?.pending ?? 0, unit: "" },
    { label: "待办完成", value: o?.todos?.completed ?? 0, unit: "" },
    { label: "开放风控", value: o?.riskEvents?.open ?? 0, tone: o?.riskEvents?.critical > 0 ? "high" : o?.riskEvents?.open > 0 ? "warn" : "ok" },
    { label: "严重未闭环", value: o?.riskEvents?.critical ?? 0, tone: o?.riskEvents?.critical > 0 ? "high" : "" },
  ];

  return (
    <div className="view-pad rms-view">
      <header className="view-head">
        <h2 className="view-title">AI 员工监管中心</h2>
        <span className="view-sub">SQLite 实时留痕 · 面向企业的 AI 员工风控</span>
        <div className="spacer" />
        <button className="ghost-btn" onClick={load} disabled={busy}>
          {busy ? "刷新中…" : "刷新"}
        </button>
      </header>

      {error ? <div className="msg-error">{error}</div> : null}

      <div className="seg" style={{ marginBottom: 18 }}>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "tasks" && (
        <>
          <section className="card" style={{ marginBottom: 14 }}>
            <h3>新建任务（委派 AI 员工执行；选 2 名即接力协作：A 先产出，B 接续完成）</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 10 }}>
              <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                任务标题
                <input value={newTask.title} onChange={(e) => setNewTask({ ...newTask, title: e.target.value })} placeholder="如：汇总本月审计风险并出周报" />
              </label>
              <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                承接 AI 员工 · 第一棒
                <select value={newTask.assigneeA} onChange={(e) => setNewTask({ ...newTask, assigneeA: e.target.value })}>
                  <option value="">选择…</option>
                  {(employeesForTask ?? []).map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.name}（{emp.model ?? emp.provider_id ?? "未接模型"}）</option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                承接 AI 员工 · 第二棒（可选，接力协作）
                <select value={newTask.assigneeB} onChange={(e) => setNewTask({ ...newTask, assigneeB: e.target.value })}>
                  <option value="">不接力（单人完成）</option>
                  {(employeesForTask ?? []).filter((emp) => emp.id !== newTask.assigneeA).map((emp) => (
                    <option key={emp.id} value={emp.id}>{emp.name}（{emp.model ?? emp.provider_id ?? "未接模型"}）</option>
                  ))}
                </select>
              </label>
            </div>
            <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4, marginTop: 10 }}>
              任务说明（目标 / 边界 / 期望产出）
              <textarea rows={3} value={newTask.detail} onChange={(e) => setNewTask({ ...newTask, detail: e.target.value })} placeholder="可留空；写清可显著提升产出质量" />
            </label>
            <div style={{ marginTop: 10 }}>
              <button className="ghost-btn" onClick={createTask} disabled={newTask.title.trim() === "" || newTask.assigneeA === ""}>创建任务</button>
            </div>
          </section>
          <section className="card">
            <h3>任务列表（{(tasks ?? []).length} 项）</h3>
            {(tasks ?? []).length === 0 ? (
              <div className="chart-empty">暂无任务：在上方委派你的 AI 员工开干</div>
            ) : (
              <div className="alert-list">
                {(tasks ?? []).map((t) => (
                  <div key={t.id} className="alert-row">
                    <span className={`pill ${t.status === "done" ? "pill-ok" : t.status === "running" ? "" : t.status === "failed" ? "pill-bad" : ""}`}>
                      {t.status === "open" ? "待执行" : t.status === "running" ? "执行中" : t.status === "done" ? "已完成" : "失败"}
                    </span>
                    <div className="alert-main">
                      <div className="alert-title">{t.title}</div>
                      <div className="alert-sub">
                        {(t.assignees ?? []).map((a) => (employeesForTask ?? []).find((e) => e.id === a)?.name ?? a).join(" → ")}
                        {" · "}{String(t.created_at ?? "").slice(5, 16)}
                      </div>
                      {t.result_summary ? <div className="alert-sub" style={{ marginTop: 3 }}>{String(t.result_summary).slice(0, 120)}</div> : null}
                      {t.error ? <div className="alert-sub" style={{ color: "#c21d2e" }}>{t.error}</div> : null}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {t.conversation_id ? <button className="ghost-btn tiny" onClick={() => jumpToSession(t.conversation_id)}>查看过程</button> : null}
                      {t.status !== "running" && t.status !== "done" ? <button className="ghost-btn tiny" onClick={() => runTask(t.id)}>执行</button> : null}
                      {t.status === "failed" ? <button className="ghost-btn tiny" onClick={() => runTask(t.id)}>重试</button> : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      {tab === "overview" && (
        <>
          <div className="kpi-row">{stats.map((s, i) => <Kpi key={i} {...s} />)}</div>
          <div className="grid-2">
            <section className="card">
              <h3>待处置风控事件</h3>
              {(o?.recentOpenRisks ?? []).length === 0 ? (
                <div className="chart-empty">当前没有开放的风控事件</div>
              ) : (
                <div className="alert-list">
                  {(o.recentOpenRisks ?? []).map((r) => (
                    <div key={r.id} className="alert-row">
                      <span className={`pill pill-${LEVEL_META[r.level] ?? "info"}`}>{LEVEL_LABEL[r.level] ?? r.level}</span>
                      <div className="alert-main">
                        <div className="alert-title">{r.title}</div>
                        <div className="alert-sub">{r.kind} · {String(r.created_at ?? "").slice(0, 19).replace("T", " ")}</div>
                      </div>
                      <button className="ghost-btn tiny" onClick={() => resolve(r.id)}>闭环</button>
                    </div>
                  ))}
                </div>
              )}
            </section>
            <section className="card">
              <h3>今日 Token 用量</h3>
              <div className="kpi-row" style={{ gridTemplateColumns: "repeat(2,1fr)" }}>
                <Kpi label="今日合计" value={o?.tokens?.today ?? 0} unit="tok" />
                <Kpi label="历史累计" value={(o?.tokens?.prompt ?? 0) + (o?.tokens?.completion ?? 0)} unit="tok" />
              </div>
              <div className="table-more">AI 员工默认 {employees?.length ?? 1} 名；本机 SQLite：{overview?.date ?? ""}</div>
            </section>
          </div>
        </>
      )}

      {tab === "events" && (
        <div className="card">
          <div style={{ display: "flex", gap: 10, marginBottom: 12, alignItems: "center" }}>
            <span className="pill">状态</span>
            {["open", "resolved", "all"].map((s) => (
              <button key={s} className={`ghost-btn tiny ${evStatus === s ? "on" : ""}`} onClick={() => setEvStatus(s)}>
                {s === "open" ? "待处置" : s === "resolved" ? "已闭环" : "全部"}
              </button>
            ))}
            <span className="pill" style={{ marginLeft: 8 }}>级别</span>
            {["all", "critical", "warning", "info"].map((lv) => (
              <button key={lv} className={`ghost-btn tiny ${evLevel === lv ? "on" : ""}`} onClick={() => setEvLevel(lv)}>
                {lv === "all" ? "全部级别" : LEVEL_LABEL[lv]}
              </button>
            ))}
          </div>
          {(events ?? []).length === 0 ? (
            <div className="chart-empty">无匹配风控事件</div>
          ) : (
            <div className="alert-list">
              {(events ?? []).map((e) => (
                <div key={e.id} className="alert-row">
                  <span className={`pill pill-${LEVEL_META[e.level] ?? "info"}`}>{LEVEL_LABEL[e.level] ?? e.level}</span>
                  <div className="alert-main">
                    <div className="alert-title">{e.title}</div>
                    <div className="alert-sub">
                      {e.kind} · 会话 {String(e.conversation_id ?? "-").slice(0, 12)} · {String(e.created_at ?? "").slice(0, 19).replace("T", " ")} · {STATUS_LABEL[e.status]}
                    </div>
                    {e.detail ? <div className="alert-sub" style={{ marginTop: 3 }}>{e.detail}</div> : null}
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    {e.conversation_id ? (
                      <button className="ghost-btn tiny" onClick={() => jumpToSession(e.conversation_id)}>查看会话</button>
                    ) : null}
                    {e.status === "open" ? <button className="ghost-btn tiny" onClick={() => resolve(e.id)}>闭环</button> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "rules" && (
        <>
          <section className="card" style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <h3 style={{ margin: 0 }}>风控规则（{(rules ?? []).length} 条）</h3>
              <span className="dim" style={{ fontSize: 12 }}>
                级别 / 启用 / 词表 / 阈值 / 处置均可配置，保存后即时生效（下一轮对话扫描按新规则执行，命中数实时累计）
              </span>
              <div className="spacer" />
              <button className="ghost-btn" onClick={() => setShowNewRule(!showNewRule)}>{showNewRule ? "收起表单" : "新建规则"}</button>
            </div>
          </section>

          {showNewRule && (
            <section className="card" style={{ marginBottom: 14 }}>
              <h3>新建自定义规则</h3>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 10 }}>
                <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  规则代码（字母开头）
                  <input value={newRule.code} placeholder="如 C_TRADE_SECRET" onChange={(ev) => setNewRule({ ...newRule, code: ev.target.value })} />
                </label>
                <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  规则名称
                  <input value={newRule.name} placeholder="如 商业机密外发" onChange={(ev) => setNewRule({ ...newRule, name: ev.target.value })} />
                </label>
                <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  类型
                  <select value={newRule.kind} onChange={(ev) => setNewRule({ ...newRule, kind: ev.target.value })}>
                    <option value="sensitive_word">敏感词命中</option>
                    <option value="text_pattern">自定义文本规则（词表/正则）</option>
                    <option value="cost_spike">成本突增</option>
                  </select>
                </label>
                <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  级别
                  <select value={newRule.level} onChange={(ev) => setNewRule({ ...newRule, level: ev.target.value })}>
                    {Object.entries(LEVEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  处置动作
                  <select value={newRule.action} onChange={(ev) => setNewRule({ ...newRule, action: ev.target.value })}>
                    {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
                <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                  说明（可选）
                  <input value={newRule.description} onChange={(ev) => setNewRule({ ...newRule, description: ev.target.value })} />
                </label>
              </div>
              {(newRule.kind === "sensitive_word" || newRule.kind === "text_pattern") && (
                <div style={{ display: "grid", gridTemplateColumns: newRule.kind === "text_pattern" ? "1fr 1fr" : "1fr", gap: 10, marginTop: 10 }}>
                  <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                    词表（每行一个，命中任一即触发）
                    <textarea rows={4} value={newRule.words} placeholder={"商业机密\n客户名单\n源代码外发"} onChange={(ev) => setNewRule({ ...newRule, words: ev.target.value })} />
                  </label>
                  {newRule.kind === "text_pattern" && (
                    <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4 }}>
                      正则（可选，与词表取并集）
                      <input value={newRule.pattern} placeholder="如 (工资单|期权协议)" onChange={(ev) => setNewRule({ ...newRule, pattern: ev.target.value })} />
                    </label>
                  )}
                </div>
              )}
              {newRule.kind === "cost_spike" && (
                <label style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 4, marginTop: 10, maxWidth: 220 }}>
                  阈值（token / 轮）
                  <input type="number" value={newRule.maxTurnTokens} onChange={(ev) => setNewRule({ ...newRule, maxTurnTokens: Number(ev.target.value) })} />
                </label>
              )}
              <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                <button className="ghost-btn" onClick={submitNewRule}>创建规则</button>
                <button className="ghost-btn" onClick={() => setShowNewRule(false)}>取消</button>
              </div>
            </section>
          )}

          <section className="card">
            <div className="table-wrap">
              <table className="entity-table">
                <thead>
                  <tr><th>代码</th><th>名称</th><th>类型</th><th>级别</th><th>处置</th><th>参数</th><th>命中</th><th>状态</th><th /></tr>
                </thead>
                <tbody>
                  {(rules ?? []).map((r) =>
                    editingCode === r.code ? (
                      <tr key={r.code}>
                        <td colSpan={9}>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", padding: "4px 0" }}>
                            <span style={{ fontSize: 12 }}>编辑 {r.code} · {r.name}</span>
                            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                              级别
                              <select value={draft.level} onChange={(ev) => setDraft({ ...draft, level: ev.target.value })}>
                                {Object.entries(LEVEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                              </select>
                            </label>
                            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                              处置
                              <select value={draft.action} onChange={(ev) => setDraft({ ...draft, action: ev.target.value })}>
                                {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                              </select>
                            </label>
                            {(r.kind === "sensitive_word" || r.kind === "text_pattern") && (
                              <>
                                <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                                  词表
                                  <textarea rows={3} style={{ minWidth: 240 }} value={draft.words} onChange={(ev) => setDraft({ ...draft, words: ev.target.value })} />
                                </label>
                                {r.kind === "text_pattern" && (
                                  <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                                    正则
                                    <input style={{ minWidth: 160 }} value={draft.pattern} onChange={(ev) => setDraft({ ...draft, pattern: ev.target.value })} />
                                  </label>
                                )}
                              </>
                            )}
                            {r.kind === "cost_spike" && (
                              <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                                阈值（tok/轮）
                                <input type="number" style={{ width: 110 }} value={draft.maxTurnTokens} onChange={(ev) => setDraft({ ...draft, maxTurnTokens: Number(ev.target.value) })} />
                              </label>
                            )}
                            {BUILTIN_KINDS.has(r.kind) ? <span className="dim" style={{ fontSize: 12 }}>内置判定逻辑，可调级别与处置</span> : null}
                            <button className="ghost-btn tiny" onClick={() => saveEdit(r)}>保存</button>
                            <button className="ghost-btn tiny" onClick={() => setEditingCode(null)}>取消</button>
                          </div>
                        </td>
                      </tr>
                    ) : (
                      <tr key={r.code} style={{ opacity: r.enabled ? 1 : 0.55 }}>
                        <td>{r.code}</td>
                        <td>{r.name}</td>
                        <td>{KIND_LABEL[r.kind] ?? r.kind}</td>
                        <td><span className={`pill pill-${LEVEL_META[r.level] ?? "info"}`}>{LEVEL_LABEL[r.level] ?? r.level}</span></td>
                        <td>{ACTION_LABEL[r.action] ?? r.action}</td>
                        <td className="dim">{ruleParamsSummary(r)}</td>
                        <td>{r.hit_count}</td>
                        <td>{r.enabled ? <span className="pill pill-ok">启用</span> : <span className="pill">停用</span>}</td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          <button className="ghost-btn tiny" onClick={() => patchRule(r.code, { enabled: !r.enabled })}>{r.enabled ? "停用" : "启用"}</button>{" "}
                          <button className="ghost-btn tiny" onClick={() => startEdit(r)}>编辑</button>
                          {r.code.startsWith("R_") ? null : (
                            <>
                              {" "}
                              <button className="ghost-btn tiny" onClick={() => removeRule(r.code)}>删除</button>
                            </>
                          )}
                        </td>
                      </tr>
                    ),
                  )}
                </tbody>
              </table>
            </div>
            {(rules ?? []).length === 0 ? <div className="chart-empty">规则加载中或为空</div> : null}
          </section>
        </>
      )}

      {tab === "activity" && (
        <div className="card">
          <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
            <button className={`ghost-btn tiny ${acType === "all" ? "on" : ""}`} onClick={() => setAcType("all")}>全部</button>
            <button className={`ghost-btn tiny ${acType === "tool" ? "on" : ""}`} onClick={() => setAcType("tool")}>仅工具调用</button>
          </div>
          {(activity ?? []).length === 0 ? (
            <div className="chart-empty">暂无活动（开始对话后自动产生）</div>
          ) : (
            <div className="table-wrap">
              <table className="entity-table">
                <thead>
                  <tr><th>时间</th><th>类型</th><th>会话</th><th>主体</th><th>内容 / 工具</th><th>结果</th></tr>
                </thead>
                <tbody>
                  {(activity ?? []).map((a) => (
                    <tr key={`${a.kind}-${a.id}`}>
                      <td>{String(a.created_at ?? "").slice(5, 19).replace("T", " ")}</td>
                      <td>{a.kind === "tool" ? "工具" : a.role === "user" ? "用户" : "助手"}</td>
                      <td>{String(a.conversation_id ?? "-").slice(0, 10)}</td>
                      <td>{a.kind === "tool" ? a.tool_name : a.role}</td>
                      <td>{(a.content ?? a.result ?? "").slice(0, 90)}</td>
                      <td>{a.kind === "tool" ? (a.is_error ? "✗ 失败" : "✓") : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === "employees" && (
        <div className="server-grid">
          {(employees ?? []).map((emp) => (
            <section key={emp.id} className={`server-card ${emp.status === "suspended" ? "down" : ""}`}>
              <div className="server-top">
                <span className={`dot ${emp.status === "active" ? "ok" : "bad"}`} />
                <div className="server-name">
                  <strong>{emp.name}</strong>
                  <small>{emp.role}{emp.model ? ` · ${emp.model}` : ""}</small>
                </div>
              </div>
              <div className="conflict-row" style={{ marginTop: 10 }}>
                <span className="pill">{STATUS_LABEL[emp.status]}</span>
                <span className="pill">{emp.conversation_count} 场会话</span>
                <span className={`pill ${emp.open_risks > 0 ? "pill-bad" : "pill-ok"}`}>{emp.open_risks} 条未闭环</span>
              </div>
              <button className="ghost-btn block" disabled={busy} onClick={() => toggleEmployee(emp)}>
                {emp.status === "suspended" ? "恢复在职" : "停用该员工"}
              </button>
            </section>
          ))}
          {(employees ?? []).length === 0 ? <div className="chart-empty">暂无 AI 员工档案</div> : null}
        </div>
      )}

      {tab === "ingest" && (
        <section className="card" style={{ marginBottom: 14 }}>
          <h3>留痕上报 <small className="dim">（跨实例使用留痕回传 · 最近 50 条）</small></h3>
          {(ingest ?? []).length === 0 ? (
            <div className="chart-empty">暂无上报记录（成员端需配置 VFLETCH_REPORT_URL / VFLETCH_REPORT_KEY）</div>
          ) : (
            <div className="alert-list">
              {ingest.map((ev, i) => (
                <div key={i} className="conflict-row" style={{ alignItems: "flex-start" }}>
                  <span className="pill">{ev.kind}</span>
                  <div className="conflict-msg">
                    <strong>{ev.subject}</strong> · {ev.summary}
                    {ev.detail ? <div className="alert-sub">工具：{(() => { try { return JSON.parse(ev.detail).tools.join("、"); } catch { return ""; } })()}</div> : null}
                  </div>
                  <span className="dim small">{(ev.happenedAt || "").slice(5, 16)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {tab === "sessions" && (
        <>
          {sessionDetail ? (
            <div className="card">
              <h3 style={{ display: "flex", alignItems: "center" }}>
                会话档案：{sessionDetail.title ?? sessionDetail.id}
                <span className="pill" style={{ marginLeft: 8 }}>{sessionDetail.message_count} 消息 · {sessionDetail.tool_count} 工具</span>
                <button className="ghost-btn tiny" style={{ marginLeft: "auto" }} onClick={() => setSessionDetail(null)}>返回列表</button>
              </h3>
              {(sessionDetail.messages ?? []).map((m, i) => (
                <div key={`m${i}`} className="conflict-row" style={{ alignItems: "flex-start" }}>
                  <span className="pill">{m.role === "user" ? "用户" : "助手"}</span>
                  <div className="conflict-msg">
                    {m.content}
                    {m.reasoning ? <div className="alert-sub" style={{ marginTop: 4 }}>思考：{(m.reasoning ?? "").slice(0, 220)}</div> : null}
                  </div>
                </div>
              ))}
              {(sessionDetail.tools ?? []).length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <h4 style={{ margin: "10px 0 6px" }}>工具调用明细（{(sessionDetail.tools ?? []).length} 次）</h4>
                  <div className="table-wrap">
                    <table className="entity-table">
                      <thead><tr><th>时间</th><th>工具</th><th>参数</th><th>结果</th><th>状态</th></tr></thead>
                      <tbody>
                        {(sessionDetail.tools ?? []).map((t, i) => (
                          <tr key={`t${i}`}>
                            <td>{String(t.created_at ?? "").slice(5, 19).replace("T", " ")}</td>
                            <td>{t.tool_name}</td>
                            <td title={String(t.arguments ?? "")}>{String(t.arguments ?? "").slice(0, 70) || "—"}</td>
                            <td title={String(t.result ?? "")}>{String(t.result ?? "").slice(0, 90) || "—"}</td>
                            <td>{t.is_error ? "✗ 失败" : "✓"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          ) : null}
          <div className="card">
            <h3>会话列表（按时间倒序）</h3>
            {(sessions ?? []).length === 0 ? (
              <div className="chart-empty">暂无会话档案（开始对话后写入 SQLite）</div>
            ) : (
              <div className="table-wrap">
                <table className="entity-table">
                  <thead><tr><th>开始时间</th><th>标题</th><th>会话</th><th>消息</th><th>工具</th><th>状态</th><th /></tr></thead>
                  <tbody>
                    {(sessions ?? []).map((s) => (
                      <tr key={s.id}>
                        <td>{String(s.started_at ?? "").slice(5, 19).replace("T", " ")}</td>
                        <td>{s.title ?? "-"}</td>
                        <td>{String(s.id).slice(0, 12)}</td>
                        <td>{s.message_count}</td>
                        <td>{s.tool_count}</td>
                        <td>{STATUS_LABEL[s.status] ?? s.status}</td>
                        <td><button className="ghost-btn tiny" onClick={() => openSession(s.id)}>查看</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
