// V-Fletch 全量 API 回归测试（针对隔离测试服务器 127.0.0.1:8790）
// 运行：node dev/apitest.mjs [--slow]   （--slow 额外跑真实模型/生图等耗时用例）
import { api, login, chat, check, group, summary, uid, sleep, BASE } from "./testlib.mjs";

const SLOW = process.argv.includes("--slow");
const tag = uid();
const boss = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const T = boss.token;

// ---------------------------------------------------------------- 公开接口 & 安全头
group("公开接口与安全头");
let r = await api("GET", "/api/health");
check("health ok", r.status === 200 && r.data.ok === true);
check("API 响应带 nosniff + no-store + CSP", r.headers.get("x-content-type-options") === "nosniff" && /no-store/.test(r.headers.get("cache-control") ?? "") && /default-src 'none'/.test(r.headers.get("content-security-policy") ?? ""));
r = await api("GET", "/api/meta");
check("meta", r.status === 200 && r.data.app === "v-fletch");
r = await api("GET", "/api/models");
check("/api/models 未登录 → 401", r.status === 401);
r = await api("GET", "/api/models", { token: T });
check("/api/models 登录后为数组且含 vf", r.status === 200 && Array.isArray(r.data.providers) && r.data.providers.some((p) => p.id === "vf"));
check("/api/models 不回传 apiKey 明文", !JSON.stringify(r.data).includes("sk-"));
const html = await api("GET", "/", { raw: true });
const csp = html.headers.get("content-security-policy") ?? "";
check("index.html 带 CSP（script-src 'self' 无 unsafe-inline）", /script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), csp.slice(0, 120));
check("index.html frame-ancestors none", /frame-ancestors 'none'/.test(csp));
const con = await api("GET", "/console.html", { raw: true });
const conCsp = con.headers.get("content-security-policy") ?? "";
check("console.html CSP 含内联脚本 sha256 哈希", /sha256-/.test(conCsp));
{
  // 哈希必须与浏览器口径一致（HTML 解析后 CR/CRLF → LF），否则内联脚本被 CSP 拦截、控制台整页失效
  const { createHash } = await import("node:crypto");
  const html = await con.text();
  const m = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  const norm = String(m?.[1] ?? "").split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)).split(String.fromCharCode(13)).join(String.fromCharCode(10));
  const expect = createHash("sha256").update(norm, "utf8").digest("base64");
  check("console.html CSP 哈希与浏览器归一化口径一致", conCsp.includes(`'sha256-${expect}'`), conCsp.slice(0, 120));
}
r = await api("GET", "/api/nope/xyz", { token: T });
check("未知接口 404", r.status === 404);
r = await api("GET", "/generated/../config/model.json", { token: T });
check("generated 路径穿越 → 404 或 SPA", r.status === 404 || (typeof r.data === "string" && r.data.includes("<!doctype")));
r = await api("GET", "/generated/not_exist.png");
check("generated 不存在 → 404", r.status === 404);
// 畸形 JSON
const bad = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{oops" });
check("畸形 JSON 不导致 5xx 崩溃（4xx/5xx 均可但服务器仍活）", bad.status >= 400 && (await api("GET", "/api/health")).status === 200, String(bad.status));

// ---------------------------------------------------------------- 认证
group("认证");
r = await api("POST", "/api/auth/login", { body: { username: "central", password: "wrong" } });
check("错误密码 401", r.status === 401 && /错误/.test(r.data.error ?? ""));
r = await api("POST", "/api/auth/login", { body: { username: "central' OR 1=1--", password: "x" } });
check("SQL 注入登录失败", r.status === 401);
r = await api("GET", "/api/auth/me", { token: T });
check("me 返回 boss", r.status === 200 && r.data.user?.role === "boss");
r = await api("GET", "/api/auth/me", { token: "deadbeef" });
check("伪造 token 401", r.status === 401);
const tmp = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
r = await api("POST", "/api/auth/logout", { token: tmp.token });
r = await api("GET", "/api/auth/me", { token: tmp.token });
check("登出后 token 失效", r.status === 401);

// ---------------------------------------------------------------- 账号管理 + RBAC
group("账号管理与权限边界");
r = await api("POST", "/api/admin/users", { token: T, body: { username: "Bad Name", password: "123456" } });
check("非法用户名 400", r.status === 400);
r = await api("POST", "/api/admin/users", { token: T, body: { username: `u_${tag}`, password: "123" } });
check("短密码 400", r.status === 400);
r = await api("POST", "/api/admin/users", { token: T, body: { username: `emp_${tag}`, password: "emp123456", display_name: "成员甲", role: "employee" } });
check("创建成员", r.status === 200 && r.data.role === "employee", JSON.stringify(r.data));
const empUser = r.data;
r = await api("POST", "/api/admin/users", { token: T, body: { username: `emp_${tag}`, password: "emp123456" } });
check("重复用户名 400", r.status === 400);
r = await api("POST", "/api/admin/users", { token: T, body: { username: `obs_${tag}`, password: "obs123456", display_name: "观察员", role: "employee" } });
const obsUser = r.data;
r = await api("POST", `/api/admin/users/${obsUser.id}/role`, { token: T, body: { role: "observer" } });
check("升级观察员", r.status === 200 && r.data.role === "observer");
const emp = await login(`emp_${tag}`, "emp123456");
const obs = await login(`obs_${tag}`, "obs123456");
for (const p of ["/api/admin/users", "/api/settings", "/api/mcp/list", "/api/usage", "/api/rms/overview"]) {
  r = await api("GET", p, { token: emp.token });
  check(`成员访问 ${p} → 403`, r.status === 403, String(r.status));
}
r = await api("GET", "/api/admin/users", { token: obs.token });
check("观察员可看账号列表", r.status === 200 && Array.isArray(r.data));
r = await api("GET", "/api/admin/users", { token: T });
check("账号列表含 lastSeen 字段（在线判定依据）", r.status === 200 && r.data.some((u) => u.username === "central" && "lastSeen" in u));
r = await api("DELETE", `/api/admin/users/${empUser.id}`, { token: obs.token });
check("观察员不能删除账号 403", r.status === 403);
r = await api("POST", `/api/admin/users/${boss.user.id}/status`, { token: T, body: { status: "disabled" } });
check("不能停用主控 400", r.status === 400);
r = await api("POST", `/api/admin/users/${empUser.id}/status`, { token: T, body: { status: "disabled" } });
check("停用成员", r.status === 200 && r.data.status === "disabled");
r = await api("GET", "/api/auth/me", { token: emp.token });
check("停用后成员 token 立即失效", r.status === 401);
r = await api("POST", "/api/auth/login", { body: { username: `emp_${tag}`, password: "emp123456" } });
check("停用后无法登录", r.status === 401 && /停用/.test(r.data.error ?? ""));
r = await api("POST", `/api/admin/users/${empUser.id}/status`, { token: T, body: { status: "active" } });
r = await api("POST", `/api/admin/users/${empUser.id}/password`, { token: T, body: { password: "newpass123" } });
check("重置密码", r.status === 200);
r = await api("POST", "/api/auth/login", { body: { username: `emp_${tag}`, password: "emp123456" } });
check("旧密码登录失败", r.status === 401);
const emp2 = await login(`emp_${tag}`, "newpass123");
check("新密码登录成功", !!emp2.token);

group("登录限流");
r = await api("POST", "/api/admin/users", { token: T, body: { username: `lock_${tag}`, password: "lock123456" } });
for (let i = 0; i < 5; i += 1) await api("POST", "/api/auth/login", { body: { username: `lock_${tag}`, password: "bad" } });
r = await api("POST", "/api/auth/login", { body: { username: `lock_${tag}`, password: "bad" } });
// 锁号/限流阈值验证已移至 t-sec-reverify（自带独立实例验证生产默认值；
// 8790 共享测试服务器的阈值经 env 放开，避免套件坏登录互相污染）
check("连续错误密码均 401", r.status === 401, JSON.stringify(r.data).slice(0, 100));
const lockUser = (await api("GET", "/api/admin/users", { token: T })).data.find((u) => u.username === `lock_${tag}`);

// ---------------------------------------------------------------- 设置 / provider
group("模型设置");
r = await api("GET", "/api/settings", { token: T });
check("settings 读取", r.status === 200 && r.data.providers && !JSON.stringify(r.data).includes("sk-"));
const activeBefore = r.data.active;
r = await api("POST", "/api/settings/provider", { token: T, body: { id: "", fields: { label: "我的测试模型", baseUrl: "http://127.0.0.1:1/v1/", model: "m1", apiKey: "k" }, reload: false } });
check("空 ID 自动生成合法 ID", r.status === 200 && /^[a-z][a-z0-9_-]*$/i.test(r.data.id ?? ""), JSON.stringify(r.data).slice(0, 120));
const autoId = r.data.id;
r = await api("GET", "/api/settings", { token: T });
check("baseUrl 尾部斜杠被去除", r.data.providers[autoId]?.baseUrl === "http://127.0.0.1:1/v1");
r = await api("POST", "/api/settings/provider", { token: T, body: { id: "中文ID", fields: { label: "x", baseUrl: "http://127.0.0.1:1", model: "m" }, reload: false } });
check("中文 ID 自动改写而非报错", r.status === 200 && r.data.renamedFrom === "中文ID", JSON.stringify(r.data).slice(0, 120));
const cnId = r.data.id;
r = await api("POST", "/api/settings/active", { token: T, body: { id: "nope" } });
check("激活不存在 provider 400", r.status === 400);
r = await api("POST", "/api/settings/provider-delete", { token: T, body: { id: "nope" } });
check("删除不存在 provider 400", r.status === 400);
r = await api("POST", "/api/settings/provider-delete", { token: T, body: { id: autoId } });
check("删除 provider", r.status === 200);
r = await api("POST", "/api/settings/provider-delete", { token: T, body: { id: cnId } });
r = await api("POST", "/api/settings/active", { token: T, body: { id: activeBefore } });
check("恢复 active", r.status === 200 && r.data.active === activeBefore);

// ---------------------------------------------------------------- MCP
group("MCP 中心");
r = await api("GET", "/api/mcp/list", { token: T });
check("mcp list 有内置 server", r.status === 200 && r.data.servers?.some((s) => s.id === "kb"));
check("secretary 内置 server 已注册", r.data.servers?.some((s) => s.id === "secretary" && s.status === "connected"));
r = await api("POST", "/api/mcp/probe", { token: T, body: { url: "not-a-url" } });
check("probe 非法 url → ok:false", r.status === 200 && r.data.ok === false);
r = await api("POST", "/api/mcp/probe", { token: T, body: { url: BASE + "/api/health" } });
check("probe 非 MCP 端点 → ok:false 且有原因", r.status === 200 && r.data.ok === false && r.data.error, JSON.stringify(r.data));
r = await api("POST", "/api/mcp/install", { token: obs.token, body: { id: "x" } });
check("观察员不能安装 MCP 403", r.status === 403);
r = await api("POST", "/api/mcp/install", { token: T, body: { id: "bad id!", transport: "stdio", command: "node" } });
check("非法 server id 400（先校验不落盘）", r.status === 400, JSON.stringify(r.data).slice(0, 120));
r = await api("POST", "/api/mcp/install", { token: T, body: { id: "kb", transport: "stdio", command: "node" } });
check("与内置 id 冲突 400", r.status === 400);
r = await api("POST", "/api/mcp/install", { token: T, body: { id: `ghost_${tag}`, transport: "stdio", command: "definitely_not_a_cmd_xyz" }, timeout: 60000 });
check("命令不存在 → 400 并回滚", r.status === 400 && /撤销/.test(r.data.error ?? ""), JSON.stringify(r.data).slice(0, 160));
r = await api("GET", "/api/settings", { token: T });
check("回滚后 mcp.json 无残留", !r.data.mcpServers.some((s) => s.id === `ghost_${tag}`));
r = await api("POST", "/api/mcp/install", { token: T, body: { id: `ghost_${tag}`, transport: "http", url: "notaurl" } });
check("http 传输非法 url 400", r.status === 400);
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "kb__kb_search", arguments: { query: "测试" } } });
check("调用内置工具 kb_search", r.status === 200 && typeof r.data.text === "string");
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "no__such_tool", arguments: {} } });
check("调用未知工具 → 4xx/5xx 带 error 且服务器存活", r.status >= 400 && (await api("GET", "/api/health")).status === 200, String(r.status));

// ---------------------------------------------------------------- 知识库
group("知识库");
r = await api("POST", "/api/kb", { token: emp2.token, body: { title: `成员投稿 ${tag}`, content: "报销制度：差旅需 3 日内提交", tags: ["制度"] } });
check("成员投稿进入 pending", r.status === 200 && r.data.status === "pending");
const pendingDoc = r.data.id;
r = await api("GET", "/api/kb", { token: emp2.token });
check("成员看到自己的待审稿", r.data.docs?.some((d) => d.id === pendingDoc && d.mine));
r = await api("PUT", `/api/kb/${pendingDoc}`, { token: emp2.token, body: { title: "x" } });
check("成员不能编辑待审稿 400", r.status === 400);
r = await api("PUT", `/api/kb/${pendingDoc}`, { token: T, body: { approve: true } });
check("主控审核通过", r.status === 200);
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "kb__kb_search", arguments: { query: "报销 差旅" } } });
check("kb_search 命中审核通过的文档", r.status === 200 && /报销/.test(r.data.text), r.data.text?.slice(0, 120));
r = await api("POST", "/api/kb", { token: T, body: { title: "" } });
check("空标题 400", r.status === 400);
r = await api("DELETE", `/api/kb/${pendingDoc}`, { token: emp2.token });
check("成员不能删已发布文档 400", r.status === 400);
r = await api("DELETE", `/api/kb/${pendingDoc}`, { token: T });
check("主控归档文档", r.status === 200);
r = await api("DELETE", "/api/kb/kb_not_exist", { token: T });
check("归档不存在 404", r.status === 404);

// ---------------------------------------------------------------- 上传
group("文件上传");
const up = await fetch(BASE + "/api/upload", { method: "POST", headers: { authorization: `Bearer ${emp2.token}`, "x-file-name": encodeURIComponent("测试 数据.csv") }, body: "a,b\n1,2\n" });
const upData = await up.json();
check("上传文本文件返回内容", up.status === 200 && upData.kind === "text" && upData.content?.includes("a,b"), JSON.stringify(upData));
const up2 = await fetch(BASE + "/api/upload", { method: "POST", headers: { authorization: `Bearer ${emp2.token}`, "x-file-name": "../../evil.txt" }, body: "x" });
const up2d = await up2.json();
check("上传文件名穿越被清洗（无路径分隔符、不越界）", up2.status === 200 && !/[\/]\.\.|^\.\./.test(up2d.name) && up2d.path.startsWith("uploads/"), JSON.stringify(up2d));
const up3 = await fetch(BASE + "/api/upload", { method: "POST", headers: { authorization: `Bearer ${emp2.token}`, "x-file-name": "empty.txt" }, body: "" });
check("空文件 400", up3.status === 400);

// ---------------------------------------------------------------- 团队 / AI 员工
group("AI 员工与部门");
r = await api("POST", "/api/team/employees", { token: emp2.token, body: { name: "" } });
check("空名称 400", r.status === 400);
r = await api("POST", "/api/team/employees", { token: emp2.token, body: { name: "小助", providerFields: { baseUrl: "ftp://x", model: "m", apiKey: "k" } } });
check("非法 baseUrl 400", r.status === 400);
r = await api("GET", "/api/settings", { token: T });
const publicProvider = Object.keys(r.data.providers).find((id) => r.data.providers[id].hasApiKey);
r = await api("POST", "/api/team/employees", { token: emp2.token, body: { name: "小助", identity: "你叫小助", providerId: publicProvider } });
check("成员绑定公共 API 建 AI 员工", r.status === 200 && r.data.owner_user_id === empUser.id, JSON.stringify(r.data).slice(0, 200));
const aiEmp = r.data;
r = await api("POST", `/api/team/employees/${aiEmp.id}/update`, { token: obs.token, body: { name: "小助改" } });
check("观察员可改任意 AI 员工", r.status === 200 && r.data.name === "小助改");
r = await api("POST", `/api/team/employees/${aiEmp.id}/transfer`, { token: emp2.token, body: { to: "central" } });
check("不能转交给中央 400", r.status === 400);
r = await api("GET", "/api/team/employees", { token: emp2.token });
check("成员员工列表含自己的", r.data.some((e) => e.id === aiEmp.id && e.mine));
r = await api("POST", "/api/team/teams", { token: emp2.token, body: { name: "临时组", memberIds: [aiEmp.id] } });
check("成员无授权码不能建部门 400", r.status === 400 && /授权码/.test(r.data.error ?? ""));
r = await api("POST", "/api/team/grants", { token: emp2.token });
check("成员不能签发授权码 403", r.status === 403);
r = await api("POST", "/api/team/grants", { token: T });
check("主控签发授权码", r.status === 200 && /^TD-/.test(r.data.code ?? ""));
const grant = r.data.code;
r = await api("POST", "/api/team/teams", { token: emp2.token, body: { name: "临时组", memberIds: [aiEmp.id], grantCode: grant } });
check("持授权码建部门", r.status === 200 && r.data.id, JSON.stringify(r.data).slice(0, 200));
const team = r.data;
r = await api("POST", "/api/team/teams", { token: emp2.token, body: { name: "再建", memberIds: [aiEmp.id], grantCode: grant } });
check("授权码一次性", r.status === 400 && /已被使用/.test(r.data.error ?? ""));
r = await api("GET", "/api/team/teams", { token: emp2.token });
check("部门列表", r.status === 200 && r.data.some((t) => t.id === team.id));
r = await api("POST", "/api/team/teams", { token: T, body: { name: "项目X", memberIds: [aiEmp.id], isProject: true, memberUserIds: [empUser.id] } });
check("主控建项目（含共享会话）", r.status === 200 && r.data.is_project === 1 && r.data.shared_conversation_id, JSON.stringify(r.data).slice(0, 200));
const project = r.data;
r = await api("POST", `/api/team/teams/${team.id}/disband`, { token: obs.token });
check("观察员解散部门", r.status === 200 && r.data.disbanded);
r = await api("POST", `/api/team/teams/${project.id}/disband`, { token: T });

// ---------------------------------------------------------------- RMS
group("监管风控中心");
for (const p of ["overview", "events", "activity", "employees", "todos", "conversations", "rules", "tasks"]) {
  r = await api("GET", `/api/rms/${p}`, { token: T });
  check(`rms/${p}`, r.status === 200, String(r.status));
}
r = await api("GET", "/api/rms", { token: T });
check("rms 缺资源 400", r.status === 400);
r = await api("GET", "/api/rms/conversations/not_exist", { token: T });
check("会话不存在 404", r.status === 404);
r = await api("POST", "/api/rms/rules", { token: T, body: { code: `R_${tag}`, name: "测试规则", kind: "text_pattern", level: "warning", action: "alert", params: { pattern: "删库" }, description: "x", enabled: true } });
check("创建规则", r.status === 200, JSON.stringify(r.data).slice(0, 200));
r = await api("POST", `/api/rms/rules/R_${tag}`, { token: T, body: { enabled: false } });
check("更新规则", r.status === 200);
r = await api("DELETE", `/api/rms/rules/R_${tag}`, { token: T });
check("删除规则", r.status === 200);
r = await api("POST", "/api/rms/tasks", { token: T, body: { title: `任务 ${tag}`, detail: "写一句话", assignees: [aiEmp.id] } });
check("创建任务", r.status === 200 && r.data.id, JSON.stringify(r.data).slice(0, 200));
const task = r.data;
r = await api("GET", `/api/rms/tasks/${task.id}`, { token: T });
check("任务详情", r.status === 200 && r.data.id === task.id);
r = await api("POST", "/api/rms/tasks", { token: T, body: { title: "x", assignees: ["team:nope"] } });
check("派活到不存在部门 400", r.status === 400);
r = await api("POST", "/api/rms/employees/emp_default/status", { token: T, body: { status: "weird" } });
check("非法员工状态 400", r.status === 400);

// ---------------------------------------------------------------- 审计 / AIGC / 用量 / 建议
group("审计 · AI 监测 · 用量 · 建议");
r = await api("GET", "/api/audit/overview", { token: emp2.token });
check("成员可读审计总览", r.status === 200 && Array.isArray(r.data._modules));
r = await api("PUT", "/api/audit/record", { token: emp2.token, body: { key: "x", action: "update", index: 0, patch: {} } });
check("成员改不存在实体 → 400（不崩）", r.status === 400, JSON.stringify(r.data));
r = await api("PUT", "/api/audit/record", { token: emp2.token, body: { key: "dashboardStats", action: "update", patch: { totalRisks: 999 } } });
check("成员改全局指标 → 进入主控审批（不直接生效）", r.status === 200 && r.data.pending === true, JSON.stringify(r.data));
{ const q = (await api("GET", "/api/audit/edits", { token: T })).data.requests.filter((x) => x.requestedBy === `emp_${tag}`); for (const x of q) await api("POST", "/api/audit/edits/reject", { token: T, body: { id: x.id } }); }
r = await api("GET", "/api/aigc/overview", { token: emp2.token });
check("成员看 AI 监测 403", r.status === 403);
r = await api("GET", "/api/aigc/overview", { token: obs.token });
check("观察员看 AI 监测", r.status === 200);
r = await api("GET", "/api/usage", { token: T });
check("用量", r.status === 200);
r = await api("GET", "/api/suggest?limit=3", { token: emp2.token });
check("建议卡片", r.status === 200 && Array.isArray(r.data) && r.data.length <= 3);
r = await api("POST", "/api/prompt-polish", { token: emp2.token, body: { text: "" } });
check("空提示词优化 400", r.status === 400);
r = await api("POST", "/api/image", { token: emp2.token, body: { prompt: "" } });
check("空画面描述 400", r.status === 400);

// ---------------------------------------------------------------- 聊天
group("聊天（内置 vf，无外网）");
let c = await chat({ token: emp2.token, provider: "vf", session: "s_" + uid(), messages: [{ role: "user", content: "你好" }], timeout: 30000 });
check("成员 vf 聊天有回复", c.text.length > 0 && c.done != null, JSON.stringify(c.errors));
c = await chat({ token: T, provider: "nonexistent", session: "s_" + uid(), messages: [{ role: "user", content: "hi" }], timeout: 30000 });
check("未知 provider 400（不静默回退）", c.status === 400 && /未知的模型供应商/.test(c.rawError?.error ?? ""), JSON.stringify(c.rawError));
c = await chat({ token: emp2.token, provider: "vf", employee: "emp_u_someone_else", session: "s_" + uid(), messages: [{ role: "user", content: "hi" }], timeout: 30000 });
check("成员冒用他人 AI 员工 403", c.status === 403, JSON.stringify(c.rawError));
{ // 会话归属（AUTH-01）：成员自报主控的 session → 403（前端据此新建会话，不再 500）
  const bossSession = "s_boss_" + uid();
  await chat({ token: T, provider: "vf", session: bossSession, messages: [{ role: "user", content: "占位" }], timeout: 30000 });
  c = await chat({ token: emp2.token, provider: "vf", session: bossSession, messages: [{ role: "user", content: "偷看" }], timeout: 30000 });
  check("成员自报他人会话 → 403 而非 500", c.status === 403, `${c.status} ${JSON.stringify(c.rawError)}`);
}
const noAuth = await fetch(BASE + "/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
check("未登录聊天 401", noAuth.status === 401);
r = await api("POST", "/api/chat/cancel", { token: T, body: { session: "not_running" } });
check("取消不存在会话幂等 200", r.status === 200 && r.data.ok);
// 并发：5 个会话同时聊（服务端隔离）
const par = await Promise.all([1, 2, 3, 4, 5].map((i) => chat({ token: T, provider: "vf", session: `s_par_${tag}_${i}`, messages: [{ role: "user", content: `并发 ${i}` }], timeout: 30000 })));
check("5 路并发会话各自有回复且 session 不串", par.every((x, i) => x.text.length > 0 && x.start?.session === `s_par_${tag}_${i + 1}`), par.map((x) => x.start?.session).join(","));
// XSS 载荷入库不崩
const xssDoc = await api("POST", "/api/kb", { token: T, body: { title: "<svg onload=alert(1)>", content: "<script>alert(1)</script>", tags: ["<img src=x onerror=alert(1)>"] } });
check("XSS 载荷入库不崩（前端负责净化）", xssDoc.status === 200);
await api("DELETE", `/api/kb/${xssDoc.data.id}`, { token: T });

if (SLOW) {
  group("[slow] 真实模型 + 生图");
  c = await chat({ token: T, provider: "VF", session: "s_" + uid(), messages: [{ role: "user", content: "只回复两个字：收到" }], timeout: 60000 });
  check("VF 真实模型回复", /收到/.test(c.text), c.text.slice(0, 80) + JSON.stringify(c.errors));
  const t0 = Date.now();
  r = await api("POST", "/api/image", { token: T, body: { prompt: "a blue shield icon on white background, flat design" }, timeout: 200000 });
  check(`生图成功 (${Date.now() - t0}ms) via ${r.data?.via}`, r.status === 200 && r.data.ok && /!\[.*\]\(\/generated\//.test(r.data.text), JSON.stringify(r.data).slice(0, 200));
  if (r.data?.files?.[0]) {
    const img = await api("GET", r.data.files[0].path, { raw: true });
    check("生成图片可访问且 content-type 为 image/*", img.status === 200 && /^image\//.test(img.headers.get("content-type") ?? ""));
  }
  c = await chat({ token: T, provider: "VF", session: "s_" + uid(), messages: [{ role: "user", content: "请用 image_generate 工具画一个红色的圆形图标（白底），然后把图片显示出来。" }], timeout: 200000 });
  check("对话内让模型生图并引用图片", c.tools.some((t) => /image_generate/.test(t.name) && !t.isError) && /\/generated\//.test(c.text), `tools=${c.tools.map((t) => t.name).join(",")} text=${c.text.slice(0, 120)}`);
}

// ---------------------------------------------------------------- 许可开关与客户端校验联动
group("本地许可占位（单机模式恒为可用，无远程授权链路）");
r = await api("GET", "/api/admin/license", { token: T });
check("读取许可状态 → enabled:true / local:true", r.status === 200 && r.data.enabled === true && r.data.local === true, JSON.stringify(r.data));

// ---------------------------------------------------------------- 清理
group("清理");
for (const u of [empUser, obsUser, lockUser].filter(Boolean)) {
  r = await api("DELETE", `/api/admin/users/${u.id}`, { token: T });
  check(`删除 ${u.username}（含 AI 身份/团队清理）`, r.status === 200, JSON.stringify(r.data));
}
r = await api("GET", "/api/health");
check("测试后服务器仍健康", r.status === 200 && r.data.ok);
process.exit(summary() ? 0 : 1);
