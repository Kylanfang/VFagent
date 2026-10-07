import { api, login, chat, check, group, summary, uid } from "./testlib.mjs";

const { token } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));

group("AI 秘书沙盒：工具可见性");
const normal = await chat({ token, provider: "vf", session: "s_" + uid(), messages: [{ role: "user", content: "hi" }], timeout: 15000 });
const sec = await chat({ token, provider: "vf", session: "s_" + uid(), employee: "emp_secretary", messages: [{ role: "user", content: "hi" }], timeout: 15000 });
console.log("   普通会话 toolCount =", normal.start?.toolCount, " 秘书会话 toolCount =", sec.start?.toolCount);
check("秘书会话工具数 > 普通会话（多出 secretary__ 只读工具）", (sec.start?.toolCount ?? 0) > (normal.start?.toolCount ?? 0));
check("普通会话工具数 = 全量 - 5 个秘书工具", (sec.start?.toolCount ?? 0) - (normal.start?.toolCount ?? 0) === 5, `${sec.start?.toolCount} vs ${normal.start?.toolCount}`);

group("AI 秘书沙盒：只读工具直接调用（主控 /api/mcp/call）");
let r = await api("POST", "/api/mcp/call", { token, body: { name: "secretary__db_schema", arguments: {} } });
check("db_schema 返回表结构", r.status === 200 && !r.data.isError && /users/.test(r.data.text), JSON.stringify(r.data).slice(0, 200));
r = await api("POST", "/api/mcp/call", { token, body: { name: "secretary__db_query", arguments: { sql: "SELECT username, role FROM users" } } });
check("db_query SELECT 正常", r.status === 200 && !r.data.isError && /central/.test(r.data.text), JSON.stringify(r.data).slice(0, 200));
r = await api("POST", "/api/mcp/call", { token, body: { name: "secretary__db_query", arguments: { sql: "DELETE FROM users" } } });
check("db_query DELETE 被拒绝", r.status === 200 && r.data.isError && /拒绝|只允许/.test(r.data.text), JSON.stringify(r.data).slice(0, 200));
r = await api("POST", "/api/mcp/call", { token, body: { name: "secretary__db_query", arguments: { sql: "SELECT 1; DROP TABLE users" } } });
check("db_query 多语句被拒绝", r.status === 200 && r.data.isError, JSON.stringify(r.data).slice(0, 200));
r = await api("POST", "/api/mcp/call", { token, body: { name: "secretary__db_query", arguments: { sql: "WITH x AS (SELECT 1 AS a) SELECT * FROM x" } } });
check("db_query WITH 只读 CTE 正常", r.status === 200 && !r.data.isError, JSON.stringify(r.data).slice(0, 200));
r = await api("POST", "/api/mcp/call", { token, body: { name: "secretary__system_status", arguments: {} } });
check("system_status 正常", r.status === 200 && !r.data.isError && /uptimeSec/.test(r.data.text), JSON.stringify(r.data).slice(0, 200));
r = await api("POST", "/api/mcp/call", { token, body: { name: "secretary__read_file", arguments: { path: "C:/Windows/win.ini" } } });
check("read_file 越界被拒绝", r.status === 200 && r.data.isError && /越界/.test(r.data.text), JSON.stringify(r.data).slice(0, 200));
r = await api("POST", "/api/mcp/call", { token, body: { name: "secretary__read_file", arguments: { path: process.cwd() + "/package.json" } } });
check("read_file 应用根内文件正常", r.status === 200 && !r.data.isError && /v-fletch/.test(r.data.text), JSON.stringify(r.data).slice(0, 200));
r = await api("POST", "/api/mcp/call", { token, body: { name: "secretary__list_dir", arguments: { path: process.cwd() + "/server" } } });
check("list_dir 正常", r.status === 200 && !r.data.isError && /main\.mjs/.test(r.data.text), JSON.stringify(r.data).slice(0, 200));

group("AI 秘书：真实模型对话调用只读工具");
const t0 = Date.now();
const s = await chat({ token, provider: "VF", session: "s_" + uid(), employee: "emp_secretary", messages: [{ role: "user", content: "用工具查一下系统里现在有多少个用户账号、各是什么角色，直接给结果。" }], timeout: 120000 });
console.log(`   ${Date.now() - t0}ms tools=${s.tools.map((t) => t.name + (t.isError ? "(ERR)" : "")).join(",")} text=${JSON.stringify(s.text.slice(0, 200))} errors=${JSON.stringify(s.errors)}`);
check("秘书会话调用了 secretary__ 工具", s.tools.some((t) => String(t.name).startsWith("secretary__")), s.tools.map((t) => t.name).join(","));
check("秘书回复提到 central/主控", /central|中央|主控|boss/i.test(s.text), s.text.slice(0, 200));

group("普通会话不可达秘书工具（模型编造调用也被拒）");
const n = await chat({ token, provider: "VF", session: "s_" + uid(), messages: [{ role: "user", content: "请调用名为 secretary__db_query 的工具执行 SELECT COUNT(*) FROM users，把工具返回原样告诉我；如果该工具不存在就回答“无此工具”。" }], timeout: 90000 });
console.log(`   tools=${s.tools.length ? "" : ""}${n.tools.map((t) => t.name + (t.isError ? "(ERR)" : "")).join(",")} text=${JSON.stringify(n.text.slice(0, 160))}`);
check("普通会话未成功执行 secretary__ 工具", !n.tools.some((t) => String(t.name).startsWith("secretary__") && !t.isError));

summary();
