import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { streamChat, getSuggestions, polishPrompt, generateImageDirect, teamEmployees, chatConfirm } from "../lib/api.js";
import RichText from "./RichText.jsx";
import WorkflowPanel from "./WorkflowPanel.jsx";
import { uploadFile } from "../lib/api.js";

/** 欢迎页默认卡片（接口失败或无使用数据时的兜底） */
const FALLBACK_SUGGESTIONS = [
  { title: "审计风控总览 + 风险分布图", prompt: "当前审计风控总览是什么情况？高风险告警有哪些？用图表展示风险分布", tag: "推荐" },
  { title: "联网查政策并表格化", prompt: "联网查一下最近关于研发费用加计扣除的政策要点，并整理成表格", tag: "推荐" },
  { title: "本地跑 Python 测算", prompt: "用 Python 计算一组等额本息还款的月供与总利息，本金 120 万，年利率 4.2%，30 年", tag: "推荐" },
  { title: "列出审计任务与进度", prompt: "列出所有审计任务及其进度", tag: "推荐" },
];

// 会话按账号隔离：同一台机器换账号登录时，绝不能看到上一个账号的对话列表
function sessionKey(userId) {
  return `vfletch.sessions.${String(userId ?? "anon").replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * 生成"本用户唯一"的会话 id。
 * 修复（多账号共用同一共享库时点推荐话题/发消息报「无权访问该会话：会话属于其他用户」）：
 * 旧版本默认会话 id 写死为 "s1"，而服务端 conversations 表按 owner_user_id 做归属校验 ——
 * 只要共享库里已存在 s1（例如主控此前用默认会话发过一条），任何**新账号/新浏览器**首次发消息
 * 都会撞上别人占用的 s1 而被 403 拒绝。会话 id 必须带账号与时间戳，不能是全局固定值。
 */
function newSessionId(userId) {
  const u = String(userId ?? "anon").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || "anon";
  return `s_${u}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 旧版本遗留的全局固定会话 id（不可再用于新会话） */
const LEGACY_SHARED_SESSION_IDS = new Set(["s1", "s", "new", "default"]);

/** 首次装载时把遗留的固定 id 迁移为"本用户唯一"的新 id（本地历史一条不丢，只是换 id） */
function migrateLegacySessionIds(list, userId) {
  if (!Array.isArray(list)) return list;
  return list.map((s) =>
    s != null && LEGACY_SHARED_SESSION_IDS.has(String(s.id)) ? { ...s, id: newSessionId(userId) } : s,
  );
}
function readSessionStorage(userId) {
  try {
    const raw = localStorage.getItem(sessionKey(userId));
    if (raw) return JSON.parse(raw);
    // 兼容：老版本未分账号的存储。全局只迁移一次（标记 vfletch.sessions.migrated），
    // 否则同一台机器的第二个登录账号会把第一个账号的旧会话再"继承"一遍（隐私泄漏）
    if (localStorage.getItem("vfletch.sessions.migrated") === "1") return null;
    const legacy = localStorage.getItem("vfletch.sessions");
    if (legacy) {
      const migrated = JSON.parse(legacy);
      try { localStorage.setItem("vfletch.sessions.migrated", "1"); } catch {}
      return migrated;
    }
    return null;
  } catch {
    return null;
  }
}

// 落盘（带配额保护）：溢出时先丢最旧会话并截断工具长文本，绝不让异常中断对话
function persistSessions(userId, all) {
  // 空壳会话（从未发过消息的"新对话"）不落盘，避免刷新后侧边栏堆积一排"新对话"；当前使用中的内存态不受影响
  const sessions = all.filter((s, i) => (s.items?.length ?? 0) > 0 || i === 0);
  try {
    localStorage.setItem(sessionKey(userId), JSON.stringify(sessions));
  } catch {
    try {
      const slim = sessions.slice(0, 20).map((s) => ({
        ...s,
        items: s.items.map((i) =>
          i.kind === "tool" && i.text ? { ...i, text: String(i.text).slice(0, 2000) } : i,
        ),
      }));
      localStorage.setItem(sessionKey(userId), JSON.stringify(slim));
    } catch {
      // 放弃持久化（内存态继续可用，不影响本轮对话）
    }
  }
}

/** 工具分类与 ZCode 式行标签 */
function classifyTool(name) {
  const n = String(name ?? "");
  if (/todo_write/i.test(n)) return "todo";
  if (/code_run|python|bash|shell|terminal/i.test(n)) return "terminal";
  if (/write_file|edit_file|str_replace|create_file|rename|move_file/i.test(n)) return "edit";
  if (/read_file|list_directory|search_files|directory_tree|get_file_info/i.test(n)) return "file";
  if (/web_search/i.test(n)) return "search";
  if (/web_fetch|fetch/i.test(n)) return "fetch";
  if (/image_generate/i.test(n)) return "image";
  if (/delegate_agent/i.test(n)) return "delegate";
  if (/memory/i.test(n)) return "memory";
  if (/audit/i.test(n)) return "audit";
  return "generic";
}

const TOOL_META = {
  terminal: { icon: "M4 17l6-5-6-5M12 19h8", label: "Run" },
  edit: { icon: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z", label: "Edit" },
  file: { icon: "M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zM14 2v6h6", label: "Read" },
  search: { icon: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.3-4.3", label: "Search" },
  fetch: { icon: "M12 2a10 10 0 100 20 10 10 0 000-20zM2 12h20M12 2a15 15 0 010 20 15 15 0 010-20", label: "Fetch" },
  image: { icon: "M3 5h18v14H3zM3 15l5-5 4 4 3-3 6 6", label: "Image" },
  delegate: { icon: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9", label: "Delegate" },
  memory: { icon: "M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z", label: "Memory" },
  audit: { icon: "M9 12l2 2 4-4M5 3h14v18l-7-3-7 3z", label: "Audit" },
  todo: { icon: "M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11", label: "Todo" },
  generic: { icon: "M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4", label: "Tool" },
};

function toolSummary(type, item) {
  const a = item.arguments ?? {};
  if (type === "terminal") {
    const code = String(a.code ?? a.script ?? a.command ?? "");
    const first = code.split("\n").find((l) => l.trim() !== "") ?? "";
    return `Python${first ? ` · ${first.trim().slice(0, 42)}` : ""}`;
  }
  if (type === "edit") return `${a.path ?? a.file ?? "文件"}（写入/修改）`;
  if (type === "file") return String(a.path ?? a.dir ?? a.pattern ?? "文件/目录");
  if (type === "search") return `"${String(a.query ?? a.q ?? "").slice(0, 30)}"`;
  if (type === "fetch") return String(a.url ?? "").slice(0, 46);
  if (type === "image") return String(a.prompt ?? a.prompt_text ?? "生成图片").slice(0, 40);
  if (type === "delegate") return `${a.role ?? "子代理"} · ${String(a.task ?? a.goal ?? "").slice(0, 30)}`;
  if (type === "memory") return String(a.key ?? a.query ?? "");
  if (type === "todo") return `任务清单（${(a.tasks ?? []).length} 项）`;
  const keys = Object.keys(a);
  return keys.length > 0 ? `${keys[0]}: ${String(a[keys[0]]).slice(0, 30)}` : item.name;
}

/** ZCode 式工具行：图标 + 动作标签 + 摘要 + 状态，点击展开参数与结果（item 引用不变则跳过重渲染） */
const ToolRow = memo(function ToolRow({ item }) {
  const [open, setOpen] = useState(false);
  const [deciding, setDeciding] = useState(false);
  const [confirmErr, setConfirmErr] = useState(null);
  const type = classifyTool(item.name);
  const meta = TOOL_META[type] ?? TOOL_META.generic;
  const resultText = item.text ?? "";
  const decide = async (approve) => {
    if (deciding || !item.confirmId) return;
    setDeciding(true);
    setConfirmErr(null);
    try {
      await chatConfirm(item.confirmId, approve);
      // 裁决结果由 confirm_result SSE 事件回流更新该行
    } catch (e) {
      setConfirmErr(String(e?.message ?? e));
      setDeciding(false);
    }
  };
  const codePreview = typeof item.arguments?.code === "string" ? item.arguments.code : "";
  return (
    <div className={`z-tool ${item.isError ? "err" : ""}`}>
      <button className="z-tool-row" onClick={() => setOpen((v) => !v)}>
        <span className="z-tool-icon">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"><path d={meta.icon} /></svg>
        </span>
        <span className="z-tool-label">{meta.label}</span>
        <span className="z-tool-summary">{toolSummary(type, item)}</span>
        <span className={`z-tool-status ${item.running ? "run" : item.isError ? "fail" : "ok"}`}>
          {item.running ? <span className="z-spin" /> : item.isError ? "✗" : "✓"}
        </span>
        <span className={`z-tool-chev ${open ? "open" : ""}`}>▾</span>
      </button>
      {item.needsConfirm ? (
        <div className="z-confirm">
          <div className="z-confirm-title">⚠️ 事中拦截：即将执行 {item.arguments?.language === "python" ? "Python" : "代码"}，需要你的批准</div>
          {codePreview ? <pre className="z-confirm-code">{codePreview.slice(0, 600)}</pre> : null}
          <div className="z-confirm-actions">
            <button className="z-confirm-allow" disabled={deciding} onClick={() => decide(true)}>批准执行</button>
            <button className="z-confirm-deny" disabled={deciding} onClick={() => decide(false)}>拒绝</button>
            <span className="z-confirm-hint">{Math.round((item.timeoutMs ?? 120000) / 1000)} 秒内未处理将自动拒绝</span>
          </div>
          {confirmErr ? <div className="z-confirm-err">{confirmErr}</div> : null}
        </div>
      ) : null}
      {item.confirmResolved ? (
        <div className={`z-confirm-res ${item.confirmApproved ? "ok" : "no"}`}>
          {item.confirmApproved ? "✓ 已批准，继续执行" : `✗ 已拒绝${item.confirmNote ? `（${item.confirmNote}）` : ""}`}
        </div>
      ) : null}
      {open && (
        <div className="z-tool-detail">
          <div className="z-detail-title">参数</div>
          <pre className="z-pre">{JSON.stringify(item.arguments ?? {}, null, 2)}</pre>
          {resultText ? (
            <>
              <div className="z-detail-title">{item.isError ? "错误输出" : "结果"}</div>
              <pre className={`z-pre ${item.isError ? "z-pre-err" : ""}`}>{String(resultText).slice(0, 4000)}</pre>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
});

/** ZCode 式思考块 */
function ThinkingBlock({ text, active }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`z-think ${active ? "active" : ""}`}>
      <button className="z-think-head" onClick={() => setOpen((v) => !v)}>
        <span className="z-think-label">{active ? "Thinking" : "Thought"}</span>
        <span className="z-think-hint">{active ? "思考中…" : `${String(text ?? "").length} 字 · 点击展开`}</span>
        <span className={`z-tool-chev ${open ? "open" : ""}`}>▾</span>
      </button>
      {open && <pre className="z-think-text">{text}</pre>}
    </div>
  );
}

// 步骤条目比较：未变更的条目保持引用不变（流式只替换最后一条），逐项比对即可跳过历史回合的重渲染
function stepsEqual(prev, next) {
  return prev.steps === next.steps ||
    (prev.steps.length === next.steps.length && prev.steps.every((s, i) => s === next.steps[i]));
}

/** 一个 Agent 回合：头部（身份+状态）→ 思考 → 工具行 → 任务清单 → 最终回答 */
const AgentTurn = memo(function AgentTurn({ steps }) {
  const streaming = steps.some((s) => s._streaming);
  const assistantMsgs = steps.filter((s) => s.role === "assistant");
  const thinkingMsg = assistantMsgs.find((m) => m.reasoning);
  const finalMsg = [...assistantMsgs].reverse().find((m) => m.content);
  const tools = steps.filter((s) => s.kind === "tool" && !String(s.name ?? "").includes("todo_write"));
  const lastTodo = [...steps].reverse().find((s) => s.kind === "tool" && String(s.name ?? "").includes("todo_write"));
  const anyRunning = steps.some((s) => s.kind === "tool" && s.running);
  const isActive = streaming || anyRunning;
  return (
    <div className="z-turn">
      <div className="z-turn-head">
        <span className={`gk-avatar gk-avatar-sm ${isActive ? "busy" : ""}`}>
          <img src="/vf-logo.png" alt="" width={12} height={12} draggable={false} />
        </span>
        <span className="z-turn-name">V-Fletch 办公体</span>
        <span className={`z-turn-status ${isActive ? "run" : "done"}`}>
          {isActive ? "Working" : "完成"}
        </span>
      </div>
      <div className="z-turn-body">
        {thinkingMsg?.reasoning ? (
          <ThinkingBlock text={thinkingMsg.reasoning} active={streaming && !finalMsg} />
        ) : null}
        {tools.map((t, i) => <ToolRow key={`${t.id}-${i}`} item={t} />)}
        {lastTodo || tools.length > 0 ? (
          <WorkflowPanel
            tasks={lastTodo?.arguments?.tasks ?? []}
            tools={steps.filter((s) => s.kind === "tool" && !String(s.name ?? "").includes("todo_write"))}
          />
        ) : null}
        {finalMsg ? (
          isActive ? (
            /* 流式期间：纯文本渲染（零解析成本），不触发 Markdown 管线 */
            <div className="z-answer z-answer-streaming"><pre className="z-stream-text">{finalMsg.content}</pre></div>
          ) : (
            /* 完成后：完整 Markdown 渲染（表格/图表/代码高亮） */
            <div className="z-answer"><RichText content={finalMsg.content} /></div>
          )
        ) : streaming ? (
          <div className="z-waiting">…</div>
        ) : null}
      </div>
    </div>
  );
}, stepsEqual);

/** 上下文窗口选择（300k–1M tokens，用户可选） */
const WINDOW_CHOICES = [
  { value: 300000, label: "300k" },
  { value: 500000, label: "500k" },
  { value: 800000, label: "800k" },
  { value: 1000000, label: "1M" },
];

function WindowPicker({ value, onSelect }) {
  return (
    <label className="win-picker" title="上下文窗口（tokens）：超出时自动省略更早的消息">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <rect x="3" y="7" width="18" height="10" rx="2" /><path d="M7 7V5m10 2V5M7 19v-2m10 2v-2" />
      </svg>
      <select
        className="win-select"
        value={value}
        onChange={(e) => onSelect(Number(e.target.value))}
      >
        {WINDOW_CHOICES.map((w) => (
          <option key={w.value} value={w.value}>{w.label}</option>
        ))}
      </select>
    </label>
  );
}

/** 输入框左侧的模型选择器（默认项在上、自定义项在下） */
function ModelPicker({ providers, active, onSelect, onManage }) {  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const activeInfo = providers.find((p) => p.id === active) ?? providers[0];

  return (
    <div className="model-picker" ref={wrapRef}>
      <button className="model-pill" onClick={() => setOpen((v) => !v)} title="切换模型（仅对当前对话生效；全局默认请在设置页修改）">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="12" cy="12" r="3" /><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6l2.1 2.1m0-12.8l-2.1 2.1M7.7 16.3l-2.1 2.1" />
        </svg>
        <span className="model-pill-name">{activeInfo?.label ?? "选择模型"}</span>
        <span className={`chev ${open ? "up" : ""}`}>▾</span>
      </button>
      {open && (
        <div className="model-pop">
          <div className="pop-group-label">模型（VF 前台内置 · 其余来自模型 API）</div>
          {providers.map((p) => (
            <button key={p.id} className={`pop-item ${p.id === active ? "on" : ""}`} onClick={() => { onSelect(p.id); setOpen(false); }}>
              <span className="pop-check">{p.id === active ? "✓" : ""}</span>
              <span className="pop-name">{p.label}</span>
              <span className="pop-model">{p.model || "未填"}</span>
            </button>
          ))}
          <div className="pop-foot">
            <button className="link" onClick={() => { setOpen(false); onManage?.(); }}>管理模型 API</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ChatView({ models, mcp, role, userId, onOpenMcp, onOpenSettings }) {
  const [sessions, setSessions] = useState(() => {
    const stored = readSessionStorage(userId);
    const list = Array.isArray(stored) && stored.length > 0 ? stored : null;
    // 遗留固定 id（如 "s1"）在装载时迁移为"本用户唯一"，避免被共享库里他人占用的会话 id 撞 403
    return migrateLegacySessionIds(list, userId) ?? [{ id: newSessionId(userId), title: "新对话", items: [] }];
  });
  const [currentId, setCurrentId] = useState(() => sessions[0]?.id ?? newSessionId(userId));
  const [input, setInput] = useState("");
  // 运行状态按会话隔离：多个会话可同时流式执行（一个人同时指挥多名 AI 员工），互不阻塞、互不误杀
  const [runningIds, setRunningIds] = useState({});
  const abortersRef = useRef({}); // sessionId -> AbortController
  const activeRef = useRef(new Set()); // 正在发送中的 sessionId（同步判定，避免 state 延迟导致重复发送）
  const [polishing, setPolishing] = useState(false);
  const [polishNote, setPolishNote] = useState("");
  const [showImagePanel, setShowImagePanel] = useState(false);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [myEmployees, setMyEmployees] = useState([]);
  const [employeeSel, setEmployeeSel] = useState("");
  // 主控专属：AI 秘书模式（系统只读全权限：全库查询/系统状态/文件读取，不可写）
  const [secretaryMode, setSecretaryMode] = useState(() => localStorage.getItem("vfletch.secretaryMode") === "1");
  useEffect(() => { localStorage.setItem("vfletch.secretaryMode", secretaryMode ? "1" : "0"); }, [secretaryMode]);
  const [providerId, setProviderId] = useState(null);
  const [contextWindow, setContextWindow] = useState(() => {
    const saved = Number(localStorage.getItem("vfletch.contextWindow"));
    return saved >= 300000 && saved <= 1000000 ? saved : 300000;
  });
  const listEndRef = useRef(null);
  const persistTimerRef = useRef(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const running = !!runningIds[currentId];
  const setSessionRunning = useCallback((id, on) => {
    setRunningIds((prev) => {
      if (on) return prev[id] ? prev : { ...prev, [id]: true };
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  useEffect(() => {
    localStorage.setItem("vfletch.contextWindow", String(contextWindow));
  }, [contextWindow]);

  // 成员视角：自己的 AI 员工列表（选择后按该员工的 API 与身份对话）
  // hmr 案例修复：此前只在挂载时拉一次，成员在「组织」页新建 AI 员工后对话页下拉里看不到 → "建了用不了"。
  // 现在：组织页变更后广播事件即时刷新 + 每 60s 兜底刷新。
  const loadMyEmployees = useCallback(() => {
    if (role === "boss") { setMyEmployees([]); return; }
    teamEmployees().then((list) => setMyEmployees(Array.isArray(list) ? list : [])).catch((e) => console.warn("[load]", String(e?.message ?? e)));
  }, [role]);
  useEffect(() => {
    loadMyEmployees();
    const onChanged = () => loadMyEmployees();
    window.addEventListener("vfletch:employees-changed", onChanged);
    const timer = setInterval(loadMyEmployees, 60000);
    return () => { window.removeEventListener("vfletch:employees-changed", onChanged); clearInterval(timer); };
  }, [loadMyEmployees]);
  // 已选员工被转走/删除时自动回退到公共模型，避免发送 403
  useEffect(() => {
    if (employeeSel !== "" && myEmployees.length > 0 && !myEmployees.some((e) => e.id === employeeSel)) setEmployeeSel("");
  }, [myEmployees, employeeSel]);

  // 快捷指令：按使用数据实时生成（每次进入对话页拉取；点击刷新可换一批）
  const [suggestions, setSuggestions] = useState(FALLBACK_SUGGESTIONS);
  const suggestOffsetRef = useRef(0);
  const refreshSuggestions = useCallback(() => {
    const offset = suggestOffsetRef.current;
    suggestOffsetRef.current += 1; // 每点一次"换一批"轮转到下一批候选
    getSuggestions({ limit: 4, offset })
      .then((list) => { if (Array.isArray(list) && list.length > 0) setSuggestions(list); })
      .catch((e) => console.warn("[load]", String(e?.message ?? e)));
  }, []);
  useEffect(() => { refreshSuggestions(); }, [refreshSuggestions]);

  const current = sessions.find((s) => s.id === currentId) ?? sessions[0];
  // 防冻结：超长回复只渲染尾部 30K（完整内容仍持久化，导出可查）
  const DISPLAY_CAP = 30_000;
  // 防御性扁平化：/api/models 的 providers 理应为数组（2026-09-10 已修复服务端），此处兼容数组/对象两种形状
  const providersRaw = models?.providers ?? [];
  const providers = Array.isArray(providersRaw) ? providersRaw : Object.values(providersRaw);
  const activeProvider = providerId ?? (providers.some((p) => p.id === models?.active) ? models.active : providers[0]?.id) ?? "vf";

  useEffect(() => {
    // 持久化（防抖）：流式每个分片都会更新 sessions，逐次全量 stringify+落盘会在长对话/多会话下卡死 UI；
    // 改为 800ms 静默合并写一次，内存态始终最新，卸载时兜底落盘（见下方 unmount effect）。
    if (persistTimerRef.current != null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistSessions(userId, sessions);
    }, 800);
  }, [sessions, userId]);

  // 卸载/切页兜底：清掉挂起的定时器并立即落盘最新态
  useEffect(() => () => {
    if (persistTimerRef.current != null) clearTimeout(persistTimerRef.current);
    persistSessions(userId, sessionsRef.current);
  }, [userId]);

  // 关窗/关标签兜底：Electron 直接销毁 webContents 时不会触发 React 卸载，beforeunload 同步落盘
  // （只在此刻写一次，一次性 stringify 成本可接受）
  useEffect(() => {
    const flush = () => {
      if (persistTimerRef.current != null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
        persistSessions(userId, sessionsRef.current);
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [current?.items?.length, running]);

  const patchSession = useCallback((id, updater) => {
    setSessions((all) => all.map((s) => (s.id === id ? updater(s) : s)));
  }, []);

  // ---- 消息队列（按会话隔离）：某会话运行中可排队 ≤8 条，可编辑/删除，该会话完成后自动发送下一条 ----
  const MAX_QUEUE = 8;
  const [queues, setQueues] = useState({}); // sessionId -> [{id,text}]
  const [editingQ, setEditingQ] = useState(null);
  const [editingQText, setEditingQText] = useState("");
  const queuesRef = useRef({});
  queuesRef.current = queues;
  const queue = queues[currentId] ?? [];
  const setQueue = useCallback((updater, sid) => {
    setQueues((all) => {
      const key = sid ?? currentId;
      const prev = all[key] ?? [];
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next.length === 0) {
        if (!(key in all)) return all;
        const rest = { ...all };
        delete rest[key];
        return rest;
      }
      return { ...all, [key]: next };
    });
  }, [currentId]);

  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const MAX_UPLOAD = 10 * 1024 * 1024;
  const handleFiles = async (fileList) => {
    for (const file of fileList) {
      if (file.size > MAX_UPLOAD) { window.alert(`「${file.name}」超过 10MB 上限（${(file.size / 1048576).toFixed(1)}MB），请压缩或拆分后再上传`); continue; }
      setUploading(true);
      try {
        const r = await uploadFile(file);
        setAttachments((prev) => [...prev.slice(-3), r]);
      } catch (e) {
        window.alert(`上传失败：${String(e?.message ?? e)}`);
      } finally {
        setUploading(false);
      }
    }
  };

  const send = async (overrideText, targetSessionId, _autoDepth = 0) => {
    const text = String(overrideText ?? input).trim();
    if (text === "") return false;
    // 目标会话：队列续发时绑定原会话；普通发送用当前会话
    const id = targetSessionId ?? current.id;
    const target = sessionsRef.current.find((s) => s.id === id);
    if (target == null) return false;
    if (activeRef.current.has(id)) {
      // 该会话正在执行：进入该会话自己的队列（不影响其他会话）
      if ((queuesRef.current[id] ?? []).length >= MAX_QUEUE) return false;
      setQueue((q) => [...q, { id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 4)}`, text }], id);
      if (overrideText == null) setInput("");
      return true;
    }
    // 附件注入：文本文件内容直接进上下文；二进制文件告知 AI 工作区路径（可用文件工具读取）
    let combined = text;
    if (targetSessionId == null && attachments.length > 0) {
      const NL = String.fromCharCode(10);
      const blocks = attachments.map((a) =>
        a.kind === "text" && a.content
          ? `[附件文件：${a.name}（已存至 ${a.path}）]${NL}${NL}${a.content}`
          : `[附件文件：${a.name}（已存至工作区 ${a.path}，可用文件读取工具查看）]`,
      );
      combined = blocks.join(NL + NL) + NL + NL + text;
      setAttachments([]);
    }
    if (combined.trim() === "") return false;
    activeRef.current.add(id);
    setSessionRunning(id, true);
    if (overrideText == null) setInput("");

    const history = [...target.items, { role: "user", content: combined }]
      .filter((i) => i.role === "user" || i.role === "assistant")
      .map((i) => ({ role: i.role, content: i.content }));

    patchSession(id, (s) => {
      const title = String(text).replace(/\s+/g, " ").slice(0, 24);
      return { ...s, title: s.title === "新对话" && title ? title : s.title, items: [...s.items, { role: "user", content: combined }] };
    });

    const controller = new AbortController();
    abortersRef.current[id] = controller;
    // 流式缓冲按"段"计：工具调用是段边界（否则调用工具前说的话会在工具后的段落里重复出现）
    let assistantText = "";
    let reasoningText = "";
    const toolById = new Map();
    let pendingPatch = false;
    let flushTimer = null;
    let finalized = false; // 定稿后禁止任何迟到的防抖刷写（此前竞态会把已定稿消息重新标成流式中 → "Working"不消失、Markdown 不渲染）

    const flushStreamPatch = () => {
      if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
      pendingPatch = false;
      if (finalized) return;
      patchSession(id, (s) => {
        const items = [...s.items];
        const last = items[items.length - 1];
        if (last?.role === "assistant" && last._streaming) items[items.length - 1] = { ...last, content: assistantText, reasoning: reasoningText };
        else if (assistantText !== "" || reasoningText !== "") items.push({ role: "assistant", content: assistantText, reasoning: reasoningText, _streaming: true });
        return { ...s, items };
      });
    };
    const scheduleStreamPatch = () => {
      if (pendingPatch || finalized) return;
      pendingPatch = true;
      flushTimer = setTimeout(flushStreamPatch, 120);
    };
    // 定稿：先把最后一段刷进去，再把所有 _streaming 标记摘掉（不管有几段）
    const finalizeStream = () => {
      flushStreamPatch();
      finalized = true;
      if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
      patchSession(id, (s) => {
        const items = [];
        for (const it of s.items) {
          if (it.role === "assistant" && it._streaming) {
            if (!it.content && !it.reasoning) continue; // 空壳丢弃
            items.push({ role: "assistant", content: it.content ?? "", reasoning: it.reasoning ? String(it.reasoning).slice(0, 20000) : undefined });
          } else if (it.kind === "tool" && it.running) {
            items.push({ ...it, running: false, isError: it.isError ?? true, text: it.text ?? "（回合结束，未收到该工具的结果）" });
          } else {
            items.push(it);
          }
        }
        return { ...s, items };
      });
    };

    let finishRef = "stop";
    let sawDone = false; // 流是否正常收尾（收到 done 事件）
    const onEvent = (event, data) => {
      if (event === "done") {
        finishRef = data?.finishReason ?? "stop";
        sawDone = true;
      }
      if (event === "delta") {
        assistantText += data.text;
        scheduleStreamPatch();
      } else if (event === "reasoning") {
        reasoningText += data.text;
        scheduleStreamPatch();
      } else if (event === "tool_call") {
        flushStreamPatch();
        assistantText = "";
        reasoningText = "";
        toolById.set(data.id, { kind: "tool", id: data.id, name: data.name, arguments: data.arguments, running: true });
        patchSession(id, (s) => {
          const items = [...s.items];
          while (items.length > 0 && items[items.length - 1]._streaming && !items[items.length - 1].content) items.pop();
          items.push(toolById.get(data.id));
          return { ...s, items };
        });
      } else if (event === "tool_result") {
        const record = { kind: "tool", id: data.id, name: data.name, arguments: toolById.get(data.id)?.arguments ?? {}, text: data.text, isError: data.isError, running: false };
        toolById.set(data.id, record);
        patchSession(id, (s) => {
          const items = [...s.items];
          const idx = items.findIndex((i) => i.kind === "tool" && i.id === data.id);
          if (idx >= 0) items[idx] = record;
          return { ...s, items };
        });
        // 图片工具结果自动嵌入页面显示（不等模型转述，保证图片一定出现在对话里）
        if (String(data.name ?? "").includes("image_generate") && !data.isError) {
          const m = /\/generated\/[A-Za-z0-9._-]+/.exec(String(data.text ?? ""));
          if (m != null) {
            patchSession(id, (s) => ({ ...s, items: [...s.items, { role: "assistant", content: `![生成图片](${m[0]})` }] }));
          }
        }
      } else if (event === "confirm_request") {
        // P0-2 事中拦截：该工具正等待人工审批——在对应工具行上挂审批卡
        flushStreamPatch();
        patchSession(id, (s) => {
          const items = [...s.items];
          const idx = items.findIndex((i) => i.kind === "tool" && i.name === data.tool && i.running && i.needsConfirm !== true);
          if (idx >= 0) {
            items[idx] = { ...items[idx], needsConfirm: true, confirmId: data.id, timeoutMs: data.timeoutMs };
          } else {
            items.push({ kind: "tool", id: data.id, name: data.tool, arguments: data.arguments, running: true, needsConfirm: true, confirmId: data.id, timeoutMs: data.timeoutMs });
          }
          return { ...s, items };
        });
      } else if (event === "confirm_result") {
        patchSession(id, (s) => {
          const items = [...s.items];
          const idx = items.findIndex((i) => i.kind === "tool" && i.confirmId === data.id);
          if (idx >= 0) items[idx] = { ...items[idx], needsConfirm: false, confirmResolved: true, confirmApproved: data.approved, confirmNote: data.note };
          return { ...s, items };
        });
      } else if (event === "error") {
        patchSession(id, (s) => ({ ...s, items: [...s.items, { kind: "error", content: data.message }] }));
      } else if (event === "sources") {
        // 本轮知识库引用来源（审计溯源 + Ragas retrieved_contexts）
        const items = (data?.sources ?? []).map((s2) => ({ docId: s2.docId, title: s2.title }));
        if (items.length > 0) {
          patchSession(id, (sess) => ({ ...sess, items: [...sess.items, { kind: "sources", sources: items }] }));
        }
      } else if (event === "context_trimmed") {
        patchSession(id, (s) => ({
          ...s,
          items: [
            ...s.items,
            {
              kind: "notice",
              content: `上下文窗口 ${Math.round(data.windowTokens / 1000)}k：已省略更早的 ${data.dropped} 条消息（本轮约用 ${Math.round(data.usedTokens / 1000)}k tokens）`,
            },
          ],
        }));
      }
    };

    const doneState = { finishReason: "stop" };
    const onEventWithDone = (event, data) => {
      if (event === "done") doneState.finishReason = data?.finishReason ?? "stop";
      onEvent(event, data);
    };
    try {
      await streamChat({
        messages: history,
        provider: activeProvider,
        session: id,
        employee: role === "boss" ? (secretaryMode ? "emp_secretary" : undefined) : (employeeSel !== "" ? employeeSel : undefined),
        contextWindow,
        onEvent: onEventWithDone,
        signal: controller.signal,
      });
      finalizeStream();
    } catch (error) {
      const aborted = controller.signal.aborted;
      const msg = String(error?.message ?? error);
      finalizeStream(); // 已收到的部分内容定稿保留
      if (aborted) {
        patchSession(id, (s) => ({ ...s, items: [...s.items, { kind: "notice", content: "已终止当前回合（已收到内容保留）" }] }));
      } else if (/无权访问该会话|属于其他用户/.test(msg)) {
        // 会话归属冲突的兜底（服务端 AUTH-01）：本会话 id 已被其他账号占用。
        // 已装载的旧版本会在初始化时迁移固定 id，这里再兜一层：把会话换成"本用户唯一"的新 id，
        // 之后的发送就能正常建立归属本人的会话；旧 id 指向他人会话，不读也不写。
        const fresh = newSessionId(userId);
        sessionsRef.current = sessionsRef.current.map((s) => (s.id === id ? { ...s, id: fresh } : s));
        setSessions((all) => all.map((s) => (s.id === id ? { ...s, id: fresh } : s)));
        setCurrentId((cur) => (cur === id ? fresh : cur));
        patchSession(fresh, (s) => ({
          ...s,
          items: [...s.items, { kind: "notice", content: "该会话标识已被其他账号占用，已自动切换到一个新会话，请重新发送这条消息。" }],
        }));
      } else {
        patchSession(id, (s) => ({ ...s, items: [...s.items, { kind: "error", content: msg }] }));
      }
    } finally {
      activeRef.current.delete(id);
      setSessionRunning(id, false);
      if (abortersRef.current[id] === controller) delete abortersRef.current[id];
      // 该会话的队列自动续发下一条（终止时该会话队列已清空，不会触发；不影响其他会话）
      const next = (queuesRef.current[id] ?? [])[0];
      if (next != null && !controller.signal.aborted) {
        setQueue((q) => q.slice(1), id);
        setTimeout(() => { send(next.text, id); }, 300);
      }
      // 长回答被输出上限截断时自动续写一次（用户不再需要手动输入"继续"）
      // 追加静默截断兜底：流异常中断时回答常停在半句（finish 仍为 stop），同样自动续写一次。
      // 注意：runningIds 是发送那一刻的 state 快照，在此处恒为"未运行"，不能作为守卫；
      // 真正要防的是与队列续发双发 —— 队列还有下一条时跳过自动续写。
      const hasQueued = (queuesRef.current[id] ?? []).length > 0;
      const lastAsst = [...(sessionsRef.current.find((s) => s.id === id)?.items ?? [])].reverse().find((it) => it.role === "assistant" && it.content);
      const tail2 = String(lastAsst?.content ?? "").trimEnd().slice(-2);
      const looksComplete = tail2 === "" || /[。！？…”"』」）)\]|`*—-]$/.test(tail2);
      const silentCut = !looksComplete && finishRef !== "aborted";
      if ((finishRef === "length" || silentCut) && _autoDepth < 1 && !hasQueued && !controller.signal.aborted) {
        patchSession(id, (s) => ({ ...s, items: [...s.items, { kind: "notice", content: "检测到回答未完整结束，正在自动续写…" }] }));
        setTimeout(() => { send("继续", id, _autoDepth + 1); }, 400);
      }
    }
  };

  // 终止当前会话的回合（只影响当前会话，其他会话继续执行）（三路保障）：
  // ① 本地 AbortController.abort() —— 正常路径
  // ② fetch(/api/chat/cancel, {keepalive:true}) —— 浏览器主线程忙时仍能送达服务端
  // ③ 服务端 5 分钟硬超时兜底
  const stopSession = (sid) => {
    if (!sid) return;
    try { abortersRef.current[sid]?.abort(); } catch {}
    try {
      fetch("/api/chat/cancel", {
        method: "POST",
        headers: { "content-type": "application/json", ...(localStorage.getItem("vfletch.token") ? { authorization: `Bearer ${localStorage.getItem("vfletch.token")}` } : {}) },
        body: JSON.stringify({ session: sid }),
        keepalive: true,
      }).catch((e) => console.warn("[load]", String(e?.message ?? e)));
    } catch {}
    setQueue([], sid);
    activeRef.current.delete(sid);
    setSessionRunning(sid, false);
  };
  const stop = () => stopSession(current?.id);

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  // 一键优化提示词：把口语化输入改写为结构化任务提示词（面向不擅写提示词的企业员工）
  const doPolish = async () => {
    if (polishing || input.trim() === "") return;
    setPolishing(true);
    setPolishNote("");
    try {
      const r = await polishPrompt(input.trim());
      if (r?.polished) {
        setInput(r.polished);
        setPolishNote(`已优化（${r.model}）· 原意保持，可直接发送或再修改`);
      }
    } catch (e) {
      setPolishNote(`优化失败: ${e?.message ?? e}`);
    } finally {
      setPolishing(false);
      setTimeout(() => setPolishNote(""), 6000);
    }
  };

  // 图片生成：直达 image_generate 工具，结果以 Markdown 图片插入对话
  const doGenerateImage = async () => {
    if (imageBusy || imagePrompt.trim() === "") return;
    setImageBusy(true);
    const id = current.id;
    try {
      const r = await generateImageDirect(imagePrompt.trim());
      patchSession(id, (s) => ({
        ...s,
        items: [...s.items, r?.ok
          ? { role: "assistant", content: `已按你的描述生成图片（${imagePrompt.trim().slice(0, 30)}…）：

${r.text}` }
          : { kind: "error", content: `图片生成失败: ${r?.text ?? r?.error ?? "当前供应商可能不支持图像生成"}` }],
      }));
      if (r?.ok) { setImagePrompt(""); setShowImagePanel(false); }
    } catch (e) {
      patchSession(id, (s) => ({ ...s, items: [...s.items, { kind: "error", content: `图片生成失败: ${e?.message ?? e}` }] }));
    } finally {
      setImageBusy(false);
    }
  };

  const newSession = () => {
    const id = newSessionId(userId);
    setSessions((all) => [{ id, title: "新对话", items: [] }, ...all].slice(0, 50));
    setCurrentId(id);
  };

  const deleteSession = (id) => {
    if (activeRef.current.has(id)) stopSession(id); // 删除运行中的会话：先终止它的回合
    setSessions((all) => {
      const rest = all.filter((s) => s.id !== id);
      const next = rest.length > 0 ? rest : [{ id: newSessionId(userId), title: "新对话", items: [] }];
      if (currentId === id) setCurrentId(next[0].id);
      return next;
    });
  };

  // 成员无 /api/mcp/list 权限（工具由主控统一接入），界面不显示计数，避免"未接入 MCP/0 个工具"误导
  const toolCount = role === "boss" ? (mcp?.toolCount ?? 0) : 0;
  const showToolCount = role === "boss" && toolCount > 0;
  const empty = (current?.items ?? []).length === 0;
  const items = current?.items ?? [];

  // 扁平 items → 回合分组：user 消息独立成行；连续的 工具+助手 归入同一个 Agent 回合
  // 超长内容截断：只保留每条消息的最后 DISPLAY_CAP 字符用于渲染（完整内容在 localStorage / 监管档案）
  const turns = useMemo(() => {
    const displayItems = items.map((it) => {
      if (typeof it.content === "string" && it.content.length > DISPLAY_CAP) {
        return { ...it, content: it.content.slice(-DISPLAY_CAP), _truncated: true };
      }
      return it;
    });
    const list = [];
    let agent = null;
    const flush = () => { if (agent != null) { list.push(agent); agent = null; } };
    for (const item of displayItems) {
      if (item.role === "user") { flush(); list.push({ type: "user", item }); }
      else if (item.kind === "sources") { flush(); list.push({ type: "sources", item }); }
      else if (item.kind === "error" || item.kind === "notice") { flush(); list.push({ type: item.kind, item }); }
      else {
        if (agent == null) agent = { type: "agent", steps: [] };
        agent.steps.push(item);
      }
    }
    flush();
    return list;
  }, [items]); // 依赖原始 items（截断在内部处理）

  return (
    <div className="chat-layout">
      <aside className="chat-history">
        <button className="history-new" onClick={newSession}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
          新对话
        </button>
        <div className="history-list">
          {sessions.map((s) => (
            <div key={s.id} className={`history-item ${s.id === currentId ? "on" : ""} ${runningIds[s.id] ? "busy" : ""}`} onClick={() => setCurrentId(s.id)}>
              {runningIds[s.id] ? <span className="history-busy" title="执行中" /> : null}
              <span className="history-title">{s.title}</span>
              {sessions.length > 1 ? (
                <button className="history-del" onClick={(e) => { e.stopPropagation(); deleteSession(s.id); }} title="删除">×</button>
              ) : null}
            </div>
          ))}
        </div>
        <div className="history-foot">
          {showToolCount ? `${toolCount} 个工具` : role === "boss" ? "未接入 MCP" : "工具由主控统一接入"}
        </div>
      </aside>

      <div className="chat-main">
        <header className="gk-chat-header">
          <div className="gk-identity">
            <span className={`gk-avatar ${running ? "busy" : ""}`}>
              <img src="/vf-logo.png" alt="" width={22} height={22} draggable={false} />
            </span>
            <div className="gk-id-text">
              <div className="gk-name">V-Fletch 办公体 {running ? <small className="gk-working">Working</small> : null}</div>
              <div className="gk-sub">共用一个大脑 · 共享对话进度 · 切换模型不丢上下文</div>
            </div>
          </div>
          <div className="gk-controls">
            {showToolCount ? <span className="gk-meta">{toolCount} 工具在线</span> : null}
          </div>
        </header>

        <div className="chat-scroll">
          {empty && (
            <div className="chat-empty">
              <h1>有什么可以帮你？</h1>
              <p>{showToolCount ? `已接入 ${toolCount} 个工具：` : ""}审计风控 · 联网检索 · 图像生成 · 本地代码 · 任务规划与子代理协作。按你的使用习惯推荐：</p>
              <div className="prompt-cards">
                {suggestions.map((s, i) => (
                  <button key={`${s.title}-${i}`} onClick={() => setInput(s.prompt)} title={s.prompt}>
                    {s.tag ? <span className="pc-tag">{s.tag}</span> : null}
                    {s.title}
                  </button>
                ))}
              </div>
              <button className="pc-refresh" onClick={refreshSuggestions} title="按最新使用数据重新生成">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M21 12a9 9 0 11-2.6-6.4M21 3v6h-6" /></svg>
                换一批
              </button>
            </div>
          )}
          {turns.map((turn, i) => {
            if (turn.type === "user") {
              return (
                <div key={`u${i}`} className="msg user">
                  <div className="msg-tag-user">你</div>
                  <div className="msg-body msg-body-user">{turn.item.content}</div>
                </div>
              );
            }
            if (turn.type === "sources") {
              return (
                <div key={`src${i}`} className="msg-sources">
                  📎 引用来源：
                  {(turn.item.sources ?? []).map((s2, k) => (
                    <span key={k} className="source-chip" title={s2.excerpt ?? ""}>{s2.title}</span>
                  ))}
                </div>
              );
            }
            if (turn.type === "error") return <div key={`e${i}`} className="msg-error">{turn.item.content}</div>;
            if (turn.type === "notice") return <div key={`n${i}`} className="msg-notice">{turn.item.content}</div>;
            return <AgentTurn key={`a${i}`} steps={turn.steps} />;
          })}
          <div ref={listEndRef} />
        </div>

        {showImagePanel && (
          <footer className="composer-wrap" style={{ paddingBottom: 0 }}>
            <div className="gk-image-panel">
              <div className="gk-image-title">AI 生成图片 <small className="dim">输入画面描述，生成结果直接插入对话</small></div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                <textarea
                  rows={2}
                  style={{ flex: 1, resize: "none" }}
                  placeholder="如：为审计周报生成一张蓝白配色的简洁封面，含盾牌元素"
                  value={imagePrompt}
                  onChange={(e) => setImagePrompt(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doGenerateImage(); } }}
                />
                <button className="ghost-btn" onClick={doGenerateImage} disabled={imageBusy || imagePrompt.trim() === ""}>
                  {imageBusy ? "生成中…" : "生成"}
                </button>
              </div>
              <div className="dim" style={{ fontSize: 10.5, marginTop: 4 }}>需当前模型供应商支持图像接口；也可在对话中让 AI 自动调用</div>
            </div>
          </footer>
        )}
        {queue.length > 0 && (
          <div className="msg-queue">
            <div className="mq-head">待发队列（{queue.length}/{MAX_QUEUE}）· 当前回合结束后自动发送</div>
            {queue.map((q, idx) => (
              <div key={q.id} className="mq-row">
                <span className="mq-idx">{idx + 1}</span>
                {editingQ === q.id ? (
                  <>
                    <input className="mq-edit" value={editingQText} onChange={(e) => setEditingQText(e.target.value)} onKeyDown={(e) => {
                      if (e.key === "Enter") { setQueue((qq) => qq.map((x) => x.id === q.id ? { ...x, text: editingQText } : x)); setEditingQ(null); }
                    }} autoFocus />
                    <button className="ghost-btn tiny" onClick={() => { setQueue((qq) => qq.map((x) => x.id === q.id ? { ...x, text: editingQText } : x)); setEditingQ(null); }}>存</button>
                    <button className="ghost-btn tiny" onClick={() => setEditingQ(null)}>消</button>
                  </>
                ) : (
                  <>
                    <span className="mq-text">{q.text}</span>
                    <button className="ghost-btn tiny" onClick={() => { setEditingQ(q.id); setEditingQText(q.text); }}>编辑</button>
                    <button className="ghost-btn tiny" onClick={() => setQueue((qq) => qq.filter((x) => x.id !== q.id))}>删</button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
        <footer className="composer-wrap">
          <div className="gk-composer">
            <textarea
              value={input}
              rows={1}
              placeholder={running ? "执行中…" : "输入任务，或描述任何需要 — 直接开始"}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={false}
            />
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.txt,.md,.json,.xml,.yml,.yaml,.log,.html,.png,.jpg,.jpeg,.webp,.gif,.zip,.js,.mjs,.ts,.py,.sql"
              style={{ display: "none" }}
              onChange={(e) => {
                const fl = [...(e.target.files ?? [])];
                e.target.value = "";
                if (fl.length > 0) handleFiles(fl);
              }}
            />
            {attachments.length > 0 ? (
              <div className="attach-row">
                {attachments.map((a, i) => (
                  <span key={i} className="attach-chip">
                    📎 {a.name}（{Math.round((a.size ?? 0) / 1024)}KB）
                    <button className="attach-x" onClick={() => setAttachments((prev) => prev.filter((_, k) => k !== i))}>×</button>
                  </span>
                ))}
                {uploading ? <span className="dim small">上传中…</span> : null}
              </div>
            ) : null}
            <div className="gk-composer-bar">
              {role === "boss" ? (
                <div className="gk-composer-left">
                  <ModelPicker providers={providers} active={activeProvider} onSelect={setProviderId} onManage={onOpenSettings} />
                  <WindowPicker value={contextWindow} onSelect={setContextWindow} />
                  <button
                    className={`sec-toggle ${secretaryMode ? "on" : ""}`}
                    onClick={() => setSecretaryMode((v) => !v)}
                    title={secretaryMode ? "AI 秘书模式已开启：当前模型拥有全系统只读权限（全库查询/系统状态/文件读取），不可修改任何数据与代码。点击关闭" : "开启 AI 秘书模式：把当前模型变成你的系统秘书（只读全权限）"}
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z" /><path d="M9.5 12l2 2 3.5-3.5" /></svg>
                    AI 秘书{secretaryMode ? " · 只读全权限" : ""}
                  </button>
                </div>
              ) : (
                <div className="gk-composer-left">
                  {myEmployees.length > 0 ? (
                    <select className="win-select emp-select" value={employeeSel} onChange={(e) => setEmployeeSel(e.target.value)} title="选择你的 AI 员工（身份设定随行）">
                      <option value="">公共模型（共用大脑）</option>
                      {myEmployees.filter((e2) => e2.mine).map((e2) => (
                        <option key={e2.id} value={e2.id}>{e2.name}（{e2.source_provider ?? e2.provider_id}）{e2.providerMissing ? " ⚠ API 已移除" : ""}</option>
                      ))}
                      {myEmployees.filter((e2) => !e2.mine).map((e2) => (
                        <option key={e2.id} value={e2.id}>{e2.name}（公共）</option>
                      ))}
                    </select>
                  ) : (
                    <span className="shared-brain" title="共用一个大脑：模型由主控统一配置；可在「团队」页自建 AI 员工">
                      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="3" /><path d="M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6l2.1 2.1m0-12.8l-2.1 2.1M7.7 16.3l-2.1 2.1" /></svg>
                      共用大脑 · 可在团队页自建 AI 员工
                    </span>
                  )}
                </div>
              )}
              <div className="gk-actions">
                <button className="gk-icon-btn" title="上传文件（文本内容直接进入对话；其他类型存入工作区供 AI 读取）" onClick={() => fileInputRef.current?.click()}>
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
                </button>
                <button className="gk-icon-btn" title="AI 生成图片" onClick={() => setShowImagePanel((v) => !v)}>
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" /><path d="M21 15l-5-5-9 9" /></svg>
                </button>
                <button className={`gk-icon-btn ${polishing ? "polishing" : ""}`} title="一键优化提示词：把口语化输入改写为结构化任务（不会写提示词也能用好 AI）" onClick={doPolish} disabled={polishing || input.trim() === ""}>
                  {polishing ? <span className="z-spin" /> : (
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3z" /></svg>
                  )}
                </button>
                {running ? (
                  <button className="gk-send gk-stop" onClick={stop} title="终止当前回合（已收到内容保留）">
                    <svg viewBox="0 0 24 24" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /></svg>
                  </button>
                ) : (
                  <button className="gk-send" onClick={() => send()} disabled={input.trim() === ""} title="发送（Enter）">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7" /></svg>
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="gk-hint">
            {polishNote ? <span style={{ color: "#1084fe", marginRight: 8 }}>{polishNote}</span> : null}
            Enter 发送 · Shift+Enter 换行 · 工具调用实时留痕监管 · 当前输入 {input.length} 字{running ? " · 执行中" : ""}
          </div>
        </footer>
      </div>
    </div>
  );
}
