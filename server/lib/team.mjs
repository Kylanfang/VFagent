// V-Fletch AI 员工自助体系：员工可经 API 自建 AI 员工、设定身份、转交调用权、组建临时部门
// 权限模型：员工只能操作归属自己的 AI 员工；管理员账号(boss)/观察员(observer)可管理全部；
// 模型 API 配置本身进共享池（共用大脑），"调用权"由 AI 员工的归属（owner_user_id）承载。
import { all, get, run } from "./db.mjs";
import { saveProvider } from "./settings.mjs";
import { loadModelConfig } from "./config.mjs";

function nowIso() {
  return new Date().toISOString();
}

// 本地时间戳 "YYYY-MM-DD HH:MM:SS"：与 SQLite datetime('now','localtime') 同口径。
// 授权码此前用 UTC 生成/显示，界面与本地差 8 小时且与 used_at 口径不一
function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function safeParseIds(raw) {
  try {
    const v = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function isStaff(user) {
  return user?.role === "boss" || user?.role === "observer";
}

/** 主控签发部门创建授权码：一次性、48 小时有效 */
export function issueTeamGrant(issuedBy) {
  const code = "TD-" + Math.random().toString(36).slice(2, 6).toUpperCase() + "-" + Math.random().toString(36).slice(2, 6).toUpperCase();
  const expires = localStamp(new Date(Date.now() + 48 * 3600 * 1000));
  run("INSERT INTO team_grants (code, issued_by, expires_at) VALUES (?,?,?)", code, String(issuedBy ?? "central"), expires);
  return { code, expiresAt: expires };
}

export function listTeamGrants() {
  return all("SELECT code, issued_by AS issuedBy, created_at AS createdAt, expires_at AS expiresAt, used_by AS usedBy, used_at AS usedAt FROM team_grants ORDER BY created_at DESC LIMIT 20");
}

export function getEmployeeById(id) {
  return get("SELECT * FROM ai_employees WHERE id = ?", id);
}

/** 员工可用的 AI 员工列表：自己的 + 公共的（有 API 绑定，排除前台/隐藏行）；管理员/观察员看全部 */
export function listChatEmployees(user) {
  const providers = loadModelConfig().providers ?? {};
  const annotate = (r) => ({ ...r, providerMissing: r.source_provider != null && providers[r.source_provider] == null });
  const rows = all(
    `SELECT e.id, e.name, e.identity, e.role, e.owner_user_id, e.source_provider, e.provider_id, e.model
     FROM ai_employees e
     WHERE e.id != 'front_desk'
       AND json_extract(COALESCE(e.meta,'{}'), '$.hidden') IS NULL
       AND (e.source_provider IS NOT NULL OR e.provider_id IS NOT NULL)
     ORDER BY (e.owner_user_id IS NULL) DESC, e.created_at`,
  );
  if (isStaff(user)) return rows.map((r) => ({ ...annotate(r), mine: r.owner_user_id === user?.id }));
  return rows
    .filter((r) => r.owner_user_id == null || r.owner_user_id === user?.id)
    .map((r) => ({ ...annotate(r), mine: r.owner_user_id === user?.id }));
}

/**
 * 创建 AI 员工（成员自助）：
 *  - providerFields：{label, baseUrl, model, apiKey} → 先落共享模型池（saveProvider），再建归属员工的 AI 员工
 *  - providerId：绑定已有公共 API
 */
export function createAiEmployee(user, { name, identity, providerFields, providerId }) {
  const empName = String(name ?? "").trim();
  if (empName === "") throw new Error("AI 员工名称不能为空");
  let boundProvider = null;
  if (providerFields != null && typeof providerFields === "object") {
    const { label, baseUrl, model, apiKey } = providerFields;
    if (!/^https?:\/\/.+/.test(String(baseUrl ?? ""))) throw new Error("Base URL 需以 http(s):// 开头");
    if (String(model ?? "").trim() === "") throw new Error("模型 ID 不能为空");
    if (String(apiKey ?? "").trim() === "") throw new Error("API Key 不能为空");
    const pid = `p_${String(label ?? model).toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 16) || "api"}_${Math.random().toString(36).slice(2, 6)}`;
    saveProvider({
      id: pid,
      fields: {
        label: String(label ?? model).trim(),
        protocol: "openai-compatible",
        baseUrl: String(baseUrl).trim(),
        model: String(model).trim(),
        apiKey: String(apiKey).trim(),
        supportsTools: true,
        supportsStream: true,
      },
      setActive: false, // 不抢占全局激活模型
    });
    boundProvider = pid;
  } else if (typeof providerId === "string" && providerId.trim() !== "") {
    boundProvider = providerId.trim();
    // hmr 案例根因：绑定不存在的 providerId 也照单全收，聊天时又静默回退到别的模型——
    // 用户以为在用 A 员工的 API，实际跑的是别的大脑。创建时即校验，杜绝"死绑定"
    if (loadModelConfig().providers?.[boundProvider] == null) {
      throw new Error(`要绑定的模型 API 不存在（${boundProvider}），请刷新列表后重新选择`);
    }
  } else {
    throw new Error("需提供模型 API 信息（新建）或选择已有 API（绑定）");
  }

  const id = `emp_u_${String(user?.username ?? "user").toLowerCase().replace(/[^a-z0-9_]/g, "")}_${boundProvider.replace(/[^A-Za-z0-9_-]/g, "").slice(-14)}`;
  const existing = get("SELECT id FROM ai_employees WHERE id = ?", id);
  if (existing != null) throw new Error(`已存在同名绑定的 AI 员工（${id}），可直接使用或改名称重试`);
  run(
    "INSERT INTO ai_employees (id, name, role, provider_id, source_provider, model, status, meta, owner_user_id, identity) VALUES (?, ?, ?, ?, ?, NULL, 'active', '{}', ?, ?)",
    id,
    empName.slice(0, 40),
    "AI 员工",
    boundProvider,
    boundProvider,
    user?.id ?? null,
    String(identity ?? "").trim().slice(0, 2000) || null,
  );
  return getEmployeeById(id);
}

/** 更新身份设定/名称（本人或管理员/观察员） */
export function updateAiEmployee(user, id, { name, identity }) {
  const emp = getEmployeeById(id);
  if (emp == null) throw new Error(`AI 员工不存在: ${id}`);
  if (!isStaff(user) && emp.owner_user_id !== user?.id) throw new Error("只能修改自己的 AI 员工");
  const nextName = name != null ? String(name).trim().slice(0, 40) : emp.name;
  const nextIdentity = identity != null ? String(identity).trim().slice(0, 2000) || null : emp.identity;
  run("UPDATE ai_employees SET name = ?, identity = ?, updated_at = ? WHERE id = ?", nextName, nextIdentity, nowIso(), id);
  return getEmployeeById(id);
}

/** 转交 API 调用权：把 AI 员工（含其 API 绑定）转给另一成员（本人或管理员/观察员可发起） */
export function transferAiEmployee(user, id, toUsername) {
  const emp = getEmployeeById(id);
  if (emp == null) throw new Error(`AI 员工不存在: ${id}`);
  if (!isStaff(user) && emp.owner_user_id !== user?.id) throw new Error("只能转交自己的 AI 员工");
  const target = get("SELECT * FROM users WHERE username = ?", String(toUsername ?? "").trim().toLowerCase());
  if (target == null) throw new Error(`目标用户不存在: ${toUsername}`);
  if (target.role === "boss") throw new Error("不能转给管理员账号（管理员本就可见全部）");
  run("UPDATE ai_employees SET owner_user_id = ?, updated_at = ? WHERE id = ?", target.id, nowIso(), id);
  return { ...getEmployeeById(id), transferredTo: target.username };
}

/** 聊天归属校验：员工能否使用某 AI 员工（自己的或公共的） */
export function canUseEmployee(user, employeeId) {
  if (employeeId == null) return false;
  const emp = getEmployeeById(employeeId);
  if (emp == null) return false;
  if (isStaff(user)) return true;
  return emp.owner_user_id == null || emp.owner_user_id === user?.id;
}

// ---- 临时部门（多 AI 协作）----

export function createTeam(user, { name, purpose, memberIds, memberUserIds, isProject, grantCode }) {
  const t = String(name ?? "").trim();
  if (t === "") throw new Error("名称不能为空");
  // 沙盒边界：主控/管理员可直接创建；普通成员必须持有效主控授权码（一次性，48 小时）
  let grant = null;
  if (!isStaff(user)) {
    const code = String(grantCode ?? "").trim().toUpperCase();
    if (code === "") throw new Error("成员创建部门需要主控授权码（请联系主控在组织页生成）");
    grant = get("SELECT * FROM team_grants WHERE code = ?", code);
    if (grant == null) throw new Error("授权码无效");
    if (grant.used_by != null) throw new Error("授权码已被使用");
    if (grant.expires_at < localStamp()) throw new Error("授权码已过期，请联系主控重新签发");
  }
  const members = Array.isArray(memberIds) ? memberIds.map(String).filter(Boolean) : [];
  const humans = Array.isArray(memberUserIds) ? memberUserIds.map(String).filter(Boolean) : [];
  if (!isProject && members.length < 1) throw new Error("部门至少需要 1 名 AI 员工");
  if (members.length > 6) throw new Error("最多 6 名 AI 员工");
  for (const m of members) {
    const emp = getEmployeeById(m);
    if (emp == null || emp.id === "front_desk") throw new Error(`AI 员工不可用: ${m}`);
    if (!isStaff(user) && emp.owner_user_id != null && emp.owner_user_id !== user?.id) {
      throw new Error(`不能把他人的 AI 员工加入: ${emp.name}`);
    }
  }
  if (grant != null) run("UPDATE team_grants SET used_by = ?, used_at = datetime('now','localtime') WHERE code = ?", user?.username ?? user?.id ?? "", grant.code);
  const id = `team_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  let sharedConv = null;
  if (isProject) {
    // 项目自带共享聊天页：项目成员（人类+AI）共用同一会话
    const { ensureConversation } = await_importRms();
    sharedConv = ensureConversation({ conversationId: id, employeeId: members[0] ?? "emp_default", title: `项目：${t.slice(0, 30)}`, source: "project", ownerUserId: user?.id });
  }
  run(
    "INSERT INTO ai_teams (id, name, purpose, member_ids, created_by, status, member_user_ids, is_project, shared_conversation_id) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)",
    id, t.slice(0, 40), String(purpose ?? "").trim().slice(0, 500) || null,
    JSON.stringify([...new Set(members)]), user?.id ?? null,
    JSON.stringify([...new Set(humans)]), isProject ? 1 : 0, sharedConv,
  );
  return getTeamById(id);
}

// 延迟 import（rms 依赖 team 的场景尚未出现，此方向安全）
import { ensureConversation } from "./rms.mjs";
function await_importRms() { return { ensureConversation }; }

export function getTeamById(id) {
  const row = get("SELECT * FROM ai_teams WHERE id = ?", id);
  return row == null ? null : { ...row, member_ids: safeParseIds(row.member_ids), member_user_ids: safeParseIds(row.member_user_ids) };
}

export function listTeams({ includeDisbanded = false } = {}) {
  // 组织管理：部门+项目统一返回，含人类成员与共享会话
  const rows = all(
    `SELECT t.* FROM ai_teams t ${includeDisbanded ? "" : "WHERE t.status = 'active'"} ORDER BY t.created_at DESC LIMIT 100`,
  );
  return rows.map((r) => ({ ...r, member_ids: safeParseIds(r.member_ids) }));
}

export function disbandTeam(user, id) {
  const team = getTeamById(id);
  if (team == null) throw new Error(`部门不存在: ${id}`);
  if (!isStaff(user) && team.created_by !== user?.id) throw new Error("只有创建者或管理员账号可以解散部门");
  run("UPDATE ai_teams SET status = 'disbanded' WHERE id = ?", id);
  return { id, disbanded: true };
}

/** 任务派活的部门展开：assignees 中的 "team:<id>" → 部门成员（接力上限 4 棒） */
export function expandAssignees(assignees) {
  const out = [];
  for (const a of assignees) {
    if (typeof a === "string" && a.startsWith("team:")) {
      const team = getTeamById(a.slice(5));
      if (team == null || team.status !== "active") throw new Error(`部门不存在或已解散: ${a}`);
      out.push(...team.member_ids);
    } else {
      out.push(a);
    }
  }
  const unique = [...new Set(out)];
  if (unique.length > 4) {
    // 不再静默截断（测试报告 P1）：超员让派活人明确知道，而不是以为都派到了
    throw new Error(`承接人共 ${unique.length} 名，超出接力协作上限 4 名，请精简部门成员或分批派活`);
  }
  return unique;
}
