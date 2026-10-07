// Focused test: prove the SEC-07 account lockout survives a full server restart
// (the original "重启即清零 = 可绕过" gap from §八.3 item 4).
// We simulate attacker/victim IPs via the x-forwarded-for header.
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = path.join(ROOT, ".autotest-persist");
const PORT = 8797;
const BASE = `http://127.0.0.1:${PORT}`;
const EXEC = process.execPath;
const ATK_IP = "203.0.113.99";
const VIC_IP = "198.51.100.7";
const USER = "central";
const PW = (process.env.VF_BOSS_P ?? "vfletch-dev");

rmSync(DIR, { recursive: true, force: true });

const env = {
  ...process.env,
  VFLETCH_CONFIG_DIR: DIR,
  VFLETCH_PORT: String(PORT),
  VFLETCH_HOST: "127.0.0.1",
  VFLETCH_WORKSPACE: path.join(DIR, "workspace"),
};

function start() {
  const child = spawn(EXEC, ["server/main.mjs"], { cwd: ROOT, env, stdio: "ignore" });
  return child;
}

// 停止自起服务并等它真正退出：
// ① 不等待就退出进程，Windows 上会让 libuv 的 async 句柄在关闭过程中被二次关闭而断言崩溃；
// ② 不等它释放 SQLite 文件句柄，后面的 rmSync 会 EPERM（测试通过却以非零码收尾）。
function stop(child) {
  return new Promise((resolve) => {
    if (child == null || child.exitCode != null || child.signalCode != null) return resolve();
    const timer = setTimeout(resolve, 8000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
  });
}

async function rmWithRetry(dir, tries = 12) {
  for (let i = 0; i < tries; i += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
}

async function waitHealth(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy in time");
}

async function login(username, password, ip) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ username, password }),
  });
  return { status: r.status, body: await r.text() };
}

let pass = true;
function check(label, cond) {
  console.log((cond ? "  ✅ " : "  ❌ ") + label);
  if (!cond) pass = false;
}

const child1 = start();
try {
  await waitHealth();
  console.log("▶ Round 1: trigger lock from attacker IP, then restart");
  for (let i = 1; i <= 5; i++) {
    const res = await login(USER, "wrong" + i, ATK_IP);
    if (i < 5) check(`bad login #${i} rejected (401)`, res.status === 401);
  }
  const after5 = await login(USER, PW, ATK_IP);
  check("attacker IP locked after 5 fails (401)", after5.status === 401);
  const victimDuring = await login(USER, PW, VIC_IP);
  check("victim IP NOT locked (200)", victimDuring.status === 200);
} finally {
  await stop(child1);
}

// give the OS a moment to release the port
await new Promise((r) => setTimeout(r, 800));

const child2 = start();
try {
  await waitHealth();
  console.log("▶ Round 2: after restart, lock must still be in effect (hydrated from DB)");
  const stillLocked = await login(USER, PW, ATK_IP);
  check("attacker IP STILL locked post-restart (401)", stillLocked.status === 401);
  const victimPost = await login(USER, PW, VIC_IP);
  check("victim IP still OK post-restart (200)", victimPost.status === 200);
} finally {
  await stop(child2);
}

await rmWithRetry(DIR);
const total = 6;
console.log(pass ? "\nPERSIST-CHECK: PASS ✅" : "\nPERSIST-CHECK: FAIL ❌");
// 与 testlib.summary() 同格式，便于 dev/run-all.sh 的日志 grep 与 CI 解析
console.log(`\n==== 结果: 通过 ${pass ? total : 0} / 失败 ${pass ? 0 : 1} ====`);
process.exitCode = pass ? 0 : 1;
