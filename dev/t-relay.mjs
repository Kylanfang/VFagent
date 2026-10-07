import { check, group, summary, sleep, killChild } from "./testlib.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://127.0.0.1:8792";
// 自起带密钥实例（跑完自动关闭）
const child = spawn(process.execPath, ["server/main.mjs"], {
  cwd: ROOT,
  env: { ...process.env, VFLETCH_CONFIG_DIR: path.join(ROOT, ".autotest"), VFLETCH_PORT: "8792", VFLETCH_HOST: "127.0.0.1", VFLETCH_RELAY_KEY: "testkey123", VFLETCH_REPORT_KEY: "rep123" },
  stdio: "ignore", detached: true,
});
let up = false;
for (let i = 0; i < 30; i += 1) {
  await sleep(1000);
  try { const h = await fetch(BASE + "/api/health"); if (h.ok) { up = true; break; } } catch {}
}
check("带密钥实例启动", up);
if (!up) { try { process.kill(child.pid); } catch {} process.exit(1); }
let r;
async function api2(method, path, opts = {}) {
  const init = { method, headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers ?? {}) }, signal: AbortSignal.timeout(opts.timeout ?? 20000) };
  if (opts.body != null) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(opts.body); }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
async function login(user, pwd) {
  const r = await api2("POST", "/api/auth/login", { body: { username: user, password: pwd } });
  return r.data?.token;
}
const T = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));

group("中继与上报通道（带密钥实例 :8792）");
r = await api2("GET", "/relay/image?prompt=x&w=64&h=64");
check("无密钥访问中继 → 404", r.status === 404, String(r.status));
r = await api2("POST", "/api/ingest", { body: { key: "wrong", events: [{ subject: "s", kind: "turn", summary: "x" }] } });
check("错误密钥上报 → 403", r.status === 403, JSON.stringify(r.data));
r = await api2("POST", "/api/ingest", { body: { key: "rep123", events: [
  { subject: "emp_test", kind: "turn", summary: "成员A问了报销制度", detail: "{}", at: "2026-09-11 08:00:00" },
  { subject: "emp_test", kind: "tool_call", summary: "调用了 kb_search", detail: "{}", at: "2026-09-11 08:00:05" },
  { subject: "x".repeat(200), kind: "k".repeat(40), summary: "s".repeat(900), detail: "d".repeat(2000), at: "t".repeat(40) },
] } });
check("无令牌+正确密钥批量上报 → 接受（分布式回传通道）", r.status === 200 && r.data.accepted === 3, JSON.stringify(r.data));
r = await api2("GET", "/api/ingest/events", { token: T });
check("主控可查上报（长字段已截断）", r.status === 200 && r.data.events.length >= 3 && r.data.events[0].summary.length <= 400, JSON.stringify(r.data).slice(0, 200));
r = await api2("POST", "/api/ingest", { body: { key: "rep123", events: "not-an-array" } });
check("events 非数组 → 403", r.status === 403, JSON.stringify(r.data));
r = await api2("POST", "/api/ingest", { body: { events: [{ subject: "s", kind: "k", summary: "s" }] } });
check("缺密钥 → 403", r.status === 403, JSON.stringify(r.data));
// 不用 process.exit()：等子进程退出、事件循环自然排空再退出。
// Windows 上在仍有句柄收尾时强制退出会触发 libuv 断言（0xC0000409），断言全过却被判为崩溃。
const ok = summary();
await killChild(child);
process.exitCode = ok ? 0 : 1;
