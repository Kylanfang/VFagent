// V-Fletch 监管风控模块（RMS）：面向企业的 AI 员工监管
// 职责：把聊天/工具/任务/成本/风险事件落库 SQLite，并提供监管查询与处置接口。
// 数据流：server/main.mjs 的 handleChat 在事件流中调用本模块的 record* 采集函数；
// 监管视图 / 风控处置通过 query*/resolve* 读取与更新。
import { all, get, run } from "./db.mjs";

export const DEFAULT_EMPLOYEE = "emp_default";

// ---------------------------------------------------------------------------
// 采集（写入）
// ---------------------------------------------------------------------------

function now() {
  return new Date().toISOString();
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

export function ensureEmployee({ id = DEFAULT_EMPLOYEE, name, role, providerId, model }) {
  const existing = get("SELECT id FROM ai_employees WHERE id = ?", id);
  if (existing != null) {
    if (providerId != null || model != null) {
      run(
        "UPDATE ai_employees SET provider_id = COALESCE(?, provider_id), model = COALESCE(?, model), updated_at = ? WHERE id = ?",
        providerId ?? null,
        model ?? null,
        now(),
        id,
      );
    }
    return { id, created: false };
  }
  run(
    "INSERT INTO ai_employees (id, name, role, provider_id, model, status, meta) VALUES (?, ?, ?, ?, ?, 'active', ?)",
    id,
    name ?? "AI 办公员工",
    role ?? "办公助理",
    providerId ?? null,
    model ?? null,
    "{}",
  );
  return { id, created: true };
}

/** 供应商 id → AI 员工 id（emp_<sanitized>），聊天时按所用模型自动归属员工 */
export function employeeIdForProvider(providerId) {
  if (providerId === "vf") return "front_desk"; // VF 前台模型：迎宾身份，非 AI 员工
  return `emp_${String(providerId ?? "default").replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * 把模型配置里的供应商同步为 AI 员工档案（启动与设置保存时调用）。
 * 传入的 providers 应是已过滤"可用"的列表（key 已解析非空，或本地端点）。
 */
export function syncProviderEmployees(providers = []) {
  const results = [];
  for (const p of providers) {
    if (p == null || typeof p.id !== "string" || p.id === "") continue;
    const empId = employeeIdForProvider(p.id);
    const existing = get("SELECT id FROM ai_employees WHERE id = ?", empId);
    if (existing == null) {
      run(
        "INSERT INTO ai_employees (id, name, role, provider_id, model, status, meta) VALUES (?, ?, ?, ?, ?, 'active', ?)",
        empId,
        p.label ?? p.id,
        "模型员工",
        p.id,
        p.model ?? null,
        JSON.stringify({ note: "由模型 API 配置自动创建；聊天切换模型即切换归属员工" }),
      );
      results.push({ id: empId, created: true });
    } else {
      run(
        "UPDATE ai_employees SET name = COALESCE(?, name), provider_id = ?, model = COALESCE(?, model), updated_at = ? WHERE id = ?",
        p.label ?? null,
        p.id,
        p.model ?? null,
        now(),
        empId,
      );
      results.push({ id: empId, created: false });
    }
  }
  return results;
}

/** 删除模型供应商时同步清理其自动创建的"模型员工"（防止僵尸员工堆积）；
 *  有归属（owner）的员工是用户自建资产，保留不动；有留痕引用的先解引用再删，监管记录本身保留 */
export function removeProviderEmployee(providerId) {
  const id = employeeIdForProvider(providerId);
  const emp = get("SELECT id, owner_user_id FROM ai_employees WHERE id = ?", id);
  if (emp == null) return { removed: false };
  if (emp.owner_user_id != null) return { removed: false, reason: "有归属，保留" };
  try {
    run("BEGIN");
    for (const table of ["conversations", "messages", "risk_events", "usage_log"]) {
      run(`UPDATE ${table} SET employee_id = NULL WHERE employee_id = ?`, id);
    }
    run("DELETE FROM ai_employees WHERE id = ?", id);
    run("COMMIT");
    return { removed: true, id };
  } catch (error) {
    try { run("ROLLBACK"); } catch {}
    return { removed: false, reason: String(error?.message ?? error) };
  }
}

/** 会话开始（幂等：标题仅首次写入；含无效编码字符的标题净化为"对话"；owner 记录登录用户） */
export function ensureConversation({ conversationId, employeeId = DEFAULT_EMPLOYEE, title, source = "chat", ownerUserId = null }) {
  const id = String(conversationId ?? `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`);
  const existing = get("SELECT id, owner_user_id FROM conversations WHERE id = ?", id);
  if (existing != null && existing.owner_user_id != null && ownerUserId != null && existing.owner_user_id !== ownerUserId) {
    // 归属校验（CodeX AUTH-01）：员工不能通过自报 session id 读写他人会话
    throw new Error("无权访问该会话：会话属于其他用户");
  }
  if (existing == null) {
    // 前台迎宾不是 AI 员工：仅落一条隐藏系统档案满足外键（必须先于会话插入），列表永不显示
    if (employeeId === "front_desk") {
      if (get("SELECT id FROM ai_employees WHERE id = 'front_desk'") == null) {
        run(
          "INSERT INTO ai_employees (id, name, role, status, meta) VALUES ('front_desk', 'VF 前台助手', '前台迎宾（系统）', 'active', ?)",
          JSON.stringify({ hidden: true, note: "内置接待身份，非 AI 员工" }),
        );
      }
    } else {
      ensureEmployee({ id: employeeId });
    }
    // U+FFFD = UTF-8 解码失败的残留（GBK 终端/curl 直发等）；坏标题不落库
    const cleanTitle = String(title ?? "").replace(/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
    run(
      "INSERT INTO conversations (id, employee_id, title, source, status, owner_user_id) VALUES (?, ?, ?, ?, 'open', ?)",
      id,
      employeeId,
      cleanTitle !== "" ? cleanTitle.slice(0, 60) : "对话",
      source,
      ownerUserId,
    );
  }
  return id;
}

export function closeConversation(conversationId, { markClosed = false } = {}) {
  const messageCount = get("SELECT COUNT(*) c FROM messages WHERE conversation_id = ?", conversationId)?.c ?? 0;
  const toolCount = get("SELECT COUNT(*) c FROM tool_calls WHERE conversation_id = ?", conversationId)?.c ?? 0;
  if (markClosed) {
    run(
      "UPDATE conversations SET status = 'closed', message_count = ?, tool_count = ?, ended_at = ? WHERE id = ?",
      messageCount,
      toolCount,
      now(),
      conversationId,
    );
  } else {
    run(
      "UPDATE conversations SET message_count = ?, tool_count = ?, ended_at = ? WHERE id = ?",
      messageCount,
      toolCount,
      now(),
      conversationId,
    );
  }
}

export function recordMessage({ conversationId, role, content, reasoning, employeeId }) {
  if (typeof content !== "string" || content.trim() === "") {
    content = null;
  }
  if (content == null && (reasoning == null || String(reasoning).trim() === "")) return;
  run(
    "INSERT INTO messages (conversation_id, role, content, reasoning, employee_id) VALUES (?, ?, ?, ?, ?)",
    conversationId,
    role,
    content,
    reasoning != null ? String(reasoning).slice(0, 20000) : null,
    employeeId ?? null,
  );
}

export function recordToolCall({ conversationId, toolName, arguments: args, result, isError, durationMs }) {
  run(
    "INSERT INTO tool_calls (conversation_id, tool_name, arguments, result, is_error, duration_ms) VALUES (?, ?, ?, ?, ?, ?)",
    conversationId,
    toolName,
    args != null ? JSON.stringify(args).slice(0, 4000) : null,
    result != null ? String(result).slice(0, 6000) : null,
    isError ? 1 : 0,
    durationMs != null ? Math.round(durationMs) : null,
  );
  return {
    name: toolName,
    isError: Boolean(isError),
    kind: "tool",
  };
}

/** todo_write 全量覆盖式同步（list 以工具参数 tasks 为准） */
export function recordTodoSet({ conversationId, tasks }) {
  const list = Array.isArray(tasks) ? tasks : [];
  // 清掉该会话旧 todo（todo_write 是全量覆盖语义）
  run("DELETE FROM todos WHERE conversation_id = ?", conversationId);
  const seen = new Set();
  for (const task of list) {
    const text = String(task?.text ?? "").trim();
    if (text === "") continue;
    const status = ["pending", "in_progress", "completed"].includes(task?.status) ? task.status : "pending";
    let key = String(task?.id ?? text).slice(0, 40);
    // 修复：todos 有 UNIQUE(conversation_id, task_key)，模型给出重复 id（或两条同文本且无 id）时
    // 原实现直接抛 UNIQUE constraint failed；persistTodo 在 onEvent 里同步调用，异常会冒泡出
    // runTurn 把整个回合打断。这里按出现顺序去重，保留第一条，重复的追加序号而非报错。
    if (seen.has(key)) {
      let n = 2;
      while (seen.has(`${key.slice(0, 36)}#${n}`)) n += 1;
      key = `${key.slice(0, 36)}#${n}`;
    }
    seen.add(key);
    run(
      "INSERT INTO todos (conversation_id, task_key, text, status) VALUES (?, ?, ?, ?)",
      conversationId,
      key,
      text.slice(0, 500),
      status,
    );
  }
  return { count: list.length };
}

export function recordUsageDb({ conversationId, employeeId = DEFAULT_EMPLOYEE, provider, model, usage, promptChars, completionChars }) {
  const promptTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  // 估算成本：无官方计价时仅记录 token 与字符（cost_cents 留给企业定价规则）
  run(
    "INSERT INTO usage_log (employee_id, provider, model, prompt_tokens, completion_tokens, estimated_chars, cost_cents) VALUES (?, ?, ?, ?, ?, ?, 0)",
    employeeId,
    provider ?? null,
    model ?? null,
    Number(promptTokens) || 0,
    Number(completionTokens) || 0,
    Number(promptChars || 0) + Number(completionChars || 0),
  );
  return { promptTokens, completionTokens };
}

// ---------------------------------------------------------------------------
// 风险扫描（规则存于 audit_rules，可在规则中心配置：级别/启用/词表/阈值/处置）
// ---------------------------------------------------------------------------

// 判定“不可逆动作”的强词（仅当助手语气是在“执行/将做”而非“分析/查询”时触发）
const IRREVERSIBLE_RE =
  /(转账|汇款|付款给|发送(邮件|消息|文件)给|删除(文件|记录|数据|全部|库)|公开发布|对外发布|注销|开户)/i;
const ANALYSIS_HINT_RE = /(分析|审计|检查|查询|汇总|报告|列表|统计|梳理|核查|复述|评估)/i;

export const RULE_KINDS = {
  tool_error: "工具失败",
  long_run: "轮次打满",
  irreversible: "不可逆动作",
  sensitive_word: "敏感词命中",
  cost_spike: "成本突增",
  text_pattern: "自定义文本规则",
};
export const RULE_ACTIONS = { record: "仅记录", alert: "告警", confirm: "需人工确认" };

function parseRuleParams(raw) {
  if (raw == null || String(raw).trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed != null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function scanByRules(ctx) {
  const events = [];
  const rules = all("SELECT * FROM audit_rules WHERE enabled = 1");
  // 文本类规则（不可逆/敏感词/自定义模式）只扫用户输入：
  // 助手复述风险词汇（如"没有内部数据，无法删除"）不代表用户有风险意图，计入会整批误报
  const userText = String(ctx.lastUserText ?? "");

  for (const rule of rules) {
    const params = parseRuleParams(rule.params);
    let hit = null;

    if (rule.kind === "tool_error") {
      if ((ctx.toolErrorCount ?? 0) > 0) {
        hit = { title: `本轮 ${ctx.toolErrorCount} 次工具执行失败`, detail: "需复核工具失败对任务结果的影响；详见活动流水。" };
      }
    } else if (rule.kind === "long_run") {
      if (ctx.roundsReachedLimit) {
        hit = { title: "达到工具轮次上限，提前结束", detail: "可能是任务过重或出现循环，建议拆分后再试。" };
      }
    } else if (rule.kind === "irreversible") {
      if (IRREVERSIBLE_RE.test(userText) && !ANALYSIS_HINT_RE.test(userText)) {
        hit = { title: "疑似不可逆动作（删除/发送/转账等）", detail: "输出含不可逆动作表述且用户请求并非分析类；请人工复核是否执行过该类动作。" };
      }
    } else if (rule.kind === "cost_spike") {
      // 口径：按"变动部分"（模型输出 + 工具结果字符 / 1.8 折算）计成本，
      // 排除系统提示与工具 schema 的静态底座（约 9.5k tok）——否则短对话也会恒超阈值
      const limit = Number(params.maxTurnTokens) > 0 ? Number(params.maxTurnTokens) : 60000;
      const volatileChars = Number(ctx.estimatedChars ?? 0);
      const estimated = Math.round(volatileChars / 1.8);
      if (estimated > limit) {
        hit = { title: `单轮成本超阈值（约 ${estimated} > ${limit} tok）`, detail: "单轮变动成本（输出+工具结果折算）超过规则阈值，需检查是否异常循环或上下文过长。" };
      }
    } else {
      // sensitive_word / text_pattern：文本类规则
      const words = Array.isArray(params.words) ? params.words.filter((w) => typeof w === "string" && w.trim() !== "") : [];
      const matched = words.filter((w) => userText.includes(w));
      if (matched.length > 0) {
        hit = {
          title: `${rule.name}：命中 ${matched.length} 项（${matched.slice(0, 3).join("、")}${matched.length > 3 ? " 等" : ""}）`,
          detail: `命中词表：${matched.join("、")}`,
        };
      } else if (rule.kind === "text_pattern" && typeof params.pattern === "string" && params.pattern.trim() !== "") {
        try {
          if (new RegExp(params.pattern, "i").test(userText)) {
            hit = { title: `${rule.name}：自定义模式命中`, detail: `正则 /${params.pattern}/i 命中本轮对话内容。` };
          }
        } catch {
          // 非法正则：跳过该规则，不中断扫描
        }
      }
    }

    if (hit != null) {
      run("UPDATE audit_rules SET hit_count = hit_count + 1 WHERE code = ?", rule.code);
      run(
        "INSERT INTO risk_events (employee_id, conversation_id, level, kind, title, detail) VALUES (?, ?, ?, ?, ?, ?)",
        ctx.employeeId ?? DEFAULT_EMPLOYEE,
        ctx.conversationId,
        rule.level,
        rule.code,
        hit.title,
        hit.detail != null ? String(hit.detail).slice(0, 1500) : null,
      );
      events.push({ kind: rule.code, level: rule.level, title: hit.title, rule: rule.name, action: rule.action });
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// 规则中心（audit_rules CRUD）
// ---------------------------------------------------------------------------

export function listRules() {
  return all(
    "SELECT code, name, kind, level, enabled, action, params, hit_count, description, updated_at FROM audit_rules ORDER BY code",
  ).map((r) => ({ ...r, params: parseRuleParams(r.params) }));
}

function assertRuleFields({ code, name, kind, level, action }) {
  if (!/^[A-Za-z][A-Za-z0-9_]{1,40}$/.test(String(code ?? ""))) throw new Error("规则代码需为 2-41 位字母/数字/下划线（字母开头）");
  if (String(name ?? "").trim() === "") throw new Error("规则名称不能为空");
  if (!Object.prototype.hasOwnProperty.call(RULE_KINDS, kind)) throw new Error(`不支持的规则类型: ${kind}`);
  if (!["info", "warning", "critical"].includes(level)) throw new Error("level 仅支持 info / warning / critical");
  if (!Object.prototype.hasOwnProperty.call(RULE_ACTIONS, action)) throw new Error(`不支持的处置动作: ${action}`);
}

export function createRule({ code, name, kind, level, action, params, description, enabled }) {
  const payload = {
    code,
    name: String(name ?? "").trim(),
    kind: kind ?? "text_pattern",
    level: level ?? "warning",
    action: action ?? "alert",
    params,
    description,
    enabled: enabled === false ? 0 : 1,
  };
  assertRuleFields(payload);
  const exists = get("SELECT code FROM audit_rules WHERE code = ?", payload.code);
  if (exists != null) throw new Error(`规则代码已存在: ${payload.code}`);
  run(
    "INSERT INTO audit_rules (code, name, kind, level, enabled, action, params, description, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    payload.code,
    payload.name,
    payload.kind,
    payload.level,
    payload.enabled,
    payload.action,
    params == null ? null : JSON.stringify(params),
    String(description ?? "").slice(0, 500) || null,
    now(),
  );
  return listRules().find((r) => r.code === payload.code) ?? null;
}

export function updateRule(code, patch) {
  const existing = get("SELECT * FROM audit_rules WHERE code = ?", code);
  if (existing == null) throw new Error(`规则不存在: ${code}`);
  const next = {
    code,
    name: patch.name ?? existing.name,
    kind: patch.kind ?? existing.kind,
    level: patch.level ?? existing.level,
    action: patch.action ?? existing.action,
  };
  assertRuleFields(next);
  const enabled = patch.enabled == null ? existing.enabled : patch.enabled ? 1 : 0;
  const params = patch.params === undefined ? existing.params : patch.params == null ? null : JSON.stringify(patch.params);
  const description = patch.description === undefined ? existing.description : String(patch.description ?? "").slice(0, 500) || null;
  run(
    "UPDATE audit_rules SET name = ?, kind = ?, level = ?, enabled = ?, action = ?, params = ?, description = ?, updated_at = ? WHERE code = ?",
    next.name, next.kind, next.level, enabled, next.action, params, description, now(), code,
  );
  return listRules().find((r) => r.code === code) ?? null;
}

export function deleteRule(code) {
  const result = run("DELETE FROM audit_rules WHERE code = ?", code);
  if (result.changes === 0) throw new Error(`规则不存在: ${code}`);
  return { code, deleted: true };
}

// ---------------------------------------------------------------------------
// 监管查询与处置（读取/更新）
// ---------------------------------------------------------------------------

// 监管总览含 10+ 个全表 COUNT/SUM，且被多端 15s 轮询叠加；
// 缓存 20s 去重并发请求（数据新鲜度上限 20s，监管大屏可接受），避免数据量增长后拖慢事件循环。
let overviewCache = { at: 0, data: null };
const OVERVIEW_TTL_MS = 20_000;

export function rmsOverview() {
  if (overviewCache.data != null && Date.now() - overviewCache.at < OVERVIEW_TTL_MS) {
    return overviewCache.data;
  }
  const count = (sql) => get(sql)?.c ?? 0;
  const todaySql = " AND date(created_at) = date('now','localtime')";
  const openRisks = all("SELECT id, level, kind, title, created_at FROM risk_events WHERE status = 'open' ORDER BY created_at DESC LIMIT 8");
  const costToday = get("SELECT COALESCE(SUM(cost_cents),0) c FROM usage_log WHERE date(created_at) = date('now','localtime')")?.c ?? 0;
  const overview = {
    date: today(),
    conversations: { total: count("SELECT COUNT(*) c FROM conversations"), today: count(`SELECT COUNT(*) c FROM conversations WHERE date(started_at)=date('now','localtime')`) },
    messages: { total: count("SELECT COUNT(*) c FROM messages"), today: count(`SELECT COUNT(*) c FROM messages WHERE date(created_at)=date('now','localtime')`) },
    toolCalls: { total: count("SELECT COUNT(*) c FROM tool_calls"), today: count(`SELECT COUNT(*) c FROM tool_calls WHERE date(created_at)=date('now','localtime')`), errors: count("SELECT COUNT(*) c FROM tool_calls WHERE is_error=1") },
    todos: {
      pending: count("SELECT COUNT(*) c FROM todos WHERE status != 'completed'"),
      completed: count("SELECT COUNT(*) c FROM todos WHERE status = 'completed'"),
    },
    riskEvents: {
      open: count("SELECT COUNT(*) c FROM risk_events WHERE status='open'"),
      critical: count("SELECT COUNT(*) c FROM risk_events WHERE status='open' AND level='critical'"),
      total: count("SELECT COUNT(*) c FROM risk_events"),
    },
    tokens: {
      prompt: get("SELECT COALESCE(SUM(prompt_tokens),0) c FROM usage_log")?.c ?? 0,
      completion: get("SELECT COALESCE(SUM(completion_tokens),0) c FROM usage_log")?.c ?? 0,
      today: get("SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) c FROM usage_log WHERE date(created_at)=date('now','localtime')")?.c ?? 0,
    },
    costCents: costToday,
    recentOpenRisks: openRisks,
  };
  overviewCache = { at: Date.now(), data: overview };
  return overview;
}

export function listEmployees() {
  // front_desk 为内置前台身份（非 AI 员工），不在员工列表展示
  const rows = all(`
    SELECT e.id, e.name, e.role, e.provider_id, e.model, e.status, e.created_at,
      (SELECT COUNT(*) FROM conversations c WHERE c.employee_id = e.id) AS conversation_count,
      (SELECT COUNT(*) FROM risk_events r WHERE r.employee_id = e.id AND r.status='open') AS open_risks
    FROM ai_employees e WHERE e.id != 'front_desk' AND json_extract(COALESCE(e.meta,'{}'), '$.hidden') IS NULL ORDER BY e.created_at`);
  return rows;
}

export function setEmployeeStatus(id, status) {
  if (!["active", "suspended"].includes(status)) throw new Error("status 仅支持 active / suspended");
  const result = run("UPDATE ai_employees SET status = ?, updated_at = ? WHERE id = ?", status, now(), id);
  if (result.changes === 0) throw new Error(`AI 员工不存在: ${id}`);
  return { id, status };
}

export function listRiskEvents({ status, level, limit = 50 } = {}) {
  let sql = "SELECT id, level, kind, title, detail, status, conversation_id, created_at, resolved_at FROM risk_events WHERE 1=1";
  const params = [];
  if (status && status !== "all") {
    sql += " AND status = ?";
    params.push(status);
  }
  if (level && level !== "all") {
    sql += " AND level = ?";
    params.push(level);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  return all(sql, ...params);
}

export function resolveRiskEvent(id) {
  const result = run("UPDATE risk_events SET status='resolved', resolved_at=? WHERE id=? AND status='open'", now(), Number(id));
  if (result.changes === 0) {
    const exists = get("SELECT id FROM risk_events WHERE id = ?", Number(id));
    if (exists == null) throw new Error(`风控事件不存在: ${id}`);
  }
  return { id: Number(id), resolved: true };
}

export function listActivity({ limit = 30, type } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
  if (type === "tool") {
    return all("SELECT id, conversation_id, tool_name, is_error, duration_ms, created_at FROM tool_calls ORDER BY id DESC LIMIT ?", lim);
  }
  return all(`
    SELECT 'message' AS kind, id, conversation_id, role, substr(content,1,200) AS content, created_at FROM messages
    UNION ALL
    SELECT 'tool' AS kind, id, conversation_id, tool_name, substr(result,1,200), created_at FROM tool_calls
    ORDER BY id DESC LIMIT ?`, lim);
}

export function listConversations({ limit = 30, status } = {}) {
  let sql = "SELECT id, employee_id, title, status, message_count, tool_count, started_at, ended_at FROM conversations";
  const params = [];
  if (status && status !== "all") {
    sql += " WHERE status = ?";
    params.push(status);
  }
  sql += " ORDER BY started_at DESC LIMIT ?";
  params.push(Math.min(Math.max(Number(limit) || 30, 1), 200));
  return all(sql, ...params);
}

export function listTodos({ status = "all", limit = 50, conversationId } = {}) {
  let sql = "SELECT id, conversation_id, task_key, text, status, updated_at FROM todos WHERE 1=1";
  const params = [];
  if (conversationId) {
    sql += " AND conversation_id = ?";
    params.push(conversationId);
  }
  if (status && status !== "all") {
    sql += " AND status = ?";
    params.push(status);
  }
  sql += " ORDER BY updated_at DESC LIMIT ?";
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  return all(sql, ...params);
}

export function conversationDetail(id) {
  const conv = get("SELECT * FROM conversations WHERE id = ?", id);
  if (conv == null) return null;
  const messages = all("SELECT role, content, reasoning, employee_id, created_at FROM messages WHERE conversation_id = ? ORDER BY id", id);
  const tools = all("SELECT tool_name, arguments, result, is_error, created_at FROM tool_calls WHERE conversation_id = ? ORDER BY id", id);
  return { ...conv, messages, tools };
}

// 供 handleChat 使用：一次性扫描并返回新建事件（便于前端实时提示）
export function scanTurnRisks(ctx) {
  return scanByRules(ctx);
}

// ---------------------------------------------------------------------------
// 任务派活（boss 委派 AI 员工执行；支持 1-2 名 AI 员工接力协作，过程写入共享会话留痕）
// ---------------------------------------------------------------------------

export function listTasks({ status, limit = 50 } = {}) {
  let sql = "SELECT id, title, detail, created_by, assignees, status, conversation_id, result_summary, error, created_at, updated_at FROM tasks";
  const params = [];
  if (status && status !== "all") {
    sql += " WHERE status = ?";
    params.push(status);
  }
  sql += " ORDER BY created_at DESC LIMIT ?";
  params.push(Math.min(Math.max(Number(limit) || 50, 1), 200));
  return all(sql, ...params).map((t) => ({ ...t, assignees: safeParseList(t.assignees) }));
}

export function taskDetail(id) {
  const row = get("SELECT * FROM tasks WHERE id = ?", id);
  if (row == null) return null;
  return { ...row, assignees: safeParseList(row.assignees) };
}

function safeParseList(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function createTask({ title, detail, assignees, createdBy }) {
  const t = String(title ?? "").trim();
  if (t === "") throw new Error("任务标题不能为空");
  if (t.length > 200) throw new Error("任务标题过长（≤200 字）");
  const list = Array.isArray(assignees) ? assignees.map(String).filter(Boolean) : [];
  if (list.length < 1 || list.length > 4) throw new Error("承接 AI 员工需选 1-4 名（部门派活由服务端展开）");
  for (const empId of list) {
    if (get("SELECT id FROM ai_employees WHERE id = ?", empId) == null) throw new Error(`AI 员工不存在: ${empId}`);
  }
  const id = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const convId = ensureConversation({
    conversationId: id,
    employeeId: list[0],
    title: `任务：${t.slice(0, 40)}`,
    source: "task",
    ownerUserId: createdBy ?? null,
  });
  run(
    "INSERT INTO tasks (id, title, detail, created_by, assignees, status, conversation_id, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
    id, t.slice(0, 120), String(detail ?? "").slice(0, 2000) || null, createdBy ?? null,
    JSON.stringify(list), convId, now(),
  );
  return taskDetail(id);
}

/** 删除任务（连同其专属任务会话的过程留痕）：清理测试数据与误建任务用 */
export function deleteTask(id) {
  const task = get("SELECT id, created_by, conversation_id FROM tasks WHERE id = ?", id);
  if (task == null) throw new Error(`任务不存在: ${id}`);
  run("BEGIN");
  try {
    if (task.conversation_id) {
      const conv = get("SELECT id, source FROM conversations WHERE id = ?", task.conversation_id);
      // 修复：messages.conversation_id / tool_calls.conversation_id 均为 NOT NULL，
      // 原实现 `UPDATE ... SET conversation_id = NULL` 在任务**跑过之后**（已有留痕行）必定抛
      // NOT NULL constraint failed 并整体回滚 —— 任务永远删不掉。
      // 任务会话（source='task'，id 即任务 id）是任务的专属过程留痕，随任务一并清理；
      // 风控/监测证据（risk_events / aigc_events，conversation_id 可空）只解绑不删除，保留监管证据。
      if (conv != null && conv.source === "task") {
        run("DELETE FROM messages WHERE conversation_id = ?", task.conversation_id);
        run("DELETE FROM tool_calls WHERE conversation_id = ?", task.conversation_id);
        run("DELETE FROM todos WHERE conversation_id = ?", task.conversation_id);
        run("UPDATE risk_events SET conversation_id = NULL WHERE conversation_id = ?", task.conversation_id);
        run("UPDATE aigc_events SET conversation_id = NULL WHERE conversation_id = ?", task.conversation_id);
        run("DELETE FROM conversations WHERE id = ?", task.conversation_id);
      } else {
        run("UPDATE todos SET conversation_id = NULL WHERE conversation_id = ?", task.conversation_id);
      }
    }
    run("DELETE FROM tasks WHERE id = ?", id);
    run("COMMIT");
    return { ok: true, id };
  } catch (error) {
    try { run("ROLLBACK"); } catch {}
    throw error;
  }
}

export function updateTask(id, patch) {
  const existing = taskDetail(id);
  if (existing == null) throw new Error(`任务不存在: ${id}`);
  const status = patch.status ?? existing.status;
  if (!["open", "running", "done", "failed"].includes(status)) throw new Error("非法任务状态");
  run(
    "UPDATE tasks SET status = ?, result_summary = COALESCE(?, result_summary), error = ?, updated_at = ? WHERE id = ?",
    status,
    patch.resultSummary ?? null,
    patch.error ?? null,
    now(),
    id,
  );
  return taskDetail(id);
}
