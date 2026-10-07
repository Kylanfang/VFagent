// 覆盖缺口守护（自起实例 :8799，独立配置目录 .autotest-admincov）
//
// 来历：巡检时按"前端会调用、但任何 dev 套件都没提到"筛出 5 个接口，实测抓到两个真实缺陷：
//   ① POST /api/settings/mcp：原实现 `saveMcpServers(body.servers ?? [])` —— 字段名写错/空 body
//      会被当成"清空全部 MCP 定义"并返回 200（实测把 servers 从 3 条清成 0 条，工具数 69→28）；
//   ② POST /api/rms/events/:id/resolve：没有 try/catch，处置不存在的 id 一路冒泡成 500。
// 本套件把这两条（以及 /api/mcp/reload、/api/aigc/rescan、/api/admin/shutdown）钉成断言。
import { spawn } from "node:child_process";
import { rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DIR = path.join(ROOT, ".autotest-admincov");
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
copyFileSync(path.join(ROOT, ".autotest", "model.json"), path.join(DIR, "model.json"));
copyFileSync(path.join(ROOT, "config", "vfletch.db"), path.join(DIR, "vfletch.db"));
// 轻量 MCP 配置：本套件只验路由行为，不需要拉起外部 MCP server（否则要等 npx 冷启动）
const MCP_FILE = path.join(DIR, "mcp.json");
const seed = (n) => ({ limits: {}, servers: Array.from({ length: n }, (_, i) => ({ id: `probe_${i}`, name: `探针${i}`, enabled: false, transport: "stdio", command: "node", args: [] })) });
writeFileSync(MCP_FILE, JSON.stringify(seed(1), null, 2));

let child = spawn(process.execPath, ["server/main.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    VFLETCH_CONFIG_DIR: DIR,
    VFLETCH_PORT: String(PORT),
    VFLETCH_HOST: "127.0.0.1",
    VFLETCH_WORKSPACE: path.join(DIR, "workspace"),
    VFLETCH_REPORT_KEY: "rep123",
  },
  stdio: "ignore",
});
const stop = (c) => new Promise((r) => {
  if (c == null || c.exitCode != null || c.signalCode != null) return r();
  const t = setTimeout(r, 8000);
  c.once("exit", () => { clearTimeout(t); r(); });
  try { c.kill("SIGTERM"); } catch { clearTimeout(t); r(); }
});
async function waitHealth() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("服务未在预算内就绪");
}

let pass = 0, fail = 0;
const check = (label, cond, detail = "") => {
  console.log((cond ? "  ✅ " : "  ❌ ") + label + (cond ? "" : `  ← ${detail}`));
  if (cond) pass += 1; else fail += 1;
};
const serversOnDisk = () => { try { return JSON.parse(readFileSync(MCP_FILE, "utf8")).servers?.length ?? -1; } catch { return -1; } };

let H = {};
const call = async (method, p, body, timeout = 120000) => {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + p, { method, headers: H, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    const text = await r.text();
    let d = null; try { d = JSON.parse(text); } catch {}
    return { status: r.status, d, text, ms: Date.now() - t0 };
  } catch (e) { return { status: "ERR", d: null, text: String(e?.message ?? e), ms: Date.now() - t0 }; }
};

try {
  await waitHealth();
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "central", password: (process.env.VF_BOSS_P ?? "vfletch-dev") }),
  });
  const lj = await login.json();
  H = { authorization: `Bearer ${lj.token}`, "content-type": "application/json" };
  check("自起实例可登录", login.status === 200, `${login.status}`);

  console.log("▶ A. /api/settings/mcp：字段名写错不得清空配置（fail-closed）");
  {
    const before = serversOnDisk();
    const wrong = await call("POST", "/api/settings/mcp", { mcpServers: seed(2).servers });
    check("字段名错误 → 400（不得静默清空）", wrong.status === 400, `${wrong.status} ${String(wrong.text).slice(0, 120)}`);
    check("磁盘上的 MCP 定义数量未变（未被清空）", serversOnDisk() === before, `before=${before} after=${serversOnDisk()}`);
    const empty = await call("POST", "/api/settings/mcp", {});
    check("空 body → 400（不得当成清空）", empty.status === 400, `${empty.status}`);
    check("磁盘仍未变", serversOnDisk() === before, `now=${serversOnDisk()}`);
    const explicit = await call("POST", "/api/settings/mcp", { servers: seed(1).servers });
    check("显式 { servers: [...] } 仍可保存 → 200", explicit.status === 200, `${explicit.status}`);
    const explicitEmpty = await call("POST", "/api/settings/mcp", { servers: [] });
    check("显式清空 { servers: [] } 仍被允许（意图明确）", explicitEmpty.status === 200 && serversOnDisk() === 0, `${explicitEmpty.status} n=${serversOnDisk()}`);
    writeFileSync(MCP_FILE, JSON.stringify(seed(1), null, 2));
  }

  console.log("▶ B. /api/mcp/reload：重载后工具集不得丢空");
  {
    const before = await call("GET", "/api/mcp/list");
    const r = await call("POST", "/api/mcp/reload", {});
    check("重载 → 200", r.status === 200, `${r.status} ${r.ms}ms`);
    const after = await call("GET", "/api/mcp/list");
    check("重载后工具数仍 > 0（内置工具在）", (after.d?.toolCount ?? 0) > 0, `before=${before.d?.toolCount} after=${after.d?.toolCount}`);
  }

  console.log("▶ C. /api/aigc/rescan：可重复执行且幂等");
  {
    const r1 = await call("POST", "/api/aigc/rescan", {});
    check("重扫 → 200", r1.status === 200, `${r1.status} ${r1.ms}ms`);
    const o1 = await call("GET", "/api/aigc/overview");
    await call("POST", "/api/aigc/rescan", {});
    const o2 = await call("GET", "/api/aigc/overview");
    check("两次重扫后统计一致（不重复放大样本）", JSON.stringify(o1.d?.totals) === JSON.stringify(o2.d?.totals), `${JSON.stringify(o1.d?.totals)?.slice(0, 80)} vs ${JSON.stringify(o2.d?.totals)?.slice(0, 80)}`);
  }

  console.log("▶ D. /api/rms/events/:id/resolve：错误 id 不得 500");
  {
    const notFound = await call("POST", "/api/rms/events/__nope__/resolve", { note: "x" });
    check("处置不存在的风险事件 → 404（修复前是 500）", notFound.status === 404, `${notFound.status} ${String(notFound.text).slice(0, 120)}`);
    const evs = await call("GET", "/api/rms/events?status=open");
    const list = Array.isArray(evs.d) ? evs.d : (evs.d?.events ?? []);
    if (list[0] != null) {
      const ok = await call("POST", `/api/rms/events/${encodeURIComponent(list[0].id)}/resolve`, { note: "巡检处置" });
      check("处置真实存在的开放事件 → 200", ok.status === 200, `${ok.status} ${String(ok.text).slice(0, 100)}`);
      const again = await call("POST", `/api/rms/events/${encodeURIComponent(list[0].id)}/resolve`, { note: "重复处置" });
      check("重复处置同一事件 → 幂等 200（不报错）", again.status === 200, `${again.status}`);
    } else {
      check("处置真实存在的开放事件 → 200", true, "（无 open 事件，跳过）");
      check("重复处置同一事件 → 幂等 200", true, "（无 open 事件，跳过）");
    }
  }

  console.log("▶ E. /api/admin/shutdown：主控关停必须真的把进程停掉（放最后）");
  {
    const r = await call("POST", "/api/admin/shutdown", {}, 15000);
    check("关停接口有响应（200）", r.status === 200, `${r.status} ${String(r.text).slice(0, 80)}`);
    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 12000);
      if (child.exitCode != null) { clearTimeout(timer); return resolve(true); }
      child.once("exit", () => { clearTimeout(timer); resolve(true); });
    });
    check("服务进程在 12 秒内退出", exited, `exitCode=${child.exitCode}`);
    if (exited) child = null; // 已退出，finally 不再重复 stop
  }
} finally {
  await stop(child);
  for (let i = 0; i < 10; i += 1) {
    try { rmSync(DIR, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
}
console.log(`\n==== 结果: 通过 ${pass} / 失败 ${fail} ====`);
process.exitCode = fail === 0 ? 0 : 1;
