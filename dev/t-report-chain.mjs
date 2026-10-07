// 端到端：客户端(8793, 带上报配置) → 主控(8790, 带校验密钥) 的留痕回传链路
import { check, group, summary, sleep, killChild } from "./testlib.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTOTEST = path.join(ROOT, ".autotest");
const { DatabaseSync } = await import("node:sqlite");
group("上报链路 E2E：客户端引擎 → 主控 ingest_events");
// 客户端实例：本地引擎 + 上报配置指向 8790 主控
const child = spawn(process.execPath, ["server/main.mjs"], {
  cwd: ROOT,
  env: { ...process.env, VFLETCH_CONFIG_DIR: AUTOTEST, VFLETCH_PORT: "8793", VFLETCH_HOST: "127.0.0.1", VFLETCH_REPORT_URL: "http://127.0.0.1:8790/api/ingest", VFLETCH_REPORT_KEY: "rep123" },
  stdio: "ignore", detached: true,
});
let clientUp = false;
for (let i = 0; i < 25; i += 1) {
  await sleep(1000);
  try { const h = await fetch("http://127.0.0.1:8793/api/health"); if (h.ok) { clientUp = true; break; } } catch {}
}
check("客户端实例启动", clientUp);
// 在客户端上跑一轮对话（会产生 reportEvent 入队）
const lr = await fetch("http://127.0.0.1:8793/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "central", password: (process.env.VF_BOSS_P ?? "vfletch-dev") }) });
const token = (await lr.json())?.token;
const cr = await fetch("http://127.0.0.1:8793/api/chat", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ provider: "vf", session: "s_report_e2e", messages: [{ role: "user", content: "只回复：上报链路" }] }), signal: AbortSignal.timeout(30000) });
await cr.text();
check("客户端对话完成", cr.ok);
// reportEvent 有 3s flush 延迟 + 队列节流；等主控落库
let found = false;
for (let i = 0; i < 8; i += 1) {
  await sleep(2000);
  const db = new DatabaseSync(path.join(AUTOTEST, "vfletch.db"), { readOnly: true });
  const row = db.prepare("SELECT subject, kind, summary FROM ingest_events WHERE summary LIKE '%上报链路%' ORDER BY id DESC LIMIT 1").get();
  db.close();
  if (row) { found = true; console.log("   主控收到:", JSON.stringify(row)); break; }
}
check("留痕成功到达主控 ingest_events", found);
await killChild(child);
process.exit(summary() ? 0 : 1);
