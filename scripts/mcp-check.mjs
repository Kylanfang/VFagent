// MCP 工具体检：逐 server 调用代表性工具，输出 PASS/FAIL 与原因
const BASE = process.env.VF_BASE ?? "http://127.0.0.1:8787";
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "central", password: (process.env.VF_BOSS_P || "***") }),
}).then((r) => r.json());
const TOKEN = login.token;
if (!TOKEN) {
  console.error("登录失败:", JSON.stringify(login).slice(0, 200));
  process.exit(1);
}

const tests = [
  ["filesystem__list_directory", { path: "<WORKSPACE>" }],
  ["sequential-thinking__sequentialthinking", { thought: "体检测试", nextThoughtNeeded: false, thoughtNumber: 1, totalThoughts: 1 }],
  ["finance__current_timestamp", {}],
  ["finance__stock_data", { symbol: "600000.SH" }],
  ["github__search_repositories", { q: "electron" }],
  ["audit__audit_overview", {}],
  ["web__web_search", { query: "平安银行 2025 年报" }],
  ["media__image_generate", { prompt: "测试" }],
  ["code__code_run", { language: "node", code: 'console.log("code_run ok", 6*7)' }],
  ["agent__todo_write", { tasks: [{ id: "1", text: "体检", status: "completed" }] }],
  ["memory__memory_save", { key: "test/mcp-check", value: "体检临时记录" }],
  ["mcp_admin__mcp_list", {}],
];

for (const [name, args] of tests) {
  try {
    const r = await fetch(`${BASE}/api/mcp/call`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ name, arguments: args }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json().catch(() => ({ error: "bad-json" }));
    const text = (j.text ?? j.error ?? JSON.stringify(j)).replace(/\n/g, " ").slice(0, 120);
    console.log((r.ok && !j.isError ? "PASS" : "FAIL").padEnd(5), name.padEnd(46), text);
  } catch (e) {
    console.log("ERR ", name.padEnd(46), String(e?.message ?? e).slice(0, 100));
  }
}
