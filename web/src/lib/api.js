// ---- 账号系统：令牌附加与 401 全局登出 ----
export const authToken = () => localStorage.getItem("vfletch.token") ?? "";
export const authUser = () => {
  try { return JSON.parse(localStorage.getItem("vfletch.user") ?? "null"); } catch { return null; }
};
export function saveAuth({ token, user }) {
  localStorage.setItem("vfletch.token", token);
  localStorage.setItem("vfletch.user", JSON.stringify(user));
}
export function clearAuth() {
  localStorage.removeItem("vfletch.token");
  localStorage.removeItem("vfletch.user");
}
function authHeaders(extra) {
  return authToken() ? { authorization: `Bearer ${authToken()}`, ...(extra ?? {}) } : (extra ?? {});
}

export async function fetchJson(url, options) {
  const hadToken = authToken() !== "";
  const merged = { ...options, headers: authHeaders(options?.headers) };
  const response = await fetch(url, merged);
  // 服务端错误一律透传原文（如"用户名或密码错误"/"标题不能为空"），不再统一吞成 HTTP 状态码
  const readError = async () => {
    try {
      const body = await response.clone().json();
      if (body && typeof body.error === "string" && body.error !== "") return body.error;
    } catch {}
    return null;
  };
  if (response.status === 401) {
    const isLogin = /\/api\/auth\/login$/.test(url);
    if (hadToken && !isLogin) {
      // 会话失效：清除本地凭据并广播（App 监听后回到登录页）
      clearAuth();
      window.dispatchEvent(new Event("vfletch:unauthorized"));
      throw new Error("登录已过期，请重新登录");
    }
    throw new Error((await readError()) ?? "未登录或会话已过期");
  }
  if (!response.ok) {
    throw new Error((await readError()) ?? `${url} 返回 HTTP ${response.status}`);
  }
  return response.json();
}

// ---- 认证接口 ----
export const login = (username, password) =>
  fetchJson("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
export const logout = () =>
  fetchJson("/api/auth/logout", { method: "POST" }).catch(() => ({}));
export const getMeta = () => fetchJson("/api/meta");
export const authMe = () => fetchJson("/api/auth/me");

// ---- 主控：账号管理 ----
export const adminUsers = () => fetchJson("/api/admin/users");
export const adminCreateUser = (payload) =>
  fetchJson("/api/admin/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
export const adminSetUserStatus = (id, status) =>
  fetchJson(`/api/admin/users/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
export const adminResetPassword = (id, password) =>
  fetchJson(`/api/admin/users/${encodeURIComponent(id)}/password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
export const adminSetUserRole = (id, role) =>
  fetchJson(`/api/admin/users/${encodeURIComponent(id)}/role`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role }),
  });
export const adminSetUserDepartment = (id, department) =>
  fetchJson(`/api/admin/users/${encodeURIComponent(id)}/department`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ department }),
  });
// 审计修改审批（主控）与申请（成员/管理员）
export const auditEdits = () => fetchJson("/api/audit/edits");
export const auditEditsMine = () => fetchJson("/api/audit/edits/mine");
export const auditEditApply = (id) =>
  fetchJson("/api/audit/edits/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
export const auditEditReject = (id) =>
  fetchJson("/api/audit/edits/reject", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
// 移除账号（仅主控；主控自身不可移除）
export const adminDeleteUser = (id) =>
  fetchJson(`/api/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" });

// ---- AI 员工自助体系（建员工/身份/转交/临时部门） ----
export const teamEmployees = () => fetchJson("/api/team/employees");
export const teamCreateEmployee = (payload) =>
  fetchJson("/api/team/employees", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
export const teamUpdateEmployee = (id, payload) =>
  fetchJson(`/api/team/employees/${encodeURIComponent(id)}/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
export const teamTransferEmployee = (id, to) =>
  fetchJson(`/api/team/employees/${encodeURIComponent(id)}/transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ to }),
  });
export const teamList = (all = false) => fetchJson(`/api/team/teams${all ? "?all=1" : ""}`);
export const teamCreate = (payload) =>
  fetchJson("/api/team/teams", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
export const teamDisband = (id) =>
  fetchJson(`/api/team/teams/${encodeURIComponent(id)}/disband`, { method: "POST" });

// ---- 员工辅助：一键优化提示词 / 图片生成 ----
export const polishPrompt = (text) =>
  fetchJson("/api/prompt-polish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
export const generateImageDirect = (prompt) =>
  fetchJson("/api/image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });

export const getHealth = () => fetchJson("/api/health");
export const getModels = () => fetchJson("/api/models");
export const getMcp = () => fetchJson("/api/mcp/list");
export const mcpDefinition = (id) => fetchJson(`/api/mcp/definition?id=${encodeURIComponent(id)}`);
export const reloadMcp = () => fetchJson("/api/mcp/reload", { method: "POST" });
export const mcpProposals = () => fetchJson("/api/mcp/proposals");
export const mcpProposalApprove = (id) =>
  fetchJson(`/api/mcp/proposals/${encodeURIComponent(id)}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
export const mcpProposalReject = (id) =>
  fetchJson(`/api/mcp/proposals/${encodeURIComponent(id)}/reject`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
export const probeMcp = (payload) =>
  fetchJson("/api/mcp/probe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });

export const getAuditOverview = () => fetchJson("/api/audit/overview");
// 审计库在线编辑（管理员）：{key, action: update|add|delete, index, patch, record}
export const auditSaveRecord = (payload) =>
  fetchJson("/api/audit/record", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
export const getSuggestions = (params = {}) =>
  fetchJson(`/api/suggest?${new URLSearchParams(params).toString()}`);
export const getSettings = () => fetchJson("/api/settings");
export const getUsage = () => fetchJson("/api/usage");

// ---- AI 生成内容监测（管理员）----
export const getAigcOverview = () => fetchJson("/api/aigc/overview");
export const aigcRescan = () =>
  fetchJson("/api/aigc/rescan", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

// ---- 本机运维（仅管理员账号）----
// 本地单机模式下不存在远程许可开关：adminLicense 仅用于读取本机运行状态。
export const adminLicense = () => fetchJson("/api/admin/license");
export const adminShutdown = () =>
  fetchJson("/api/admin/shutdown", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });

// ---- 企业共享知识库（全员可读）----
export const kbList = () => fetchJson("/api/kb");
export const kbCreate = (payload) =>
  fetchJson("/api/kb", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) });
export const kbUpdate = (id, payload) =>
  fetchJson(`/api/kb/${encodeURIComponent(id)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload ?? {}) });
export const kbArchive = () => fetchJson("/api/kb/archive");
export const kbRestore = (id) =>
  fetchJson("/api/kb/restore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
export const kbPurge = (id) =>
  fetchJson("/api/kb/purge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });
export const kbDelete = (id) =>
  fetchJson(`/api/kb/${encodeURIComponent(id)}`, { method: "DELETE" });

// ---- 文件上传（网页端附件 → 工作区，文本内容自动回传注入对话）----
export async function uploadFile(file) {
  const t = localStorage.getItem("vfletch.token") ?? "";
  const r = await fetch("/api/upload", {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(file.name),
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
    body: file,
  });
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

// ---- MCP 中心（主控专用：动态添加/移除 server）----
export const mcpInstall = (definition) =>
  fetchJson("/api/mcp/install", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(definition ?? {}) });
export const mcpUninstall = (id) =>
  fetchJson("/api/mcp/uninstall", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });

// ---- 部门创建授权码（主控签发）----
export const teamGrantList = () => fetchJson("/api/team/grants");
export const teamGrantIssue = () =>
  fetchJson("/api/team/grants", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

// ---- 成员端上报（主控查看）----
export const ingestEvents = () => fetchJson("/api/ingest/events");

// ---- 监管风控中心（RMS / SQLite） ----
export const rmsOverview = () => fetchJson("/api/rms/overview");
export const rmsEvents = (params = {}) =>
  fetchJson(`/api/rms/events?${new URLSearchParams(params).toString()}`);
export const rmsResolveEvent = (id) =>
  fetchJson(`/api/rms/events/${id}/resolve`, { method: "POST" });
export const rmsActivity = (params = {}) =>
  fetchJson(`/api/rms/activity?${new URLSearchParams(params).toString()}`);
export const rmsEmployees = () => fetchJson("/api/rms/employees");
export const rmsSetEmployeeStatus = (id, status) =>
  fetchJson(`/api/rms/employees/${encodeURIComponent(id)}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status }),
  });
export const rmsTodos = (params = {}) =>
  fetchJson(`/api/rms/todos?${new URLSearchParams(params).toString()}`);
export const rmsConversations = (params = {}) =>
  fetchJson(`/api/rms/conversations?${new URLSearchParams(params).toString()}`);
export const rmsConversationDetail = (id) =>
  fetchJson(`/api/rms/conversations/${encodeURIComponent(id)}`);

// ---- 规则中心（audit_rules 可配置） ----
export const rmsRules = () => fetchJson("/api/rms/rules");
export const rmsCreateRule = (payload) =>
  fetchJson("/api/rms/rules", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
export const rmsUpdateRule = (code, payload) =>
  fetchJson(`/api/rms/rules/${encodeURIComponent(code)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
export const rmsDeleteRule = (code) =>
  fetchJson(`/api/rms/rules/${encodeURIComponent(code)}`, { method: "DELETE" });

// ---- 任务派活（boss 委派 AI 员工 / 接力协作） ----
export const rmsTasks = (params = {}) =>
  fetchJson(`/api/rms/tasks?${new URLSearchParams(params).toString()}`);
export const rmsCreateTask = (payload) =>
  fetchJson("/api/rms/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
export const rmsRunTask = (id) =>
  fetchJson(`/api/rms/tasks/${encodeURIComponent(id)}/run`, { method: "POST" });

export const saveProvider = (payload) =>
  fetchJson("/api/settings/provider", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
export const setActiveProvider = (id) =>
  fetchJson("/api/settings/active", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
export const deleteProvider = (id) =>
  fetchJson("/api/settings/provider-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
export const saveMcpServers = (servers) =>
  fetchJson("/api/settings/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ servers }),
  });

async function* readSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine == null) continue;
      let payload;
      try {
        payload = JSON.parse(dataLine.slice(6));
      } catch {
        continue;
      }
      yield { event: eventLine ? eventLine.slice(7) : "message", data: payload };
    }
  }
}

/**
 * 发起一轮对话，通过回调把增量事件推给调用方。
 * 事件类型与 server/lib/chat.mjs 保持一致：
 *   start | delta | reasoning | tool_call | tool_result | risk_event | usage | error | done
 * session：前端会话 id（localStorage 会话）；服务端据此在 SQLite 里做留痕
 */
export async function streamChat({ messages, provider, session, employee, contextWindow, onEvent, signal }) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ messages, provider, session, employee, contextWindow }),
    signal,
  });
  if (!response.ok) {
    // 服务端给出的可读错误（如并发限流的"请稍候再发送"）优先透传给用户
    let detail = "";
    try {
      const body = await response.clone().json();
      if (body && typeof body.error === "string") detail = body.error;
    } catch {}
    throw new Error(detail || `/api/chat 返回 HTTP ${response.status}`);
  }
  for await (const frame of readSse(response)) {
    onEvent(frame.event, frame.data);
  }
}

/**
 * P0-2 事中拦截：裁决对话流内的代码执行审批卡（id 为 confirm_request 事件下发的 confirmId）
 */
export async function chatConfirm(id, approve) {
  return fetchJson("/api/chat/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, approve }),
  });
}
