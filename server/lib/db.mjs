// V-Fletch 监管数据库层（SQLite）
// 运行时用 Node 内置 node:sqlite（Electron 44 内嵌 Node 24 / dev Node 22 均可用，官方 SQLite 引擎，零外部依赖）
// DB 文件：CONFIG_DIR/vfletch.db（打包版 = %APPDATA%\v-fletch\config\vfletch.db）
// 管理/巡检可用 tools\sqlite-tools-win-x64\sqlite3.exe 打开同一文件
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONFIG_DIR } from "./config.mjs";
import { warn } from "./util.mjs";

const SCOPE = "db";
export const DB_FILE = path.join(CONFIG_DIR, "vfletch.db");

let db = null;

export function openDb() {
  if (db != null) return db;
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
  } catch {}
  const handle = new DatabaseSync(DB_FILE);
  // migrate() 依赖模块级 db：先挂上，成功后再"发布"；失败必须回退句柄。
  // 修复：原实现 `db = new DatabaseSync(...)` 在任何迁移语句之前就把句柄发布了，
  // 一旦 migrate() 中途抛错，下一次 openDb() 会直接返回这个**半迁移**的连接：
  // 缺失的表/列永远不会补，失败也永远不会重试，进程带着坏 schema 一直跑。
  db = handle;
  try {
    handle.exec("PRAGMA journal_mode = WAL;");
    handle.exec("PRAGMA foreign_keys = ON;");
    handle.exec("PRAGMA busy_timeout = 5000;");
    migrate();
  } catch (error) {
    db = null;
    try { handle.close(); } catch {}
    throw error;
  }
  return db;
}

export function closeDb() {
  try {
    db?.close();
  } catch {}
  db = null;
}

/** 轻量查询封装：values 用 ? 占位 */
export function all(sql, ...params) {
  const statement = openDb().prepare(sql);
  return statement.all(...params);
}
export function get(sql, ...params) {
  const statement = openDb().prepare(sql);
  return statement.get(...params);
}
export function run(sql, ...params) {
  const result = openDb().prepare(sql).run(...params);
  return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
}

function migrate() {
  db.exec(`
CREATE TABLE IF NOT EXISTS ai_employees (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  role        TEXT DEFAULT '办公助理',
  provider_id TEXT,
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'active',   -- active | suspended
  meta        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  employee_id   TEXT,
  title         TEXT,
  source        TEXT DEFAULT 'chat',
  status        TEXT DEFAULT 'open',            -- open | closed
  message_count INTEGER DEFAULT 0,
  tool_count    INTEGER DEFAULT 0,
  started_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  ended_at      TEXT,
  FOREIGN KEY (employee_id) REFERENCES ai_employees(id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,                -- user | assistant
  content         TEXT,
  reasoning       TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  arguments       TEXT,
  result          TEXT,
  is_error        INTEGER DEFAULT 0,
  duration_ms     INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id)
);
CREATE INDEX IF NOT EXISTS idx_toolcalls_conv ON tool_calls(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_toolcalls_name ON tool_calls(tool_name);

CREATE TABLE IF NOT EXISTS todos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT,
  task_key        TEXT NOT NULL,
  text            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | in_progress | completed
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (conversation_id, task_key)
);
CREATE INDEX IF NOT EXISTS idx_todos_conv ON todos(conversation_id, status);

CREATE TABLE IF NOT EXISTS risk_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id     TEXT,
  conversation_id TEXT,
  level           TEXT NOT NULL DEFAULT 'warning',  -- info | warning | critical
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  detail          TEXT,
  status          TEXT NOT NULL DEFAULT 'open',     -- open | resolved
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  resolved_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_risk_status ON risk_events(status, created_at);

CREATE TABLE IF NOT EXISTS usage_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id        TEXT,
  provider           TEXT,
  model              TEXT,
  prompt_tokens      INTEGER DEFAULT 0,
  completion_tokens  INTEGER DEFAULT 0,
  estimated_chars    INTEGER DEFAULT 0,
  cost_cents         INTEGER DEFAULT 0,
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_usage_time ON usage_log(created_at);

CREATE TABLE IF NOT EXISTS audit_rules (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'text_pattern',  -- tool_error | long_run | irreversible | sensitive_word | cost_spike | text_pattern
  level       TEXT NOT NULL DEFAULT 'warning',
  enabled     INTEGER NOT NULL DEFAULT 1,
  action      TEXT NOT NULL DEFAULT 'alert',        -- record | alert | confirm
  params      TEXT,                                 -- JSON：词表 / 正则 / 阈值
  hit_count   INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  updated_at  TEXT
);
`);

// 老库兼容：给既存 audit_rules 补增量列
const ruleCols = new Set(db.prepare("PRAGMA table_info(audit_rules)").all().map((c) => c.name));
for (const [col, ddl] of [
  ["kind", "ALTER TABLE audit_rules ADD COLUMN kind TEXT NOT NULL DEFAULT 'text_pattern'"],
  ["action", "ALTER TABLE audit_rules ADD COLUMN action TEXT NOT NULL DEFAULT 'alert'"],
  ["params", "ALTER TABLE audit_rules ADD COLUMN params TEXT"],
  ["hit_count", "ALTER TABLE audit_rules ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0"],
  ["updated_at", "ALTER TABLE audit_rules ADD COLUMN updated_at TEXT"],
]) {
  if (!ruleCols.has(col)) db.exec(ddl);
}

// ---- 账号系统：用户 + 登录会话 ----
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'employee',  -- boss | employee
  employee_id   TEXT,                              -- 关联 ai_employees（对话/留痕归属）
  status        TEXT NOT NULL DEFAULT 'active',    -- active | disabled
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_seen  TEXT,
  login_ip   TEXT,
  ip_region  TEXT
);

-- 登录限流状态（原在 auth.mjs 模块导入期建表；移入迁移以保证数据库不可用时能优雅降级）
CREATE TABLE IF NOT EXISTS auth_locks (
  key   TEXT PRIMARY KEY,
  fails INTEGER NOT NULL DEFAULT 0,
  until INTEGER
);
CREATE TABLE IF NOT EXISTS auth_ip_fails (
  ip         TEXT PRIMARY KEY,
  fails      INTEGER NOT NULL DEFAULT 0,
  window_end INTEGER
);
`);
// auth_sessions 增量列（老库兼容）：登录 IP 与归属地
const sessCols = new Set(db.prepare("PRAGMA table_info(auth_sessions)").all().map((c) => c.name));
for (const [col, ddl] of [
  ["login_ip", "ALTER TABLE auth_sessions ADD COLUMN login_ip TEXT"],
  ["ip_region", "ALTER TABLE auth_sessions ADD COLUMN ip_region TEXT"],
]) {
  if (!sessCols.has(col)) db.exec(ddl);
}

// users 补部门列：审计分权按"本人 / 本部门"判定可直接修改的范围
const userCols = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
if (!userCols.has("department")) db.exec("ALTER TABLE users ADD COLUMN department TEXT");

// conversations 补 owner 列（老数据 owner 为空 = 服务端的历史数据）
const convCols = new Set(db.prepare("PRAGMA table_info(conversations)").all().map((c) => c.name));
if (!convCols.has("owner_user_id")) {
  db.exec("ALTER TABLE conversations ADD COLUMN owner_user_id TEXT");
}

// ---- 任务派活（boss 委派 AI 员工 / 多员工接力协作）----
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  detail          TEXT,
  created_by      TEXT,
  assignees       TEXT NOT NULL,               -- JSON 数组：承接的 AI 员工 id（v1 支持 1-2 名接力）
  status          TEXT NOT NULL DEFAULT 'open', -- open | running | done | failed
  conversation_id TEXT,                        -- 共享协作会话（完整过程留痕）
  result_summary  TEXT,
  error           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT
);
`);
// messages 补归属列（接力协作中每条消息标注产出它的 AI 员工）
const msgCols = new Set(db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name));
if (!msgCols.has("employee_id")) {
  db.exec("ALTER TABLE messages ADD COLUMN employee_id TEXT");
}

// ---- AI 员工归属/身份 + 临时部门（多 AI 协作）----
const empCols = new Set(db.prepare("PRAGMA table_info(ai_employees)").all().map((c) => c.name));
for (const [col, ddl] of [
  ["owner_user_id", "ALTER TABLE ai_employees ADD COLUMN owner_user_id TEXT"],      // 归属用户（NULL=公共）
  ["identity", "ALTER TABLE ai_employees ADD COLUMN identity TEXT"],                 // 身份设定（注入系统提示）
  ["source_provider", "ALTER TABLE ai_employees ADD COLUMN source_provider TEXT"],   // 绑定的模型 API
]) {
  if (!empCols.has(col)) db.exec(ddl);
}

// 清理 VF 前台模型残留的员工记录（不作为 AI 员工存在）
// 外键约束下须先解除 conversations/risk_events/usage_log 的引用，否则迁移整库失败（降级内存模式）
// 修复：原谓词 `UPPER(provider_id) = 'VF' AND id != 'front_desk'` 会把**当前版本**为内置前台模型
// 创建的按人归属员工（emp_u_<user>_vf，provider_id 正是 'vf'）当成历史残留一并删除，
// 且先置空 conversations.employee_id —— 每次重启都静默丢失按人分账的归属数据。
// 真正要清理的只有历史遗留的那一条 emp_vf，因此把谓词收敛到 id 本身。
{
  const clearRefs = db.prepare(
    "UPDATE conversations SET employee_id = NULL WHERE employee_id NOT IN (SELECT id FROM ai_employees)",
  );
  const clearRiskRefs = db.prepare(
    "UPDATE risk_events SET employee_id = NULL WHERE employee_id NOT IN (SELECT id FROM ai_employees)",
  );
  const clearUsageRefs = db.prepare(
    "UPDATE usage_log SET employee_id = NULL WHERE employee_id NOT IN (SELECT id FROM ai_employees)",
  );
  const DOOMED = "UPPER(id) = 'EMP_VF' AND UPPER(id) != 'FRONT_DESK'";
  db.exec(`
    CREATE TEMP TABLE _doomed_emp AS
    SELECT id FROM ai_employees WHERE ${DOOMED};
  `);
  db.exec("UPDATE conversations SET employee_id = NULL WHERE employee_id IN (SELECT id FROM _doomed_emp)");
  db.exec("UPDATE risk_events SET employee_id = NULL WHERE employee_id IN (SELECT id FROM _doomed_emp)");
  db.exec("UPDATE usage_log SET employee_id = NULL WHERE employee_id IN (SELECT id FROM _doomed_emp)");
  db.exec("DROP TABLE _doomed_emp");
  db.exec(`DELETE FROM ai_employees WHERE ${DOOMED}`);
  // 治愈历史悬空引用（指向已不存在员工的行置空）
  clearRefs.run();
  clearRiskRefs.run();
  clearUsageRefs.run();
}

// ---- AI 生成内容监测（生成率 + 幻觉率）----
db.exec(`
CREATE TABLE IF NOT EXISTS aigc_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT NOT NULL,              -- user | assistant | file
  conversation_id TEXT,
  message_id      INTEGER,
  subject         TEXT,                       -- AI 员工名 / 文件相对路径
  ai_score        REAL,                       -- AI 相似度 0~1（assistant 恒为 1）
  claims          INTEGER,                    -- 数值主张总数（仅 assistant）
  ungrounded      INTEGER,                    -- 无依据主张数（仅 assistant）
  detail          TEXT,                       -- JSON：摘录 / 命中特征 / 幻觉示例
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_aigc_time ON aigc_events(created_at);
CREATE INDEX IF NOT EXISTS idx_aigc_kind ON aigc_events(kind, subject);
-- 幂等护栏：扫描失败（水位未推进）时下一轮会重扫同一批消息。没有这个唯一索引就会重复插行，
-- 使生成率/幻觉率的样本被重复放大。message_id 为 NULL 的文件事件不受影响（部分索引）。
CREATE UNIQUE INDEX IF NOT EXISTS idx_aigc_msg ON aigc_events(message_id) WHERE message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS aigc_state (
  key   TEXT PRIMARY KEY,                     -- 增量扫描水位（消息 id / 文件 mtime）
  value TEXT
);

CREATE TABLE IF NOT EXISTS kb_docs (
  id          TEXT PRIMARY KEY,               -- uuid
  title       TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT '',
  tags        TEXT,                           -- JSON 数组
  created_by  TEXT,
  status      TEXT NOT NULL DEFAULT 'active', -- active | archived
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_kb_status ON kb_docs(status, updated_at);

CREATE TABLE IF NOT EXISTS ingest_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject      TEXT,                          -- 上报来源（成员端员工 ID）
  kind         TEXT,                          -- turn / tool_call
  summary      TEXT,
  detail       TEXT,
  happened_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ingest_time ON ingest_events(created_at);

CREATE TABLE IF NOT EXISTS team_grants (
  code        TEXT PRIMARY KEY,               -- 部门创建授权码（主控签发）
  issued_by   TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at  TEXT NOT NULL,
  used_by     TEXT,
  used_at     TEXT
);

CREATE TABLE IF NOT EXISTS mcp_proposals (
  id           TEXT PRIMARY KEY,
  catalog_id   TEXT NOT NULL,                 -- 目录条目 id
  spec         TEXT NOT NULL,                 -- 完整安装规格 JSON（审批后按此安装）
  reason       TEXT,
  requested_by TEXT NOT NULL,                 -- 用户名
  role         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | failed
  install_error TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  decided_at   TEXT
);

CREATE TABLE IF NOT EXISTS audit_edit_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  payload      TEXT NOT NULL,                 -- JSON：原始编辑操作
  requested_by TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | applied | rejected
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  decided_at   TEXT
);
`);

// ai_teams：先确保表存在（全新库），再补增量列（老库兼容）。
// 2026-09-10 修复：此前 ALTER 在 CREATE 之前执行，全新数据库上抛 "no such table: ai_teams"，
// 迁移中途终止且被启动 try/catch 吞掉 → 新部署的部门/项目/删除用户全部失效。
db.exec(`
CREATE TABLE IF NOT EXISTS ai_teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  purpose     TEXT,
  member_ids  TEXT NOT NULL,               -- JSON：AI 员工 id 数组（临时部门成员）
  created_by  TEXT,
  status      TEXT NOT NULL DEFAULT 'active',  -- active | disbanded
  member_user_ids TEXT,                        -- JSON：人类成员 user id
  is_project  INTEGER DEFAULT 0,               -- 1=项目（有共享聊天页）
  shared_conversation_id TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);
const teamCols = new Set(db.prepare("PRAGMA table_info(ai_teams)").all().map((c) => c.name));
for (const [col, ddl] of [
  ["member_user_ids", "ALTER TABLE ai_teams ADD COLUMN member_user_ids TEXT"],
  ["is_project", "ALTER TABLE ai_teams ADD COLUMN is_project INTEGER DEFAULT 0"],
  ["shared_conversation_id", "ALTER TABLE ai_teams ADD COLUMN shared_conversation_id TEXT"],
]) {
  if (!teamCols.has(col)) db.exec(ddl);
}

  // 种子：默认 AI 员工
  const count = get("SELECT COUNT(*) AS c FROM ai_employees")?.c ?? 0;
  if (count === 0) {
    try {
      run(
        "INSERT INTO ai_employees (id, name, role, provider_id, model, status, meta) VALUES (?, ?, ?, ?, ?, 'active', ?)",
        "emp_default",
        "V-Fletch 办公体（默认）",
        "办公助理",
        null,
        null,
        JSON.stringify({ note: "系统内置默认员工；可在此新建并按模型/职责拆分" }),
      );
    } catch (error) {
      warn(SCOPE, "种子员工写入失败", { error: String(error?.message ?? error) });
    }
  }

  // 种子：内置监管规则（risk 扫描用；params 为 JSON：词表/阈值/正则）
  const seedRules = [
    {
      code: "R_TOOL_ERROR", name: "工具执行失败", kind: "tool_error", level: "warning", action: "alert",
      params: null, description: "工具调用返回 isError=true，需复核是否影响任务结果",
    },
    {
      code: "R_SENSITIVE_TOPIC", name: "敏感事项涉足", kind: "sensitive_word", level: "info", action: "alert",
      params: { words: ["资金转账", "汇款", "付款", "银行卡号", "身份证号", "客户隐私", "内部数据", "商业机密", "对外发送"] },
      description: "对话内容命中敏感词表（资金转账/合同/隐私/个人信息等），词表可在规则中心维护",
    },
    {
      code: "R_COST_SPIKE", name: "成本突增", kind: "cost_spike", level: "warning", action: "alert",
      params: { maxTurnTokens: 60000 },
      description: "单轮会话累计 token 超过阈值，需检查是否异常循环或上下文过长",
    },
    {
      code: "R_LONG_RUN", name: "长时间执行", kind: "long_run", level: "info", action: "alert",
      params: null, description: "单轮工具轮次达到上限，可能存在死循环",
    },
    {
      code: "R_IRREVERSIBLE", name: "疑似不可逆动作", kind: "irreversible", level: "critical", action: "confirm",
      params: null, description: "模型输出疑似执行不可逆动作（删除/发送/支付）而未先征得确认",
    },
  ];
  const ruleCount = get("SELECT COUNT(*) AS c FROM audit_rules")?.c ?? 0;
  if (ruleCount === 0) {
    const insert = db.prepare(
      "INSERT INTO audit_rules (code, name, kind, level, enabled, action, params, description, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?, datetime('now','localtime'))",
    );
    for (const r of seedRules) insert.run(r.code, r.name, r.kind, r.level, r.action, r.params == null ? null : JSON.stringify(r.params), r.description);
  } else {
    // 老库回填：给既存内置规则补 kind/action/params。
    // 修复：原实现无条件覆盖 kind/action 并在每次启动重写 updated_at —— 用户在规则中心改过的
    // 类型/处置（如把 R_TOOL_ERROR 改成“仅记录”）会在重启后被静默改回种子值，规则中心还显示“刚刚更新”。
    // 现在只回填仍处于 ALTER 默认值、且名称未被改动的"原始行"；params 仍用 COALESCE 保护用户值。
    const backfill = db.prepare(
      "UPDATE audit_rules SET kind = ?, action = ?, params = COALESCE(params, ?) WHERE code = ? AND name = ? AND kind IN ('text_pattern', '') AND action IN ('alert', '')",
    );
    for (const r of seedRules) {
      backfill.run(r.kind, r.action, r.params == null ? null : JSON.stringify(r.params), r.code, r.name);
    }
  }
}

// ---- 便于外部直接使用的便捷断言 ----
export function dbHealthy() {
  try {
    // 先真正跑一遍 openDb()：迁移失败必须向上暴露为 ok:false。
    // 修复：原实现直接 get()，而 openDb() 的迁移异常会被外层 try 吞成 ok:false，
    // 随后 main.mjs 再调一次 openDb() 却拿到"看起来正常"的坏句柄，降级分支永远不会触发。
    openDb();
    const row = get("SELECT sqlite_version() AS v");
    return { ok: true, sqlite: row?.v, file: DB_FILE };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
