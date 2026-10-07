// 回归后的隔离库清理：删掉不再被任何账号引用的测试 AI 员工与过期授权码，保持演示环境整洁
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const DB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".autotest", "vfletch.db");
const db = new DatabaseSync(DB);
db.exec("PRAGMA busy_timeout = 5000;");
const t0 = db.prepare(`
  DELETE FROM ai_employees WHERE id LIKE 'emp_u_%'
    AND owner_user_id IS NOT NULL
    AND owner_user_id NOT IN (SELECT id FROM users)
`).run();
const t1 = db.prepare(`
  DELETE FROM ai_employees WHERE id LIKE 'p_%' AND id NOT IN (SELECT DISTINCT provider_id FROM ai_employees WHERE provider_id IS NOT NULL)
    AND name IN ('小助','小助改','HMR 测试','新人')
`).run();
const t2 = db.prepare("DELETE FROM team_grants WHERE used_by IS NULL AND expires_at < datetime('now','localtime')").run();
const t3 = db.prepare("DELETE FROM audit_edit_requests WHERE status != 'pending'").run();
// 僵尸模型员工：provider 已不存在但 emp_<id> 还在
const { readFileSync } = await import("node:fs");
const MODEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".autotest", "model.json");
const providers = new Set(Object.keys(JSON.parse(readFileSync(MODEL, "utf8")).providers ?? {}));
const zombie = db.prepare("SELECT id, provider_id, owner_user_id FROM ai_employees WHERE id LIKE 'emp_%' AND provider_id IS NOT NULL AND owner_user_id IS NULL").all()
  .filter((r) => !providers.has(r.provider_id));
let z = 0;
for (const r of zombie) {
  for (const table of ["conversations", "messages", "risk_events", "usage_log"]) {
    db.prepare(`UPDATE ${table} SET employee_id = NULL WHERE employee_id = ?`).run(r.id);
  }
  z += db.prepare("DELETE FROM ai_employees WHERE id = ?").run(r.id).changes;
}
console.log(`清理僵尸模型员工 ${z}`);
const left = db.prepare("SELECT COUNT(*) AS c FROM ai_employees").get().c;
console.log(`清理僵尸模型员工 ${z}`);
console.log(`cleanup: 孤儿员工 ${t0.changes}，测试员工 ${t1.changes}，过期授权码 ${t2.changes}，历史审批 ${t3.changes}；剩余员工 ${left}`);
db.close();
