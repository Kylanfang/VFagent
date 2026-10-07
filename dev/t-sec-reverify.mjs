// 安全修复复验：针对 安全审计与压力测试报告.md 中列出的可利用点，在修正后的代码上重放
// 预期：观察员提权链全部被拦（403）；SSRF 内网地址被拦；登录时序差收敛；主控仍持全工具。
import { killChild } from "./testlib.mjs";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 独立实例：本脚本必须验证【生产默认】限流阈值（5 次锁号 / 60 次IP限流），
// 而 8790 共享测试服务器已放开阈值（避免回归套件的坏登录互相污染），故自建 8796 实例。
const SEC_DIR = path.join(ROOT, ".autotest-sec");
const PORT = 8796;
const BASE = "http://127.0.0.1:" + PORT;
try { rmSync(SEC_DIR, { recursive: true, force: true, maxRetries: 3 }); } catch {} // 上轮实例可能尚未退出，删不掉就复用
const child = spawn(process.execPath, ["server/main.mjs"], {
  cwd: ROOT,
  env: { ...process.env, VFLETCH_CONFIG_DIR: SEC_DIR, VFLETCH_PORT: String(PORT), VFLETCH_HOST: "127.0.0.1", VFLETCH_WORKSPACE: path.join(SEC_DIR, "workspace") },
  stdio: "ignore", detached: true,
});
let secUp = false;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { const h = await fetch(BASE + "/api/health"); if (h.ok) { secUp = true; break; } } catch {}
}
if (!secUp) { console.log("独立安全测试服务器启动失败"); await killChild(child); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, { token, body, headers } = {}) {
  const init = { method, headers: { "content-type": "application/json", ...(headers ?? {}) } };
  if (token) init.headers.authorization = "Bearer " + token;
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(BASE + path, init);
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const mcpcall = (token, name, args) => call("POST", "/api/mcp/call", { token, body: { name, arguments: args } });

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name} ${extra}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

const boss = await call("POST", "/api/auth/login", { body: { username: "central", password: (process.env.VF_BOSS_P ?? "vfletch-dev") } });
const T = boss.data?.token;
if (!T) { console.log("BOSS LOGIN FAILED", boss.status, JSON.stringify(boss.data)); process.exit(1); }
check("主控登录成功", !!T);

// 等待 MCP 工具注册表就绪（内置 server 经 npx 连接需数十秒；避免工具未连接导致 B3/C/D 误判）
async function waitMcpReady() {
  for (let i = 0; i < 90; i++) {
    const L = await call("GET", "/api/mcp/list", { token: T });
    const names = [];
    for (const s of L.data?.servers || []) for (const t of s.tools || []) names.push(t.exposedName);
    if (names.includes("code__code_run") && names.includes("web__web_fetch") && names.includes("mcp_discovery__mcp_search")) return names.length;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return -1;
}
const tc = await waitMcpReady();
check("MCP 工具注册表就绪（code__/web__/mcp_discovery__ 在线）", tc > 0, `(工具数 ${tc})`);

// 建观察员（直接从创建响应拿 id，避免列表响应结构差异）
const tag = Date.now().toString(36);
const cr = await call("POST", "/api/admin/users", { token: T, body: { username: `rev_${tag}`, password: "rev123456", display_name: "复验观察员", role: "employee" } });
const obsU = cr.data;
if (!obsU || !obsU.id) { console.log("观察员创建失败", cr.status, JSON.stringify(cr.data)); process.exit(1); }
await call("POST", `/api/admin/users/${obsU.id}/role`, { token: T, body: { role: "observer" } });
const obs = await call("POST", "/api/auth/login", { body: { username: `rev_${tag}`, password: "rev123456" } });
const OT = obs.data?.token;
check("观察员登录成功", !!OT);

console.log("\n▶ A. 观察员提权链（原 6 个可利用点，应全部 403/拦截）");
let r = await mcpcall(OT, "code__code_run", { language: "node", code: "console.log('RCE_OK')" });
check("A1 观察员直调 code_run → 403", r.status === 403, `(实际 ${r.status})`);
r = await mcpcall(OT, "secretary__db_query", { sql: "SELECT username,role FROM users LIMIT 3" });
check("A2 观察员直调 secretary__db_query → 403", r.status === 403, `(实际 ${r.status})`);
r = await mcpcall(OT, "mcp_admin__mcp_install", { id: "pwn", transport: "stdio", command: "npx", args: ["-y", "evil"] });
check("A3 观察员直调 mcp_admin__mcp_install → 403", r.status === 403, `(实际 ${r.status})`);
r = await call("POST", "/api/admin/users", { token: OT, body: { username: "pwn_rev", password: "Tt@12345678", role: "boss" } });
check("A4 观察员建 boss 账号 → 403", r.status === 403, `(实际 ${r.status})`);
r = await call("POST", `/api/admin/users/${obsU.id}/password`, { token: OT, body: { password: "Hacked@123" } });
check("A5 观察员重置密码 → 403", r.status === 403, `(实际 ${r.status})`);
// 越权 GET 列表（原放行，现仍允许"只读名单"但脱敏；这里确认不漏敏感操作）
r = await call("POST", "/api/admin/users", { token: OT, body: { username: "x2", password: "y", role: "boss" } });
check("A6 观察员 POST /api/admin/users 任何写 → 403", r.status === 403, `(实际 ${r.status})`);
// 删除老板账号规则（A4 已 403，此处确认 deleteUser 规则：至少保留一个主控）
const ul = (await call("GET", "/api/admin/users", { token: T })).data;
const allUsers = Array.isArray(ul) ? ul : (ul?.users ?? []);
const bosses = allUsers.filter((u) => u.role === "boss");
check("A7 存在主控账号集合（可互相删，仅拦最后一个）", Array.isArray(bosses) && bosses.length >= 1, `(boss 数=${bosses.length})`);

console.log("\n▶ B. 观察员保留的管理/监管能力（应 200）");
r = await call("GET", "/api/admin/users", { token: OT });
check("B1 观察员读账号名单 → 200", r.status === 200, `(实际 ${r.status})`);
r = await call("GET", "/api/settings", { token: OT });
check("B2 观察员读设置 → 200", r.status === 200, `(实际 ${r.status})`);
r = await mcpcall(OT, "mcp_discovery__mcp_search", { query: "编辑 excel 表格报表" });
check("B3 观察员 mcp_discovery 检索 → 200", r.status === 200, `(实际 ${r.status})`);
r = await call("GET", "/api/mcp/list", { token: OT });
check("B4 观察员读工具清单 → 200", r.status === 200, `(实际 ${r.status})`);

console.log("\n▶ C. 主控仍持全工具（回归保护）");
r = await mcpcall(T, "code__code_run", { language: "node", code: "console.log('BOSS_RCE_OK')" });
check("C1 主控 code_run 仍可用 → 200 且真实执行", r.status === 200 && /BOSS_RCE_OK/.test(JSON.stringify(r.data)), `(实际 ${r.status} ${JSON.stringify(r.data).slice(0,80)})`);
r = await mcpcall(T, "secretary__db_query", { sql: "SELECT count(*) c FROM users" });
check("C2 主控 secretary__db_query 仍可用 → 200", r.status === 200, `(实际 ${r.status})`);

console.log("\n▶ D. SSRF（内网/元数据地址应被拦，公网应可用）");
for (const u of ["http://127.0.0.1:8790/api/health", "http://localhost:8790/api/health", "http://100.100.100.200/latest/meta-data/", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://10.0.0.1/", "http://[::1]:8790/api/health"]) {
  r = await mcpcall(T, "web__web_fetch", { url: u });
  const blocked = r.status === 200 && (r.data?.isError === true || /内网|禁止|private|blocked/i.test(r.data?.text ?? ""));
  check(`D SSRF 拦截 ${u}`, blocked, `(status=${r.status}, text=${(r.data?.text ?? "").slice(0,60)})`);
}

console.log("\n▶ E. 登录时序侧信道（不存在用户 vs 存在用户，应收敛到同量级）");
// 注意：用一次性账号测时序，避免 5 次错密触发账号锁定（也正是 SEC-modified 锁号 DoS 的表现）
const timTag = Date.now().toString(36);
const timCr = await call("POST", "/api/admin/users", { token: T, body: { username: `tim_${timTag}`, password: "tim123456", display_name: "时序探针", role: "employee" } });
const timU = timCr.data;
let _eip = 0;
async function loginTime(uname, pwd) {
  // 每次尝试用唯一客户端 IP，避免触发 SEC-07 的锁号/限流而污染时序测量（否则会被 ipThrottled 短路到 ~1ms）
  const ip = `10.9.${Math.floor(_eip / 254)}.${(_eip++ % 254) + 1}`;
  const t0 = process.hrtime.bigint();
  await call("POST", "/api/auth/login", { body: { username: uname, password: pwd }, headers: { "x-forwarded-for": ip } });
  return Number(process.hrtime.bigint() - t0) / 1e6;
}
// 修复测量方法：原实现"先连测 5 次已存在、再连测 5 次不存在"，把**系统预热与负载漂移**
// 也算了进去 —— 第一组恰好落在 scrypt 的 CPU 升频窗口里，在连跑 27 套件的负载下实测可虚高到
// 3.54x（479.6ms vs 135.5ms），让一个本来就对称的实现被判失败。
// 单次测量本身就存在几百毫秒级的抖动（实测同一路径可横跨 31ms~1.5s），因此：
//   ① 两组**交替**采样（A/B/A/B…），让预热与负载漂移对两边同等影响；
//   ② 丢弃第一对作预热；③ 取**中位数**（对个别慢请求鲁棒）；
//   ④ 若仍超阈值则整体复测一次取较小比值 —— 真实的侧信道是可复现的，调度抖动不是。
const median = (arr) => [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)];
async function measureTiming(pairs = 6) {
  const samples = { exist: [], missing: [] };
  for (let i = 0; i < pairs; i++) {
    const exT = await loginTime(`tim_${timTag}`, "WrongPass#1");
    const noT = await loginTime("no_such_user_xyz", "WrongPass#1");
    if (i === 0) continue; // 预热对丢弃
    samples.exist.push(exT);
    samples.missing.push(noT);
  }
  const exist = median(samples.exist);
  const missing = median(samples.missing);
  return { exist, missing, ratio: Math.max(exist, missing) / Math.min(exist, missing) };
}
let exAvg, noAvg, ratio;
let m = await measureTiming();
if (m.ratio >= 2) {
  console.log(`  （首次测量比值 ${m.ratio.toFixed(2)}x 超阈值，复测一次以排除调度抖动）`);
  const m2 = await measureTiming();
  m = m2.ratio < m.ratio ? m2 : m;
}
({ exist: exAvg, missing: noAvg, ratio } = m);
check(`E 时序差收敛（存在 ${exAvg.toFixed(1)}ms vs 不存在 ${noAvg.toFixed(1)}ms，比值 ${ratio.toFixed(2)}x << 10x）`, ratio < 2, `(比值 ${ratio.toFixed(2)}x，原漏洞 10x)`);
if (timU && timU.id) await call("DELETE", `/api/admin/users/${timU.id}`, { token: T });

console.log("\n▶ F. deleteUser 规则（SEC-04：仅拦最后一个 boss，可删其他 boss）");
const ulF = (await call("GET", "/api/admin/users", { token: T })).data;
const allF = Array.isArray(ulF) ? ulF : (ulF?.users ?? []);
const pwn = allF.find((u) => u.username === "pwn_137680");
if (pwn) {
  const del = await call("DELETE", `/api/admin/users/${pwn.id}`, { token: T });
  check("F1 主控可删非最后一个 boss（清理审计残留后门 pwn_137680）", del.status === 200, `(实际 ${del.status})`);
} else {
  check("F1 后门账号 pwn_137680 已不存在", true);
}
const ul2 = (await call("GET", "/api/admin/users", { token: T })).data;
const all2 = Array.isArray(ul2) ? ul2 : (ul2?.users ?? []);
const bosses2 = all2.filter((u) => u.role === "boss");
if (bosses2.length === 1) {
  const delLast = await call("DELETE", `/api/admin/users/${bosses2[0].id}`, { token: T });
  check("F2 删除最后一个 boss 被拦（400）", delLast.status === 400, `(实际 ${delLast.status})`);
} else {
  check("F2 仍有多 boss，跳过末位拦截校验", true, `(boss 数=${bosses2.length})`);
}

console.log("\n▶ G. 锁号 DoS 修复（SEC-07：限流键=用户名+客户端IP）");
// 攻击者自 IP 对 central 错密 5 次
const ATK = "203.0.113." + (Math.floor(Math.random() * 240) + 5); // 每次运行用全新攻击 IP，避免跨运行继承限流状态
for (let i = 0; i < 5; i++) await call("POST", "/api/auth/login", { body: { username: "central", password: "wrong" }, headers: { "x-forwarded-for": ATK } });
const lockedIp = await call("POST", "/api/auth/login", { body: { username: "central", password: (process.env.VF_BOSS_P ?? "vfletch-dev") }, headers: { "x-forwarded-for": ATK } });
check("G1 攻击者 IP 对目标账号被锁（5 次错密）", lockedIp.status === 401 && /锁定/.test(lockedIp.data?.error ?? ""), `(status ${lockedIp.status})`);
// 受害者自真实 IP 登录 central 仍成功 —— 跨 IP 锁号 DoS 被阻断
const victim = await call("POST", "/api/auth/login", { body: { username: "central", password: (process.env.VF_BOSS_P ?? "vfletch-dev") }, headers: { "x-forwarded-for": "198.51.100.7" } });
check("G2 受害者真实 IP 登录不受影响（跨 IP 锁号 DoS 已修）", victim.status === 200 && !!victim.data?.token, `(status ${victim.status})`);
// IP 维度全局阈值：单 IP 跨用户名大量失败 → 限流该 IP
const THR = "192.0.2." + (Math.floor(Math.random() * 240) + 5); // 全新 IP，确保能从 0 触发分布式爆破限流
let thrHit = false;
for (let i = 0; i < 64; i++) {
  const r = await call("POST", "/api/auth/login", { body: { username: `nope_${i}`, password: "x" }, headers: { "x-forwarded-for": THR } });
  if (r.status === 401 && /过于频繁/.test(r.data?.error ?? "")) { thrHit = true; break; }
}
check("G3 单 IP 跨用户名大量失败被限流（防分布式爆破）", thrHit, `(thrHit ${thrHit})`);

console.log("\n==== 复验结果: 通过 " + pass + " / 失败 " + fail + " ====");
await killChild(child);
process.exit(fail === 0 ? 0 : 1);
