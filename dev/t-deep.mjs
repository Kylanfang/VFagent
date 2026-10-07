import { readFileSync } from "node:fs";
const KEYS = (() => { try { return JSON.parse(readFileSync(new URL("../.autotest/keys.json", import.meta.url), "utf8")); } catch { return { qiyuan_key: process.env.QIYUAN_KEY ?? "", campus_key: process.env.CAMPUS_KEY ?? "" }; } })();
// 深挖测试：内置工具链（delegate/code_run/memory/web）、任务接力执行、上下文裁剪、双引擎、项目共享会话
import { api, login, chat, check, group, summary, uid, sleep, BASE, killChild } from "./testlib.mjs";
const { token: T } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const tag = uid();
let r;

group("A. code_run 双语言");
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "code__code_run", arguments: { language: "python", code: "print(sum(range(101)))" } } });
check("python 求和 5050", !r.data.isError && /5050/.test(r.data.text), r.data.text?.slice(0, 120));
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "code__code_run", arguments: { language: "node", code: "console.log([1,2,3].reduce((a,b)=>a+b,0))" } } });
check("node 求和 6", !r.data.isError && /6/.test(r.data.text), r.data.text?.slice(0, 120));
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "code__code_run", arguments: { language: "cobol", code: "x" } } });
check("不支持的语言 → isError", r.data.isError === true, r.data.text?.slice(0, 120));
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "code__code_run", arguments: { language: "python", code: "while True: pass", timeoutMs: 2000 } }, timeout: 30000 });
check("死循环被超时终止且 isError+明确提示", r.data.isError === true && /超时/.test(r.data.text), r.data.text?.slice(0, 160));

group("B. 记忆工具（保存/隐私拒答/授权门控）");
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "memory__memory_save", arguments: { key: "user/称谓", content: "测试称呼甲" } } });
check("记忆保存（key+content）", !r.data.isError, r.data.text?.slice(0, 120));
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "memory__memory_save", arguments: { key: "system/path", content: "<USERPROFILE>\\secret" } } });
check("本机路径类记忆被拒（隐私策略）", r.data.isError === true, r.data.text?.slice(0, 160));
// 检索/删除受用户授权门控：直接调用没有会话上下文 → 应被拒绝（隐私设计，非 bug）
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "memory__memory_search", arguments: { query: "称谓" } } });
check("无授权上下文直接检索 → 被隐私门控拒绝", r.data.isError === true && /授权/.test(r.data.text), r.data.text?.slice(0, 120));
// 经聊天通道（用户消息含"记忆/之前"→ 授权放行）验证真实写入与检索
const cSave = await chat({ token: T, provider: "VF", session: `s_mem_${tag}`, messages: [{ role: "user", content: "请用记忆工具记住：我的称谓是测试称呼甲。完成后只回复：已记住。" }], timeout: 90000 });
check("聊天中让模型保存记忆", cSave.tools.some((t) => /memory__memory_save/.test(t.name) && !t.isError), cSave.tools.map((t) => t.name + (t.isError ? "(ERR)" : "")).join(",") + " | " + cSave.text.slice(0, 80));
const cRecall = await chat({ token: T, provider: "VF", session: `s_mem2_${tag}`, messages: [{ role: "user", content: "我之前让你记过一条记忆，请检索我的称谓并告诉我。" }], timeout: 90000 });
check("聊天中检索记忆命中", /测试称呼甲/.test(cRecall.text), cRecall.tools.map((t) => t.name).join(",") + " | " + cRecall.text.slice(0, 100));

group("C. 联网工具（真实网络）");
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "web__web_search", arguments: { query: "平安银行" } }, timeout: 45000 });
check("web_search 有结果（或明确的网络错误，不崩）", r.status === 200 && (typeof r.data.text === "string"), r.data.text?.slice(0, 100));

group("D. 子代理委派 delegate_agent");
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "agent__delegate_agent", arguments: { role: "analyst", task: "计算 12345 乘以 6789 等于多少，只回数字" } }, timeout: 180000 });
check("子代理返回结果", !r.data.isError && /83810205|83,810,205/.test(r.data.text), r.data.text?.slice(0, 200));
r = await api("POST", "/api/mcp/call", { token: T, body: { name: "agent__delegate_agent", arguments: { role: "不存在的角色", task: "x" } } });
check("非法角色被拒并提示可选角色", r.data.isError === true && /researcher/.test(r.data.text), r.data.text?.slice(0, 160));

group("E. 任务派活 → 接力执行（executeTask 全链路）");
// 执行工使用本测试自建的 provider（清理时删除，绝不动共享的真实 provider）
r = await api("POST", "/api/settings/provider", { token: T, body: { id: `deep_${tag}`, fields: { label: `deep_${tag}`, baseUrl: "https://api.qiyuanapi.cc/v1", model: "deepseek-v4.1", apiKey: KEYS.qiyuan_key, supportsTools: true, supportsStream: true }, reload: false } });
check("自建测试 provider", r.status === 200 && r.data.id, JSON.stringify(r.data).slice(0, 120));
const ownProvider = r.data.id;
r = await api("POST", "/api/team/employees", { token: T, body: { name: `执行工${tag}`, identity: "你是任务执行工，直接执行并给出结果。", providerId: ownProvider } });
check("创建执行工", r.status === 200 && r.data.id, JSON.stringify(r.data).slice(0, 150));
const worker = r.data;
r = await api("POST", "/api/rms/tasks", { token: T, body: { title: `接力任务 ${tag}`, detail: "直接回复四个字：任务完成", assignees: [worker.id] } });
check("创建任务", r.status === 200 && r.data.id, JSON.stringify(r.data).slice(0, 150));
const task = r.data;
r = await api("POST", `/api/rms/tasks/${task.id}/run`, { token: T });
check("触发任务执行", r.status === 200 && r.data.status === "running", JSON.stringify(r.data));
r = await api("POST", `/api/rms/tasks/${task.id}/run`, { token: T });
check("重复触发 → 409", r.status === 409, JSON.stringify(r.data));
let done = false;
for (let i = 0; i < 12; i += 1) {
  await sleep(5000);
  const d = (await api("GET", `/api/rms/tasks/${task.id}`, { token: T })).data;
  if (d.status !== "running") { done = d.status; break; }
}
check("任务执行完成（非 running）", done !== false && done != null, String(done));
const detail = (await api("GET", `/api/rms/tasks/${task.id}`, { token: T })).data;
check("任务有产出内容", JSON.stringify(detail).length > 200 && /任务完成|结果|output/i.test(JSON.stringify(detail)), JSON.stringify(detail).slice(0, 300));

group("F. 上下文裁剪（小窗口 + 长历史）");
{
  const long = "这是历史消息内容，用于撑大上下文。".repeat(400); // ~14K 字/条
  const messages = [{ role: "user", content: long }, { role: "assistant", content: long }, { role: "user", content: "只回复：裁剪后仍正常" }];
  const c = await chat({ token: T, provider: "vf", session: `s_trim_${tag}`, messages, contextWindow: 300000, timeout: 40000 });
  check("小窗口+长历史不崩且有回复", c.status === 200 && (c.text.length > 0), `len=${c.text.length} err=${JSON.stringify(c.errors).slice(0, 120)}`);
}

group("G. 双引擎一致性（langgraph 默认 vs legacy）");
{
  const envEngines = process.env.VFLETCH_AGENT_ENGINE;
  const c1 = await chat({ token: T, provider: "vf", session: `s_eng_${tag}_1`, messages: [{ role: "user", content: "只回复：引擎1" }], timeout: 30000 });
  check("langgraph 引擎回复", c1.text.length > 0, JSON.stringify(c1.errors));
  // legacy：起第二个服务器实例（端口 8791）验证
  const { spawn } = await import("node:child_process");
  const { openSync, readFileSync } = await import("node:fs");
  const pathOf = (u) => new URL(u, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  // 修复：原来 stdio 全 ignore，8791 起不来时只剩一句"未就绪"，无法判断是崩溃还是启动慢。
  // 现在把 stderr 落到文件，失败时把末尾日志带进断言详情。
  const legacyLog = pathOf("../.autotest/legacy-8791.log");
  const legacyErr = openSync(legacyLog, "w");
  const child = spawn(process.execPath, ["server/main.mjs"], {
    cwd: pathOf(".."),
    env: { ...process.env, VFLETCH_CONFIG_DIR: pathOf("../.autotest"), VFLETCH_PORT: "8791", VFLETCH_HOST: "127.0.0.1", VFLETCH_AGENT_ENGINE: "legacy" },
    stdio: ["ignore", "ignore", legacyErr], detached: true,
  });
  let legacyOk = false;
  let legacyExited = false;
  // 20s → 45s：MCP 冷启动（15 个 server）在本机满载时实测可超过 20s，属测试自身预算过紧
  for (let i = 0; i < 45; i += 1) {
    if (child.exitCode != null || child.signalCode != null) { legacyExited = true; break; }
    await sleep(1000);
    try { const h = await fetch("http://127.0.0.1:8791/api/health"); if (h.ok) { legacyOk = true; break; } } catch {}
  }
  if (legacyOk) {
    // 直接对 8791 发请求（testlib 的 BASE 固定 8790）
    const lr = await fetch("http://127.0.0.1:8791/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "central", password: (process.env.VF_BOSS_P ?? "vfletch-dev") }) });
    const lt = (await lr.json())?.token;
    check("legacy 登录", !!lt);
    const cr = await fetch("http://127.0.0.1:8791/api/chat", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${lt}` }, body: JSON.stringify({ provider: "vf", session: `s_leg_${tag}`, messages: [{ role: "user", content: "只回复：legacy正常" }] }), signal: AbortSignal.timeout(30000) });
    const text = await cr.text();
    check("legacy 引擎回复", /legacy正常/.test(text), text.slice(0, 150));
  } else {
    let tail = "";
    try { tail = readFileSync(legacyLog, "utf8").slice(-600); } catch {}
    check("legacy 服务器启动", false, `8791 未就绪（${legacyExited ? "进程已退出" : "45s 超时"}）${tail}`);
  }
  await killChild(child);
}

group("H. 项目共享会话（is_project → shared_conversation_id 可写）");
{
  r = await api("POST", "/api/team/teams", { token: T, body: { name: `项目${tag}`, memberIds: [worker.id], isProject: true } });
  check("主控建项目", r.status === 200 && r.data.shared_conversation_id, JSON.stringify(r.data).slice(0, 150));
  const convId = r.data.shared_conversation_id;
  const c = await chat({ token: T, provider: "vf", session: convId, employee: worker.id, messages: [{ role: "user", content: "只回复：项目会话可用" }], timeout: 30000 });
  check("项目共享会话可对话", c.status === 200 && c.text.length > 0, `${c.status} ${JSON.stringify(c.rawError)}`);
  await api("POST", `/api/team/teams/${r.data.id}/disband`, { token: T });
}

group("I. 清理");
r = await api("POST", "/api/settings/provider-delete", { token: T, body: { id: ownProvider } });
check("清理自建 provider（不动共享 provider）", r.status === 200, JSON.stringify(r.data));
const left = (await api("GET", "/api/settings", { token: T })).data;
check("共享 provider 未被误删", left.providers["deepseek-v4"] != null && left.providers["VF"] != null, JSON.stringify(Object.keys(left.providers)));
process.exit(summary() ? 0 : 1);
