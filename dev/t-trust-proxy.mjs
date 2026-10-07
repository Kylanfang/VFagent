// 安全控制点复验：VFLETCH_TRUST_PROXY 的两种语义
//   A) 默认：对端是 loopback（本机反代场景）→ 采信 XFF，限流键按 XFF 区分
//   B) VFLETCH_TRUST_PROXY=0 → **彻底忽略** XFF，轮换 XFF 无法绕过"用户名+IP"锁定
// 自起两个实例（端口 8798，独立配置目录），互不干扰。
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, cpSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = path.join(ROOT, ".autotest-trustproxy");
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
// 用真配置的 model.json 与种子库（含 central 账号），但完全隔离在同一临时目录
cpSync(path.join(ROOT, ".autotest", "model.json"), path.join(DIR, "model.json"));
cpSync(path.join(ROOT, "config", "vfletch.db"), path.join(DIR, "vfletch.db"));

function start(extraEnv) {
  return spawn(process.execPath, ["server/main.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      VFLETCH_CONFIG_DIR: DIR,
      VFLETCH_PORT: String(PORT),
      VFLETCH_HOST: "127.0.0.1",
      VFLETCH_WORKSPACE: path.join(DIR, "workspace"),
      VFLETCH_IP_MAX_FAILS: "100000", // 避免 IP 维度限流先于账号维度锁定而干扰判定
      ...extraEnv,
    },
    stdio: "ignore",
  });
}

// 等子进程真正退出：否则 Windows 上 rmSync 会因文件句柄未释放而 EPERM
function stop(child) {
  return new Promise((resolve) => {
    if (child == null || child.exitCode != null || child.signalCode != null) return resolve();
    const timer = setTimeout(resolve, 8000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    try { child.kill("SIGTERM"); } catch { clearTimeout(timer); resolve(); }
  });
}

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy in time");
}

async function loginXff(xff) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": xff },
    body: JSON.stringify({ username: "central", password: "wrong-pass" }),
  });
  return r.status;
}

let pass = true;
let total = 0;
function check(label, cond, detail = "") {
  total += 1;
  console.log((cond ? "  ✅ " : "  ❌ ") + label + (cond ? "" : `  ${detail}`));
  if (!cond) pass = false;
}

// A) 默认语义
let child = start({});
try {
  await waitHealth();
  for (let i = 0; i < 5; i += 1) await loginXff("203.0.113.7");
  check("默认：XFF 被采信（同 XFF 5 次失败后锁定 401）", (await loginXff("203.0.113.7")) === 401);
  check("默认：另一个 XFF 未受影响（401=错密，不是锁定）", (await loginXff("198.51.100.9")) === 401);
} finally {
  await stop(child);
}

await new Promise((r) => setTimeout(r, 700));

// B) 硬关闭 XFF 采信
child = start({ VFLETCH_TRUST_PROXY: "0" });
try {
  await waitHealth();
  let last = 0;
  for (let i = 0; i < 8; i += 1) last = await loginXff(`198.51.100.${i + 1}`);
  check("TRUST_PROXY=0：轮换 8 个不同 XFF 仍被锁定（无法绕过）", last === 401, `最后状态 ${last}`);
} finally {
  await stop(child);
}

for (let i = 0; i < 10; i += 1) {
  try { rmSync(DIR, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 400)); }
}
console.log(`\n==== 结果: 通过 ${pass ? total : total - 1} / 失败 ${pass ? 0 : 1} ====`);
process.exitCode = pass ? 0 : 1;
