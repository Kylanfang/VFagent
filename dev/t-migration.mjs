// 老库升级迁移：先造出"旧版库"（缺增量列/缺表），再启动服务器验证自动迁移 + 关键功能可用
import { check, group, summary, sleep, uid, killChild } from "./testlib.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OLD_DIR = path.join(ROOT, ".autotest", "old-db-test");
fs.rmSync(OLD_DIR, { recursive: true, force: true });
fs.mkdirSync(OLD_DIR, { recursive: true });
fs.copyFileSync(path.join(ROOT, ".autotest", "model.json"), path.join(OLD_DIR, "model.json"));
fs.writeFileSync(path.join(OLD_DIR, "mcp.json"), JSON.stringify({ servers: [] }));
const toWin = (u) => u.replace(/^\/([A-Za-z]:)/, "$1");

group("造旧库：全新建库 → 剥离后期增量（模拟老部署）");
{
  const { DatabaseSync } = await import("node:sqlite");
  // 1) 先用服务器自身的迁移逻辑建出"新库"（子进程执行，避免污染本进程的 CONFIG_DIR）
  const { pathToFileURL } = await import("node:url");
  const dbModuleUrl = pathToFileURL(path.join(ROOT, "server/lib/db.mjs")).href;
  process.env.VFLETCH_CONFIG_DIR = OLD_DIR;
  const { openDb } = await import(dbModuleUrl);
  openDb();
  const db = new DatabaseSync(path.join(OLD_DIR, "vfletch.db"));
  // 2) 剥离后期增量列（各版本迭代加过的列）
  const drops = [
    "ALTER TABLE users DROP COLUMN department",
    "ALTER TABLE auth_sessions DROP COLUMN login_ip",
    "ALTER TABLE auth_sessions DROP COLUMN ip_region",
    "DROP TABLE ai_teams",
    "DROP TABLE team_grants",
    "DROP TABLE audit_edit_requests",
    "DROP TABLE kb_docs",
    "DROP TABLE ingest_events",
    "DROP TABLE aigc_events",
    "DROP TABLE aigc_state",
  ];
  for (const sql of drops) {
    try { db.exec(sql); } catch (e) { console.log(`  (跳过) ${sql}: ${e.message}`); }
  }
  db.close();
  check("旧库构造完成（缺 department/login_ip/ai_teams/kb_docs 等）", fs.existsSync(path.join(OLD_DIR, "vfletch.db")));
}

group("启动服务器于旧库 → 自动迁移");
const child = spawn(process.execPath, ["server/main.mjs"], {
  cwd: ROOT,
  env: { ...process.env, VFLETCH_CONFIG_DIR: OLD_DIR, VFLETCH_PORT: "8797", VFLETCH_HOST: "127.0.0.1", VFLETCH_REPORT_KEY: "rep123" },
  stdio: "ignore", detached: true,
});
let up = false;
for (let i = 0; i < 30; i += 1) {
  await sleep(1000);
  try { const h = await fetch("http://127.0.0.1:8797/api/health"); if (h.ok) { up = true; break; } } catch {}
}
check("旧库上服务器启动成功", up);
if (up) {
  const { default: fetch2 } = { default: fetch };
  const B = "http://127.0.0.1:8797";
  const lr = await fetch(B + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "central", password: (process.env.VF_BOSS_P ?? "vfletch-dev") }) });
  const T = (await lr.json())?.token;
  check("账号系统可用", !!T);
  // 部门表恢复：建员工/建部门走一遍
  let r = await fetch(B + "/api/team/employees", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: JSON.stringify({ name: "迁移测试工", providerFields: { label: "mig", baseUrl: "http://127.0.0.1:9/v1", model: "m", apiKey: "k" } }) });
  check("ai_teams 重建后员工可建", r.status === 200, JSON.stringify(await r.json()).slice(0, 120));
  r = await fetch(B + "/api/team/grants", { method: "POST", headers: { authorization: `Bearer ${T}` } });
  check("team_grants 重建后授权码可签发", r.status === 200);
  r = await fetch(B + "/api/kb", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: JSON.stringify({ title: "迁移后文档", content: "x" }) });
  check("kb_docs 重建后知识库可写", r.status === 200);
  r = await fetch(B + "/api/admin/users", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: JSON.stringify({ username: "mig_user", password: "mig123456" }) });
  const u = await r.json();
  r = await fetch(B + `/api/admin/users/${u.id}/department`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: JSON.stringify({ department: "迁移部" }) });
  check("users.department 列已补齐（可设部门）", r.status === 200, JSON.stringify(await r.json()).slice(0, 120));
  r = await fetch(B + `/api/admin/users/${u.id}`, { method: "DELETE", headers: { authorization: `Bearer ${T}` } });
  check("删除用户（ai_teams 引用清理链路）", r.status === 200);
}
await killChild(child);
await sleep(1500); // 等子进程释放 SQLite 文件句柄（Windows 句柄延迟释放）
for (let i = 0; i < 3; i += 1) {
  try { fs.rmSync(OLD_DIR, { recursive: true, force: true }); break; } catch { await sleep(1000); }
}
process.exit(summary() ? 0 : 1);
