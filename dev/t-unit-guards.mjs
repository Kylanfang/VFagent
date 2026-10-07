// 单元守护（不依赖运行中的服务）：把"只能靠读代码发现"的边界行为钉成回归断言。
// 覆盖：SSRF 地址判定 / 上下文裁剪保最新消息 / MCP 工具名长度与命名冲突 / 工具结果归一化 /
//       时间 MCP 的日期·时区·夏令时 / 配置损坏自愈 / 任务删除（NOT NULL 崩溃回归）。
// 运行：node dev/t-unit-guards.mjs   （退出码非 0 表示有断言失败）
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 隔离配置目录：这些模块在 import 期就会建库/读配置，绝不能碰真实数据
const TMP = mkdtempSync(path.join(os.tmpdir(), "vf-guard-"));
process.env.VFLETCH_CONFIG_DIR = TMP;
process.env.VFLETCH_ROOT = ROOT;
process.env.VFLETCH_WORKSPACE = TMP;
process.env.VFLETCH_RMS_SCAN = "off";

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? "  ← " + String(detail).slice(0, 300) : ""}`); }
};
const group = (t) => console.log(`\n▶ ${t}`);

// ---------------------------------------------------------------------------
group("SSRF 地址判定（内网/元数据/保留地址必须全部拦截）");
{
  const { isBlockedAddress } = await import("../server/lib/builtin.mjs");
  const must = [
    "127.0.0.1", "10.0.0.1", "192.168.1.5", "169.254.169.254", "100.100.100.200", "0.0.0.0",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:7f00:1",
    "fd00::1", "fe80::1", "fc00::1", "64:ff9b::7f00:1",
  ];
  const mustNot = ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"];
  for (const a of must) check(`拦截 ${a}`, isBlockedAddress(a) === true);
  for (const a of mustNot) check(`放行 ${a}`, isBlockedAddress(a) === false);
}

// ---------------------------------------------------------------------------
group("上下文裁剪：最新消息绝不能被裁掉");
{
  const { trimHistoryToWindow } = await import("../server/lib/context.mjs");
  const sys = { role: "system", content: "S".repeat(4000) };
  // 单条超大最新消息（远超预算）—— 旧实现会把它连同全部历史一起裁掉
  const huge = { role: "user", content: "问".repeat(400000) };
  const r = trimHistoryToWindow([sys, { role: "user", content: "早期".repeat(500) }, huge], 8000);
  const last = r.history[r.history.length - 1];
  check("超预算时最新用户消息仍保留", last != null && last.role === "user" && String(last.content).includes("问"), `kept=${r.history.length}`);
  check("被截断但仍带说明", String(last?.content ?? "").includes("已截断"));
  check("system 永远保留", r.history[0] === sys);

  // 工具组完整性：assistant(tool_calls) 与随后 tool 结果必须同生共死（否则上游会因孤立 tool 消息报 400）
  const hist = [
    sys,
    { role: "user", content: "u1" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "R".repeat(200000) },
    { role: "assistant", content: "done" },
  ];
  const r2 = trimHistoryToWindow(hist, 8000);
  const keptToolIds = new Set(r2.history.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  const callIds = new Set(r2.history.flatMap((m) => m.tool_calls ?? []).map((c) => c.id));
  const orphans = [...keptToolIds].filter((id) => !callIds.has(id));
  check("不产生孤立 tool 消息", orphans.length === 0, JSON.stringify(orphans));
}

// ---------------------------------------------------------------------------
group("MCP：工具名长度上限与重名自动改名");
{
  const { namespacedToolName, normalizeToolResult } = await import("../server/lib/mcp-manager.mjs");
  const long = "x".repeat(200);
  for (const limit of [64, 48, 32, 24]) {
    const { name } = namespacedToolName("srv", long, limit);
    check(`limit=${limit} 时名称不超过上限`, name.length <= limit, `len=${name.length} ${name}`);
  }
  const { name } = namespacedToolName("filesystem", "read_file", 64);
  check("短名保持 __ 命名空间形式", name === "filesystem__read_file", name);

  const r1 = normalizeToolResult({ content: [], structuredContent: { a: 1 } });
  check("仅有 structuredContent 时不丢失输出", r1.text.includes('"a"'), r1.text);
  const r2 = normalizeToolResult({ content: [{ type: "text", text: "boom" }], isError: true });
  check("isError 透传", r2.isError === true && r2.text.includes("boom"), JSON.stringify(r2));
  const r3 = normalizeToolResult({ content: [] });
  check("空结果有兜底文案", typeof r3.text === "string" && r3.text.length > 0, r3.text);
}

// ---------------------------------------------------------------------------
group("时间 MCP：日期/星期字段与时区换算（含夏令时）");
{
  const child = spawn(process.execPath, [path.join(ROOT, "server", "mcp-time-stdio.mjs")], { stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  const rpc = (id, method, params) => new Promise((res) => { pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  const tool = async (id, name, args) => {
    const m = await rpc(id, "tools/call", { name, arguments: args });
    if (m.error) return { error: m.error.message };
    return JSON.parse(m.result.content[0].text);
  };
  await rpc(1, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "guard", version: "1" } });
  const t = await tool(2, "get_current_time", { timezone: "Asia/Shanghai" });
  check("date 为 ISO 日期", /^\d{4}-\d{2}-\d{2}$/.test(t.date ?? ""), JSON.stringify(t));
  check("time 为 HH:MM:SS（不含星期）", /^\d{2}:\d{2}:\d{2}$/.test(t.time ?? ""), JSON.stringify(t.time));
  check("weekday 只含星期", /^星期[日一二三四五六]$/.test(t.weekday ?? ""), JSON.stringify(t.weekday));
  const raw = await rpc(3, "tools/call", { name: "get_current_time", arguments: {} });
  check("tools/call 结果未被双层 content 包裹", !/"content"\s*:\s*\[/.test(raw.result.content[0].text), raw.result.content[0].text.slice(0, 100));
  const jan = await tool(4, "convert_timezone", { time: "2026-01-15T12:00:00", fromZone: "America/New_York", toZone: "UTC" });
  const jul = await tool(5, "convert_timezone", { time: "2026-07-15T12:00:00", fromZone: "America/New_York", toZone: "UTC" });
  check("纽约冬令时换算正确 (-5)", jan.iso === "2026-01-15T17:00:00.000Z", JSON.stringify(jan));
  check("纽约夏令时换算正确 (-4)", jul.iso === "2026-07-15T16:00:00.000Z", JSON.stringify(jul));
  child.kill();
}

// ---------------------------------------------------------------------------
group("配置损坏自愈与字段合并");
{
  const settings = await import("../server/lib/settings.mjs");
  // 写坏 mcp.json，再读：必须不抛错、且把坏文件留证改名
  writeFileSync(path.join(TMP, "mcp.json"), "{ this is not json", "utf8");
  let threw = false;
  try { settings.getMcpServerDefinition("nope"); } catch { threw = true; }
  check("损坏的 mcp.json 不会让调用方抛错", threw === false);
  const backups = readdirSync(TMP).filter((f) => f.startsWith("mcp.json.corrupt-"));
  check("损坏文件被改名留证", backups.length === 1, JSON.stringify(readdirSync(TMP)));

  // 字段合并：UI 未回传的 env/headers/notes 不得被覆盖丢失
  settings.addMcpServer({ id: "merge-test", name: "A", transport: "stdio", command: "node", args: [], env: { TOKEN: "env:MY_TOKEN" }, headers: { authorization: "env:H" }, notes: "keep me", enabled: false });
  const def = settings.getMcpServerDefinition("merge-test");
  check("首次写入保留 env/headers/notes", def?.env?.TOKEN === "env:MY_TOKEN" && def?.headers?.authorization === "env:H" && def?.notes === "keep me", JSON.stringify(def));
  settings.addMcpServer({ id: "merge-test", name: "B", transport: "stdio", command: "node", args: [] });
  const def2 = settings.getMcpServerDefinition("merge-test");
  check("二次保存不丢失 env/headers/notes", def2?.env?.TOKEN === "env:MY_TOKEN" && def2?.headers?.authorization === "env:H" && def2?.notes === "keep me", JSON.stringify(def2));
  check("二次保存更新了显式字段", def2?.name === "B", JSON.stringify(def2?.name));
}

// ---------------------------------------------------------------------------
group("任务删除：已有工具留痕的任务必须能删（NOT NULL 崩溃回归）");
{
  const db = await import("../server/lib/db.mjs");
  db.openDb();
  const rms = await import("../server/lib/rms.mjs");
  // 建一个最小 AI 员工（createTask 会校验承接人存在）
  db.run("INSERT OR IGNORE INTO ai_employees (id, name, provider_id, status, updated_at) VALUES (?,?,?,'active',datetime('now','localtime'))", "guard_emp", "守护员工", "guard");
  const task = rms.createTask({ title: "删除回归", detail: "x", createdBy: null, assignees: ["guard_emp"] });
  // 造出"任务跑过"的留痕：messages / tool_calls 都挂在该任务会话上
  db.run("INSERT INTO messages (conversation_id, role, content) VALUES (?,?,?)", task.conversation_id, "user", "hi");
  db.run("INSERT INTO tool_calls (conversation_id, tool_name, arguments, result) VALUES (?,?,?,?)", task.conversation_id, "kb_search", "{}", "ok");
  let ok = false;
  let err = "";
  try { rms.deleteTask(task.id); ok = true; } catch (e) { err = String(e?.message ?? e); }
  check("删除已执行过的任务不抛错", ok, err);
  check("任务行已移除", rms.taskDetail(task.id) == null);
  const left = db.get("SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?", task.conversation_id);
  check("专属任务会话留痕一并清理", (left?.c ?? 0) === 0, JSON.stringify(left));

  // todo_write 重复 key 不应打断回合
  const conv = "conv_dedupe_test";
  db.run("INSERT INTO conversations (id, title, source) VALUES (?,?,?)", conv, "t", "chat");
  let dupErr = "";
  try {
    rms.recordTodoSet({ conversationId: conv, tasks: [{ id: "a", text: "第一项" }, { id: "a", text: "重复 id" }, { id: "", text: "" }, { text: "同文本" }, { text: "同文本" }] });
  } catch (e) { dupErr = String(e?.message ?? e); }
  check("重复 todo key 不抛 UNIQUE 约束错误", dupErr === "", dupErr);
  const todos = db.all("SELECT task_key, text FROM todos WHERE conversation_id = ? ORDER BY rowid", conv);
  check("重复项都被保留（追加序号而非丢弃）", todos.length === 4, JSON.stringify(todos));
}

// ---------------------------------------------------------------------------
group("模型 SSE 解析：中止必须显式抛错（不能被当成正常完成）");
{
  const { parseSse } = await import("../server/lib/model.mjs");
  const fakeResponse = (chunks) => ({
    body: (async function* () { for (const c of chunks) yield new TextEncoder().encode(c); })(),
  });
  // 正常流：能解析出事件
  const ok = [];
  for await (const ev of parseSse(fakeResponse(['data: {"a":1}\n\n', "data: [DONE]\n\n"]), null)) ok.push(ev);
  check("正常流可解析事件", ok.length === 1 && ok[0].a === 1, JSON.stringify(ok));

  // 已中止的流：必须抛错，而不是安静返回
  const ctrl = new AbortController();
  ctrl.abort();
  let abortedThrew = false;
  try {
    for await (const _ of parseSse(fakeResponse(['data: {"a":1}\n\n']), ctrl.signal)) void _;
  } catch (e) { abortedThrew = e?.name === "AbortError" || e?.aborted === true; }
  check("已中止的信号 → 抛出可识别的中止错误", abortedThrew);

  // 流读到一半被中止：同样必须抛错
  const ctrl2 = new AbortController();
  const partial = [];
  let midThrew = false;
  try {
    for await (const ev of parseSse(fakeResponse(['data: {"a":1}\n\n', 'data: {"b":2}\n\n']), ctrl2.signal)) {
      partial.push(ev);
      ctrl2.abort();
    }
  } catch (e) { midThrew = e?.name === "AbortError" || e?.aborted === true; }
  check("流中途中止 → 抛出可识别的中止错误", midThrew && partial.length >= 1, `partial=${partial.length} threw=${midThrew}`);
}

// ---------------------------------------------------------------------------
group("MCP 子进程回收：必须按进程树杀（npx → 真实 server 的孙进程不能残留）");
{
  const { killProcessTree } = await import("../server/lib/mcp-manager.mjs");
  const { spawn, spawnSync } = await import("node:child_process");
  const { readFileSync: rf, writeFileSync: wf, existsSync: ef } = await import("node:fs");
  const path = await import("node:path");
  const pidFile = path.join(TMP, "grandchild.pid");
  // 父进程再 spawn 一个孙进程，模拟 `npx → node server.js` 的层级
  const parent = spawn(
    process.execPath,
    ["-e", `const{spawn}=require('child_process');const fs=require('fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`],
    { stdio: "ignore" },
  );
  let grandPid = null;
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    if (ef(pidFile)) { grandPid = Number(rf(pidFile, "utf8").trim()); break; }
  }
  const alive = (pid) => {
    if (pid == null || !Number.isFinite(pid)) return false;
    if (process.platform === "win32") {
      const out = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout ?? "";
      return out.includes(String(pid));
    }
    try { process.kill(pid, 0); return true; } catch { return false; }
  };
  check("构造出 父→孙 两级子进程", parent.pid != null && grandPid != null, `parent=${parent.pid} grand=${grandPid}`);
  check("回收前孙进程存活", alive(grandPid));
  killProcessTree(parent.pid);
  await new Promise((r) => setTimeout(r, 800));
  check("按进程树回收后：父进程已退出", !alive(parent.pid), `parent=${parent.pid}`);
  check("按进程树回收后：**孙进程也已退出**（关键：只杀直接子进程会漏掉它）", !alive(grandPid), `grand=${grandPid}`);
  try { wf(pidFile, ""); } catch {}
}

// ---------------------------------------------------------------------------
group("code_run 运行时可移植性（云端没装 python 时不能让「AI 写代码」整条路子死掉）");
{
  const src = readFileSync(path.join(ROOT, "server", "lib", "builtin.mjs"), "utf8");
  // 起因：2026-09-13 云端实测，批准审批后 code__code_run 返回
  // 「内置工具执行失败: 未找到可用的 python，请确认已安装 Python 并加入 PATH」——
  // 原候选表以开发机私有路径打头且没有 POSIX 候选，云端 Ubuntu 必然命中 fallback 失败。
  check("python 候选表含 POSIX 解释器（python3）", /"python3"/.test(src));
  check("python 候选表含 /usr/bin 绝对路径（systemd 环境 PATH 极简）", /\/usr\/bin\/python3/.test(src));
  check("支持 VFLETCH_PYTHON 显式指定解释器", /VFLETCH_PYTHON/.test(src));
  check("缺运行时给出可改道的提示（引导改用 language=\"node\"）", /language:"node"|language=\\"node\\"/.test(src));
  check("候选表不再只依赖开发机私有路径", !/const candidates = \[\s*"C:\\\\Users/.test(src));
  // 真跑一次：node 运行时必须始终可用（服务自己就跑在 node 上）
  const { ALL_TOOL_DEFS } = await import("../server/lib/builtin.mjs");
  const codeRun = ALL_TOOL_DEFS.find((t) => t.name === "code_run");
  check("code_run 工具存在且描述已注明 node 始终可用", codeRun != null && /node/.test(codeRun.description));
  const out = await codeRun.handler({ language: "node", code: "console.log(6*7)" });
  check("code_run(node) 真实执行并拿到 stdout=42", String(out?.stdout ?? "").includes("42") && out?.exitCode === 0, JSON.stringify(out).slice(0, 200));
  const py = await codeRun.handler({ language: "python", code: "print(1)" }).catch((e) => ({ err: String(e?.message ?? e) }));
  // 本机有 python 就跑通，没有则必须是"可改道"的人话错误（两种都算通过，但不允许是原来的死错误）
  const pyOk = (py?.exitCode === 0) || /language:"node"|改写为 JavaScript/.test(String(py?.err ?? ""));
  check("code_run(python) 要么执行成功，要么给出可改道提示", pyOk, JSON.stringify(py).slice(0, 200));
}

// ---------------------------------------------------------------------------
group("供应商 id 规范化：非法 id 必须是「更新原条目」而不是新增重复条目");
{
  const fs = await import("node:fs");
  // 注意：CONFIG_DIR 在 config.mjs 导入期就定好了（= 本套件开头设置的 TMP），
  // 所以夹具必须写在那个目录里，改环境变量再 import 是无效的。
  const { CONFIG_DIR: cfgDir } = await import("../server/lib/config.mjs");
  const modelFile = path.join(cfgDir, "model.json");
  fs.writeFileSync(modelFile, JSON.stringify({
    active: "GLM-4.6",
    providers: { "GLM-4.6": { label: "GLM-4.6", model: "GLM-4.6-W8A8", baseUrl: "http://gateway.example.com/v1", apiKey: "k" } },
  }, null, 2));
  const { saveProvider } = await import("../server/lib/settings.mjs");
  // 起因：云端配置里真实存在 `GLM-4.6` 这种带点号的旧 id；设置页"编辑并保存"时原实现会派生
  // `glm_4_6` 新建一条，把 `GLM-4.6` 留成重复条目，active 也被悄悄切走。
  saveProvider({ id: "GLM-4.6", fields: { model: "GLM-4.6-W8A8-v2" }, setActive: true });
  const after = JSON.parse(fs.readFileSync(modelFile, "utf8"));
  const keys = Object.keys(after.providers);
  check("保存非法 id 后没有产生重复条目", keys.length === 1, keys.join(","));
  check("沿用原 key（GLM-4.6）而不是新派生 key", keys[0] === "GLM-4.6", keys.join(","));
  check("字段确实被更新", after.providers["GLM-4.6"]?.model === "GLM-4.6-W8A8-v2", JSON.stringify(after.providers["GLM-4.6"]).slice(0, 120));
  check("active 仍指向该条目", after.active === "GLM-4.6", String(after.active));
  check("原 baseUrl/apiKey 未被空值抹掉", after.providers["GLM-4.6"]?.baseUrl === "http://gateway.example.com/v1" && after.providers["GLM-4.6"]?.apiKey === "k", JSON.stringify(after.providers["GLM-4.6"]).slice(0, 140));
  // 真正的新供应商（id 非法且不匹配任何已有 key）仍应正常派生
  saveProvider({ id: "新建.X", fields: { label: "新建 API", model: "m", baseUrl: "http://x.example/v1" } });
  const after2 = JSON.parse(fs.readFileSync(modelFile, "utf8"));
  const newKey = Object.keys(after2.providers).find((k) => k !== "GLM-4.6");
  check("全新的非法 id 仍按 label 派生合法 id", Object.keys(after2.providers).length === 2 && /^[a-z][a-z0-9_-]*$/i.test(String(newKey)), Object.keys(after2.providers).join(","));
}

// ---------------------------------------------------------------------------
group("原子写：Windows 上目标文件被占用时不能让进程直接崩");
{
  // 起因：2026-09-13 全量连跑时 t-unit-guards 无汇总退出（进程崩溃），现场是
  // EPERM: rename 'mcp.json.tmp' -> 'mcp.json'（杀毒/索引/另一进程短暂持有句柄）。
  // 真实场景等价于"保存设置偶发 500"，所以修在 atomicWriteFile 本身。
  const { atomicWriteFile } = await import("../server/lib/util.mjs");
  const { existsSync } = await import("node:fs");
  const src = readFileSync(path.join(ROOT, "server", "lib", "util.mjs"), "utf8");
  check("对 EPERM/EBUSY/EACCES 做有限次重试", /EPERM/.test(src) && /EBUSY/.test(src) && /for \(let i = 0; i < 4/.test(src));
  check("重试仍失败时退回直接覆盖写（不把异常丢给调用方）", new RegExp('writeFileSync\\(file, data, "utf8"\\)').test(src));
  check("降级路径清理 .tmp 残留", /unlinkSync\(tmp\)/.test(src));
  const f = path.join(TMP, "atomic.json");
  atomicWriteFile(f, JSON.stringify({ a: 1 }));
  atomicWriteFile(f, JSON.stringify({ a: 2 }));
  check("正常路径：覆盖后可解析且内容为最新", JSON.parse(readFileSync(f, "utf8")).a === 2);
  check("正常路径：不留下 .tmp", !existsSync(`${f}.tmp`));
}

// ---------------------------------------------------------------------------
group("运行时版本声明：engines 必须与 node:sqlite 的真实要求一致");
{
  // 起因（2026-09-14）：`server/lib/db.mjs` 在模块加载期就 `import { DatabaseSync } from "node:sqlite"`，
  // 而 `node:sqlite` 自 **Node 22.5.0** 才存在。低版本 Node 上会**装得上、起不来**
  // （启动即 ERR_MODULE_NOT_FOUND: node:sqlite），且报错完全不指向真实原因。
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const floor = String(pkg.engines?.node ?? "");
  const m = floor.match(/(\d+)(?:\.(\d+))?/);
  const major = Number(m?.[1] ?? 0);
  const minor = Number(m?.[2] ?? 0);
  check("engines.node 声明为 >=22.5（node:sqlite 的最低要求）", major > 22 || (major === 22 && minor >= 5), `engines.node=${floor}`);
  const dbSrc = readFileSync(path.join(ROOT, "server", "lib", "db.mjs"), "utf8");
  check("db.mjs 确实依赖 node:sqlite（所以下限必须是 22.5）", /node:sqlite/.test(dbSrc));
  const kitSrc = readFileSync(path.join(ROOT, "scripts", "make-local-kit.mjs"), "utf8");
  check("本地运行套件在说明里声明 Node >=22.5", /22\.5/.test(kitSrc));
  check("本地运行套件不含服务器/云端地址", !/systemctl|阿里云|central-server|\/opt\//.test(kitSrc));
}

// ---------------------------------------------------------------------------
try { rmSync(TMP, { recursive: true, force: true }); } catch {}
// 与 testlib.summary() 同格式，便于 dev/run-all.sh 的日志 grep 与 CI 解析
console.log(`\n==== 结果: 通过 ${pass} / 失败 ${fail} ====`);
process.exitCode = fail === 0 ? 0 : 1;
