// V-Fletch 账号系统：主控（boss）/ 员工（employee）两级
// - 密码 scrypt 加盐哈希（node:crypto 内置，零依赖），明文永不落盘
// - 会话为 32 字节随机 token（SQLite 持久化，24h 过期，登出即失效）
// - 员工账号自动关联一名 AI 员工档案（对话/留痕按人分账）
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { all, get, run } from "./db.mjs";
import { ensureEmployee } from "./rms.mjs";

const SESSION_HOURS = 24;
const MAX_FAILS = Number(process.env.VFLETCH_MAX_FAILS ?? 5);
const LOCK_MINUTES = 5;

export function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(String(password), salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored ?? "").split(":");
  if (!salt || !hash) return false;
  const test = scryptSync(String(password), salt, 64);
  const orig = Buffer.from(hash, "hex");
  return orig.length === test.length && timingSafeEqual(orig, test);
}

// 用户不存在时用于等价开销校验的哑哈希（防用户名枚举时序侧信道，见 SEC-06）
const DUMMY_HASH = hashPassword("__vfletch_nonexistent_user__");

function nowIso() {
  return new Date().toISOString();
}

function expiresIn(hours) {
  return new Date(Date.now() + hours * 3600_000).toISOString();
}

// ---- 首次启动：种子管理员账号 ----
// 初始密码：优先取环境变量 VF_BOSS_P。未设置时使用**公开的开发默认口令**（非机密，仅供本机首次登录），
// 启动日志会明确提示修改；面向他人开放前请务必设置 VF_BOSS_P 或登录后立即改密。
export const DEV_DEFAULT_PASSWORD = "vfletch-dev";
export function seedBoss() {
  const count = get("SELECT COUNT(*) AS c FROM users")?.c ?? 0;
  if (count > 0) return null;
  const id = "u_central";
  const envPw = String(process.env.VF_BOSS_P ?? "");
  const password = envPw !== "" ? envPw : DEV_DEFAULT_PASSWORD;
  ensureEmployee({ id: "emp_central", name: "管理员账号", role: "管理员" });
  run(
    "INSERT INTO users (id, username, password_hash, display_name, role, employee_id) VALUES (?, ?, ?, ?, 'boss', ?)",
    id,
    "central",
    hashPassword(password),
    "管理员账号",
    "emp_central",
  );
  return { username: "central", password, generated: envPw === "" };
}

// ---- 登录限流（按 用户名+客户端IP，防跨 IP 锁号 DoS；另设 IP 维度全局阈值） ----
// 修复 SEC-07（原审计 §四.2 账号锁定 DoS）：原限流键仅为用户名，攻击者可自任意 IP 错密 5 次
// 即锁死任意账号（含主控）。改为 (用户名, 客户端IP) 组合键 —— 攻击者只能锁死「自己 IP 对目标账号」
// 的尝试，目标账号从其真实 IP 登录不受影响。另加 IP 维度全局失败阈值，抑制分布式爆破。
const failsByKey = new Map(); // `${username}\0${ip}` -> { count, until }
const ipFails = new Map();    // ip -> { count, windowEnd }（IP 维度滑动窗口失败计数；windowEnd 仅标记窗口，不表示已限流）
const IP_MAX_FAILS = Number(process.env.VFLETCH_IP_MAX_FAILS ?? 60); // 单 IP 在窗口内最多失败次数（跨用户名累计），超过则限流该 IP；测试环境经 env 放开，避免回归套件的故意坏登录互相污染
const IP_WINDOW_MS = 10 * 60_000;

// ---- 失败计数落库（重启后限流状态不丢失，避免攻击者借重启绕过限流窗口） ----
// 修复：原先这两条 CREATE TABLE 在**模块导入时**执行，早于 main.mjs 的数据库降级 try/catch，
// 一旦数据库不可用就是导入期未捕获异常（进程直接死），"降级为仅内存监控"分支永远走不到。
// 表结构已移入 db.mjs 的 migrate()；这里只做一次惰性加载，失败则退回内存态限流。
let failsHydrated = false;
function hydrateFailsOnce() {
  if (failsHydrated) return;
  failsHydrated = true;
  hydrateFails();
}
function hydrateFails() {
  try {
    for (const r of all("SELECT key, fails, until FROM auth_locks")) {
      if (r.until == null || r.until > Date.now()) failsByKey.set(r.key, { count: r.fails ?? 0, until: r.until });
    }
    for (const r of all("SELECT ip, fails, window_end FROM auth_ip_fails")) {
      if (r.window_end == null || r.window_end > Date.now()) ipFails.set(r.ip, { count: r.fails ?? 0, windowEnd: r.window_end });
    }
  } catch { /* 表尚未就绪/数据库不可用时忽略，限流退化为纯内存 */ }
}
function persistLock(key, rec) {
  if (!rec || (rec.count === 0 && rec.until == null)) { run("DELETE FROM auth_locks WHERE key=?", key); return; }
  run("INSERT INTO auth_locks(key, fails, until) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET fails=excluded.fails, until=excluded.until", key, rec.count ?? 0, rec.until ?? null);
}
function persistIp(ip, rec) {
  const ipk = ip ?? "";
  if (!rec || (rec.count === 0 && rec.windowEnd == null)) { run("DELETE FROM auth_ip_fails WHERE ip=?", ipk); return; }
  run("INSERT INTO auth_ip_fails(ip, fails, window_end) VALUES(?,?,?) ON CONFLICT(ip) DO UPDATE SET fails=excluded.fails, window_end=excluded.window_end", ipk, rec.count ?? 0, rec.windowEnd ?? null);
}
hydrateFailsOnce();

// 分隔符必须用可打印字符：早期版本用 \u0000 做分隔，落库后 SQLite 的 TEXT 长度/比较语义
// 在 NUL 处截断（`length(key)` 只数到 NUL 前），重启 hydrate 时键对不上，等于"重启即清零"。
// `|` 不会被用户名占用（createUser 限定 [a-z0-9_]{3,24}），是这里唯一安全的选择。
function lockKey(uname, ip) { return `${uname}|${ip ?? ""}`; }

function locked(uname, ip) {
  const rec = failsByKey.get(lockKey(uname, ip));
  if (rec == null) return false;
  if (rec.until != null && Date.now() < rec.until) return true;
  if (rec.until != null && Date.now() >= rec.until) { failsByKey.delete(lockKey(uname, ip)); persistLock(lockKey(uname, ip), null); return false; }
  return false;
}

// 修复：仅当该 IP 在滑动窗口内失败次数达到 IP_MAX_FAILS 才限流；
// 原实现在首次失败即把 until 设为未来时间，导致 ipThrottled 误判「已限流」（一次错密就锁死整个 IP 10 分钟）
function ipThrottled(ip) {
  const rec = ipFails.get(ip ?? "");
  if (rec == null) return false;
  if (Date.now() >= rec.windowEnd) { ipFails.delete(ip ?? ""); persistIp(ip ?? "", null); return false; } // 滑动窗口已过，重置
  return rec.count >= IP_MAX_FAILS;
}

function recordFail(uname, ip) {
  const k = lockKey(uname, ip);
  const rec = failsByKey.get(k) ?? { count: 0, until: null };
  rec.count += 1;
  if (rec.count >= MAX_FAILS) {
    rec.until = Date.now() + LOCK_MINUTES * 60_000;
    rec.count = 0;
  }
  failsByKey.set(k, rec);
  persistLock(k, rec);
  // IP 维度累计（滑动窗口）：抑制单 IP 对多账号的分布式爆破
  const now = Date.now();
  const ir = ipFails.get(ip ?? "") ?? { count: 0, windowEnd: now + IP_WINDOW_MS };
  if (ir.windowEnd != null && now >= ir.windowEnd) { ir.count = 0; ir.windowEnd = now + IP_WINDOW_MS; }
  ir.count += 1;
  if (ir.count >= IP_MAX_FAILS) ir.windowEnd = now + IP_WINDOW_MS; // 超限则整个窗口限流该 IP
  ipFails.set(ip ?? "", ir);
  persistIp(ip ?? "", ir);
}

// ---- 会话 ----
function cleanupSessions() {
  run("DELETE FROM auth_sessions WHERE expires_at < ?", nowIso());
}

export function createUser({ username, password, display_name, role }) {
  const uname = String(username ?? "").trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(uname)) throw new Error("用户名需为 3-24 位小写字母/数字/下划线");
  if (String(password ?? "").length < 6) throw new Error("密码至少 6 位");
  if (!["boss", "employee", "observer"].includes(role ?? "employee")) throw new Error("role 仅支持 boss / observer / employee");
  if (get("SELECT id FROM users WHERE username = ?", uname) != null) throw new Error(`用户名已存在: ${uname}`);
  const id = `u_${uname}_${randomBytes(3).toString("hex")}`;
  let employeeId = null;
  if ((role ?? "employee") === "employee") {
    employeeId = `emp_u_${uname}`;
    ensureEmployee({ id: employeeId, name: String(display_name ?? uname).trim() || uname, role: "员工" });
  }
  run(
    "INSERT INTO users (id, username, password_hash, display_name, role, employee_id) VALUES (?, ?, ?, ?, ?, ?)",
    id, uname, hashPassword(password), String(display_name ?? uname).trim() || uname, role ?? "employee", employeeId,
  );
  return safeUser(get("SELECT * FROM users WHERE id = ?", id));
}

export function login({ username, password, clientIp }) {
  const uname = String(username ?? "").trim().toLowerCase();
  cleanupSessions();
  if (ipThrottled(clientIp)) throw new Error("请求过于频繁，请稍后再试");
  if (locked(uname, clientIp)) throw new Error("失败次数过多，账号已临时锁定 5 分钟");
  const user = get("SELECT * FROM users WHERE username = ?", uname);
  // 修复 SEC-06：原写法 `user == null || !verifyPassword(...)` 短路求值，
  // 用户不存在时跳过 scrypt，导致登录耗时相差 10 倍（实测 36.4ms vs 3.4ms）→ 可枚举用户名。
  // 现在无论用户是否存在都执行一次等价开销的哈希校验。
  const ok = verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
  if (user == null || !ok) {
    recordFail(uname, clientIp);
    throw new Error("用户名或密码错误");
  }
  if (user.status !== "active") throw new Error("账号已被停用，请联系主控");
  failsByKey.delete(lockKey(uname, clientIp));
  persistLock(lockKey(uname, clientIp), null);
  const token = randomBytes(32).toString("hex");
  run("INSERT INTO auth_sessions (token, user_id, expires_at, last_seen) VALUES (?, ?, ?, ?)", token, user.id, expiresIn(SESSION_HOURS), nowIso());
  return { token, user: safeUser(user) };
}

export function logout(token) {
  run("DELETE FROM auth_sessions WHERE token = ?", String(token ?? ""));
  return { ok: true };
}

export function verifyToken(token) {
  if (typeof token !== "string" || token === "") return null;
  const row = get(
    "SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at >= ?",
    token,
    nowIso(),
  );
  if (row == null) return null;
  if (row.status !== "active") return null;
  run("UPDATE auth_sessions SET last_seen = ? WHERE token = ?", nowIso(), token);
  return safeUser(row);
}

export function listUsers() {
  return all(
    `SELECT u.id, u.username, u.display_name, u.role, u.status, u.employee_id, u.created_at, u.department,
       (SELECT COUNT(*) FROM conversations c WHERE c.owner_user_id = u.id) AS conversation_count
     FROM users u ORDER BY u.role = 'boss' DESC, u.created_at`,
  ).map(safeUser);
}

export function safeUser(user) {
  if (user == null) return null;
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    role: user.role,
    employee_id: user.employee_id,
    status: user.status,
    created_at: user.created_at,
    department: user.department ?? null,
  };
}

// 部门归属（主控设置）：审计分权按本人/本部门判定
export function setUserDepartment(id, department) {
  const user = get("SELECT * FROM users WHERE id = ?", id);
  if (user == null) throw new Error(`用户不存在: ${id}`);
  const dept = String(department ?? "").trim().slice(0, 40);
  run("UPDATE users SET department = ? WHERE id = ?", dept === "" ? null : dept, id);
  return safeUser(get("SELECT * FROM users WHERE id = ?", id));
}

export function setUserStatus(id, status) {
  if (!["active", "disabled"].includes(status)) throw new Error("status 仅支持 active / disabled");
  const user = get("SELECT * FROM users WHERE id = ?", id);
  if (user == null) throw new Error(`用户不存在: ${id}`);
  if (user.role === "boss") throw new Error("不能停用主控账号");
  run("UPDATE users SET status = ? WHERE id = ?", status, id);
  if (status === "disabled") run("DELETE FROM auth_sessions WHERE user_id = ?", id); // 踢下线
  return safeUser(get("SELECT * FROM users WHERE id = ?", id));
}

// 管理员账号授权：成员(employee) ↔ 观察员(observer，与管理员相同的监管视图)；boss 角色不可通过此接口变更
export function setUserRole(id, role) {
  if (!["employee", "observer"].includes(role)) throw new Error("role 仅支持 employee / observer");
  const user = get("SELECT * FROM users WHERE id = ?", id);
  if (user == null) throw new Error(`用户不存在: ${id}`);
  if (user.role === "boss") throw new Error("管理员账号角色不可变更");
  run("UPDATE users SET role = ? WHERE id = ?", role, id);
  return safeUser(get("SELECT * FROM users WHERE id = ?", id));
}

export function resetPassword(id, password) {
  if (String(password ?? "").length < 6) throw new Error("密码至少 6 位");
  const user = get("SELECT * FROM users WHERE id = ?", id);
  if (user == null) throw new Error(`用户不存在: ${id}`);
  run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), id);
  run("DELETE FROM auth_sessions WHERE user_id = ?", id);
  return { ok: true };
}

// 移除账号（主控专属操作；主控自身不可移除）
// - 立即踢下线（删会话）
// - 清理其 AI 身份记录：关联档案 users.employee_id + 归属其名下动态建档的员工（owner_user_id）
//   外键约束（conversations.employee_id → ai_employees）下须先解除留痕表的引用再删，
//   与 db.mjs migrate 里清理残留员工的做法一致；对话/消息/风险/用量记录本身保留（监管留痕不随账号消失）
// - 从团队的人类成员列表中摘除
// 整个过程在一个事务里，任一步失败整体回滚
export function deleteUser(id) {
  const user = get("SELECT * FROM users WHERE id = ?", id);
  if (user == null) throw new Error(`用户不存在: ${id}`);
  // 修复 SEC-04：原为"boss 一律不可移除"，导致越权建立的 boss 账号连真主控也删不掉（持久化后门）。
  // 改为"必须保留至少一个启用中的主控账号"。
  if (user.role === "boss") {
    const bosses = get("SELECT COUNT(*) AS c FROM users WHERE role = 'boss' AND status = 'active'")?.c ?? 0;
    if (bosses <= 1) throw new Error("至少需保留一个主控账号");
  }

  const empIds = new Set();
  if (user.employee_id) empIds.add(user.employee_id);
  for (const row of all("SELECT id FROM ai_employees WHERE owner_user_id = ?", id)) empIds.add(row.id);
  // 关联档案若仍被其他账号引用（理论上不会发生），保守起见不删
  for (const eid of [...empIds]) {
    const shared = get("SELECT COUNT(*) AS c FROM users WHERE employee_id = ? AND id != ?", eid, id)?.c ?? 0;
    if (shared > 0) empIds.delete(eid);
  }

  run("BEGIN");
  try {
    const sessions = run("DELETE FROM auth_sessions WHERE user_id = ?", id).changes;
    let employees = 0;
    for (const eid of empIds) {
      run("UPDATE conversations SET employee_id = NULL WHERE employee_id = ?", eid);
      run("UPDATE messages SET employee_id = NULL WHERE employee_id = ?", eid);
      run("UPDATE risk_events SET employee_id = NULL WHERE employee_id = ?", eid);
      run("UPDATE usage_log SET employee_id = NULL WHERE employee_id = ?", eid);
      employees += run("DELETE FROM ai_employees WHERE id = ?", eid).changes;
    }
    let teams = 0;
    for (const t of all("SELECT id, member_user_ids FROM ai_teams WHERE member_user_ids LIKE ?", `%${id}%`)) {
      let ids = [];
      try { ids = JSON.parse(t.member_user_ids ?? "[]"); } catch { ids = []; }
      if (!Array.isArray(ids) || !ids.includes(id)) continue;
      run("UPDATE ai_teams SET member_user_ids = ? WHERE id = ?", JSON.stringify(ids.filter((x) => x !== id)), t.id);
      teams += 1;
    }
    run("DELETE FROM users WHERE id = ?", id);
    run("COMMIT");
    return { ok: true, removed: safeUser(user), cleaned: { sessions, employees, teams } };
  } catch (error) {
    try { run("ROLLBACK"); } catch {}
    throw error;
  }
}
