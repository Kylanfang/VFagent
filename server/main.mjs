import { mkdirSync, writeFileSync, createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";

import { activeProvider, loadModelConfig, WEB_DIST, CONFIG_DIR, ROOT as APP_ROOT } from "./lib/config.mjs";
import { htmlHeaders, COMMON_HEADERS } from "./lib/security-headers.mjs";
import { McpManager, normalizeToolResult, killOrphanedMcpChildrenSync } from "./lib/mcp-manager.mjs";
import { runTurn, CONFIRM_TIMEOUT_MS } from "./lib/chat.mjs";
import { getSettings, saveProvider, setActiveProvider, deleteProvider, saveMcpServers } from "./lib/settings.mjs";
import { recordUsage, usageSummary } from "./lib/usage.mjs";
import { BUILTIN_SERVERS, loadAuditData, AUDIT_MODULES, saveAuditRecord, bindMcpAdmin } from "./lib/builtin.mjs";
import { aigcOverview, runAigcScan } from "./lib/aigc-monitor.mjs";
import { reportEvent } from "./lib/report.mjs";
import { buildSuggestions } from "./lib/suggest.mjs";
import { json, log, readJsonBody, readRawBody, sseHeaders, sseSend, warn } from "./lib/util.mjs";
import { createModelClient } from "./lib/model.mjs";
import { clampContextWindow } from "./lib/context.mjs";
import { runInContext } from "./lib/run-context.mjs";
import * as team from "./lib/team.mjs";
import { openDb, dbHealthy } from "./lib/db.mjs";
import * as rms from "./lib/rms.mjs";
import * as auth from "./lib/auth.mjs";

const SCOPE = "server";
const STARTED_AT = new Date().toISOString();
// 版本号优先级：① 运行目录的 package.json（开发态最准）→ ② **构建期烧进产物的版本号**
// （`scripts/build-engine.mjs` 的 esbuild define 注入；独立运行套件的 app 目录里没有 package.json，
//  只读 package.json 会让 /api/meta 退化成 "0.0.0"，
//  而登录页「v{meta.version} · 本地服务在线」与设置页「版本」卡片都会把它显示给用户）。
// `typeof` 判断保证非 bundle 直跑 server/main.mjs 时不会抛未定义标识符。
const BUILD_VERSION = typeof __VF_BUILD_VERSION__ === "string" ? __VF_BUILD_VERSION__ : "0.0.0";
const APP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(APP_ROOT, "package.json"), "utf8")).version ?? BUILD_VERSION;
  } catch {
    return BUILD_VERSION;
  }
})();
const PORT = Number(process.env.VFLETCH_PORT ?? 8787);
const HOST = process.env.VFLETCH_HOST ?? "0.0.0.0"; // 默认可从局域网访问；只想本机访问时设 VFLETCH_HOST=127.0.0.1

const mcp = new McpManager();

// ---- 工具视图（按角色的沙箱）----
// 修复 SEC-02：聊天通道与 /api/mcp/call 必须共用同一套工具过滤，
// 否则直调接口会绕过聊天沙箱（曾可直调 secretary__ / mcp_admin__mcp_install / code__）。
// 安全默认：非主控一律剥离系统只读工具、MCP 安装/卸载、以及任意代码执行工具。
function toolViewFor(user, employeeId = null) {
  const isBoss = user?.role === "boss";
  // employeeId === null 表示"直接调用通道"（/api/mcp/call），不绑定具体会话：
  // 主控在该通道保留全量工具（含 secretary__ 系统只读工具），其余角色仍被剥离。
  const isSecretary = isBoss && (employeeId === "emp_secretary" || employeeId === null);
  let view = isSecretary ? mcp : mcp.without(["secretary__"]);
  // 修复审计 A2：MCP 安装/卸载不再暴露给【任何角色】的模型工具面（含主控）——
  // 聊天上下文会读入网页/附件等不可信内容，注入即等于任意进程拉起；
  // 安装入口收敛为 MCP 页手工添加 + 发现提案审批（人工闸门），模型侧仅保留只读 mcp_list。
  view = view.without(["mcp_admin__mcp_install", "mcp_admin__mcp_uninstall"]);
  if (!isBoss) {
    // code__code_run 是服务端无沙箱任意代码执行；多租户部署下默认对非主控关闭。
    // 若确需对成员开放（如本地单机演示），显式设置 VFLETCH_ALLOW_MEMBER_CODE=1。
    if (process.env.VFLETCH_ALLOW_MEMBER_CODE !== "1") view = view.without(["code__"]);
  }
  return view;
}

// 把动态安装/卸载/查看 MCP 的能力注入内置 mcp_admin 工具，使聊天时可自动装 MCP
bindMcpAdmin({
  install: (args) => mcp.installServer(args),
  uninstall: (id) => mcp.uninstallServer(id),
  list: () => mcp.snapshot(),
});

/**
 * 远端（http 传输）MCP 连通性探测：发送 JSON-RPC initialize 握手，返回耗时与服务信息。
 * 用于“添加远端 MCP 前先验证地址可用”，把网络/代理/路径问题挡在配置之前。
 */
async function probeRemoteMcp({ url, headers = {} }) {
  const target = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(target)) {
    return { ok: false, error: "url 必须以 http(s):// 开头" };
  }
  const t0 = Date.now();
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "V-Fletch", version: "0.1.0" },
        },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const latencyMs = Date.now() - t0;
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return { ok: false, httpStatus: res.status, latencyMs, error: text.slice(0, 300) || `HTTP ${res.status}` };
    }
    let info = null;
    try {
      const payload = JSON.parse(text);
      if (payload?.error != null) return { ok: false, latencyMs, error: JSON.stringify(payload.error).slice(0, 300) };
      if (payload?.result != null) info = { serverInfo: payload.result.serverInfo, protocolVersion: payload.result.protocolVersion };
    } catch {
      /* 非 JSON 响应（可能不是 MCP 端点） */
    }
    if (info == null) {
      return { ok: false, latencyMs, error: "响应不是 MCP initialize 结果：地址可能不是 Streamable HTTP MCP 端点" };
    }
    return { ok: true, httpStatus: res.status, latencyMs, ...info };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - t0, error: String(error?.message ?? error) };
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".png": "image/png",
};

function serveStatic(req, res, pathname) {
  try {
    return serveStaticInner(req, res, pathname);
  } catch (error) {
    // 前端重新构建的瞬间 dist 可能被整目录替换（vite 先清空再写入）：返回可读的 503 而非 500 堆栈
    warn(SCOPE, `静态资源读取失败: ${String(error?.message ?? error)} ${pathname}`);
    res.writeHead(503, { ...COMMON_HEADERS, "content-type": "text/html; charset=utf-8", "retry-after": "2" });
    res.end("<pre>V-Fletch 正在更新界面，请稍候 2 秒后刷新…</pre>");
  }
}

function serveStaticInner(req, res, pathname) {
  if (!existsSync(WEB_DIST)) {
    // 修复：这个分支只写了 content-type，绕过了统一安全头（其余静态/接口响应都带 COMMON_HEADERS）
    res.writeHead(200, { ...COMMON_HEADERS, "content-type": "text/html; charset=utf-8" });
    res.end(
      "<pre>V-Fletch 后端已启动，但前端未构建。\n请执行: npm run build:web\n或开发模式: npm run dev:web（vite 会代理到本端口）</pre>",
    );
    return;
  }
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.join(WEB_DIST, relative);
  const cachePolicy = (file) => {
    if (file.endsWith(".html") || file.endsWith("version.json")) return "no-cache"; // 入口与版本戳必须回源校验，否则队友端会停留在旧版本
    if (file.includes(`${path.sep}assets${path.sep}`)) return "public, max-age=31536000, immutable"; // 内容哈希命名，可永久缓存
    return "public, max-age=300";
  };
  // 修复 SEC-08（原审计 §四.4）：原 `target.startsWith(WEB_DIST)` 为字符串前缀判断，对与 dist 同前缀的
  // 兄弟目录不够严谨。改为 path.relative 包含判断：只要目标不在 WEB_DIST 之内即按 SPA 回退。
  const rel = path.relative(WEB_DIST, target);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !existsSync(target) || !statSync(target).isFile()) {
    sendHtmlFile(res, path.join(WEB_DIST, "index.html"));
    return;
  }
  if (target.endsWith(".html")) {
    sendHtmlFile(res, target);
    return;
  }
  res.writeHead(200, {
    ...COMMON_HEADERS,
    "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
    "cache-control": cachePolicy(target),
  });
  createReadStream(target).pipe(res);
}

// HTML 入口整体读入（体积小）以便按内联脚本计算 CSP 哈希；入口页永远 no-cache
function sendHtmlFile(res, file) {
  const html = readFileSync(file, "utf8");
  res.writeHead(200, htmlHeaders(html, { "cache-control": "no-cache" }));
  res.end(html);
}

function redactedProviders() {
  const config = loadModelConfig();
  return {
    active: config.active,
    defaults: config.defaults,
    providers: Object.values(config.providers).map((provider) => ({
      id: provider.id,
      label: provider.label,
      protocol: provider.protocol,
      model: provider.model,
      baseUrl: provider.baseUrl,
      hasApiKey: (provider.apiKey ?? "").length > 0,
      supportsTools: provider.supportsTools !== false,
      supportsStream: provider.supportsStream !== false,
      contextWindow: provider.contextWindow ?? null,
      notes: provider.notes ?? "",
    })),
  };
}

// ---------- 任务执行器：委派的 AI 员工接力执行，过程与产出全量留痕 ----------
const runningTasks = new Set();

async function executeTask(taskId) {
  if (runningTasks.has(taskId)) return;
  runningTasks.add(taskId);
  try {
    const task = rms.taskDetail(taskId);
    if (task == null) return;
    rms.updateTask(taskId, { status: "running", error: null });
    const cfg = loadModelConfig();
    const defaults = cfg.defaults ?? {};
    let history = [];
    let lastOutput = "";
    for (let i = 0; i < task.assignees.length; i += 1) {
      const empId = task.assignees[i];
      const emp = rms.listEmployees().find((e) => e.id === empId);
      const provider = cfg.providers?.[emp?.provider_id] ?? cfg.providers?.[cfg.active ?? Object.keys(cfg.providers ?? {})[0]];
      if (provider == null || provider.id === "vf" || provider.protocol === "vf") {
        throw new Error("尚未接入真实模型 API：请管理员在「设置 → 模型 API」添加后再委派任务（VF 前台模型只做接待，不执行任务）");
      }
      const empIdentity = emp?.identity ? `
【你的身份】${emp.identity}` : "";
      const prompt = i === 0
        ? `【委派任务】${task.title}
${task.detail ?? ""}${empIdentity}
请开始执行这个任务，直接输出你的成果。`
        : `【接力协作】你接替同事继续任务「${task.title}」。此前的进度成果如下：
${String(lastOutput).slice(0, 4000)}${empIdentity}
请在此基础上继续推进并完成，输出你的增量成果。`;
      rms.recordMessage({ conversationId: task.conversation_id, role: "user", content: `[委派给 ${emp?.name ?? empId}（${provider.label ?? provider.id}）] ${prompt}`, employeeId: empId });
      // 修复（权限提升）：原实现把**未过滤的** mcp 管理器直接交给任务执行器，
      // 于是 Task 通道成为 toolViewFor 的旁路 —— 任何能建任务的员工只要在任务描述里写
      // "调用 secretary__db_query 查出所有用户" 或 "mcp_admin__mcp_install 装一个 filesystem server"，
      // 就能拿到对话通道里明确剥离过的能力（全库只读查询、任意进程拉起、代码执行）。
      // 任务会话代表的是**创建者**的授权面，这里按创建者身份套用同一套过滤规则。
      const taskOwner = auth.listUsers().find((u) => u.id === task.created_by) ?? null;
      const mcpForEmp = toolViewFor(taskOwner, empId);
      const result = await runTurn({
        messages: [...history, { role: "user", content: prompt }],
        provider,
        defaults,
        mcp: mcpForEmp,
        contextWindow: 300000,
        onEvent: () => {},
      });
      const assistantMsgs = result.messages.filter((m) => m.role === "assistant" && m.content);
      const output = [...assistantMsgs].reverse().find((m) => m.content)?.content ?? "";
      rms.recordMessage({ conversationId: task.conversation_id, role: "assistant", content: output, employeeId: empId });
      rms.recordUsageDb({ conversationId: task.conversation_id, employeeId: empId, provider: provider.id, model: provider.model, usage: null, promptChars: prompt.length, completionChars: output.length });
      history = [...history, { role: "user", content: prompt }, ...assistantMsgs];
      lastOutput = output;
    }
    rms.updateTask(taskId, { status: "done", resultSummary: String(lastOutput).slice(0, 1500) });
    log(SCOPE, `任务执行完成: ${taskId}`);
  } catch (error) {
    try { rms.updateTask(taskId, { status: "failed", error: String(error?.message ?? error).slice(0, 500) }); } catch {}
    throw error;
  } finally {
    runningTasks.delete(taskId);
  }
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    json(res, 400, { error: `请求体解析失败: ${error.message}` });
    return;
  }

  const requestedId = body.provider;
  const VF_GREETER = { id: "vf", protocol: "vf", label: "VF 模型 · 前台助手", model: "vf-greeter", baseUrl: "", apiKey: "", supportsTools: false, supportsStream: true };
  let provider;
  let defaults;
  try {
    if (requestedId === "vf") {
      provider = VF_GREETER;
      defaults = {};
    } else {
      const config = loadModelConfig();
      const chosen = requestedId != null ? config.providers[requestedId] : null;
      if (chosen == null) {
        const activeEntry = Object.values(config.providers ?? {})[0];
        if (activeEntry == null) {
          // 未配置任何模型 API：回退 VF 前台模型（只做接待引导）
          provider = VF_GREETER;
          defaults = config.defaults ?? {};
        } else {
          const fallback = activeProvider();
          provider = fallback.provider;
          defaults = fallback.defaults;
        }
      } else {
        provider = chosen;
        defaults = config.defaults;
      }
    }
  } catch (error) {
    json(res, 500, { error: error.message });
    return;
  }

  if ((provider.apiKey ?? "") === "" && provider.protocol === "openai-compatible") {
    warn(SCOPE, "模型未配置 API Key，请求仍会发出但大概率被拒绝", { provider: provider.id });
  }

  // 请求了不存在的供应商 → 明确报错（不静默回退，避免在不知情下用错模型）；内置 vf 前台不在 providers 表内，需放行
  if (typeof body.provider === "string" && body.provider.trim() !== "" && body.provider !== "vf" && loadModelConfig().providers?.[body.provider] == null) {
    json(res, 400, { error: `未知的模型供应商: ${body.provider}，可用: ${Object.keys(loadModelConfig().providers).join(", ")}` });
    return;
  }
  // ---- 监管采集上下文（AI 员工归属：员工用户 = 本人×所选模型 动态建档；主控 = 按模型供应商） ----
  const chatToken = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  const chatUser = chatToken ? auth.verifyToken(chatToken) : null;
  let employeeId;
  let identityPrompt = null;
  const empReq = typeof body.employee === "string" ? body.employee.trim() : "";
  if (chatUser?.role === "boss" && empReq === "emp_secretary") {
    // AI 秘书：主控专属，全系统只读工具（不可写、不可改代码）
    employeeId = "emp_secretary";
    identityPrompt = [
      "你是 AI 秘书，主控的系统管理员助理，拥有全系统只读权限，可回答系统自身运行状况与数据的任何问题。",
      "【铁律】系统数据只有一个可信来源：secretary__ 工具（db_schema 看表结构、db_query 只读 SQL、system_status 进程/用户/用量/MCP 状态、read_file/list_dir 读文件）。",
      "回答任何涉及系统的数字、表名、用户、状态、时间之前，必须先调用相应工具取得真实结果，再原样引用工具返回作答；",
      "没有调用工具就给出具体数据 = 编造 = 严重违规。不确定就先查，查不到就如实说“未查到”。",
      "你是只读角色：绝不修改任何系统数据与代码；工具本身也是物理只读的。",
    ].join(String.fromCharCode(10));
  } else if (chatUser != null && empReq !== "" && empReq !== "front_desk" && empReq !== "emp_secretary") {
    // 任何登录用户显式指定 AI 员工：归属校验 → 绑定校验 → 使用其绑定 API 与身份设定。
    // 此前只对 role==="employee" 生效，主控/观察员传 employee 会被静默忽略（项目共享会话"指定员工对话"也因此失效）
    if (!team.canUseEmployee(chatUser, empReq)) {
      json(res, 403, { error: "无权使用该 AI 员工（仅限本人或公共员工）" });
      return;
    }
    const empRow = team.getEmployeeById(empReq);
    if (empRow == null) {
      json(res, 400, { error: `该 AI 员工不存在（${empReq}），请刷新员工列表` });
      return;
    }
    employeeId = empReq;
    identityPrompt = empRow?.identity ?? null;
    if (empRow?.source_provider != null) {
      const bound = loadModelConfig().providers?.[empRow.source_provider];
      if (bound == null) {
        // 绑定的模型 API 已被移除：明确报错（绝不静默换模型——用户会以为还在用 A 员工的大脑）
        json(res, 400, { error: `该 AI 员工绑定的模型 API（${empRow.source_provider}）已被移除，请重新选择员工或联系管理员` });
        return;
      }
      provider = bound;
    }
  } else if (chatUser?.role === "employee") {
    // 每个员工 × 每个模型供应商 = 一名专属 AI 员工（首次使用自动建档，监管页按人按模型分账）
    employeeId = `emp_u_${chatUser.username}_${String(provider.id).replace(/[^A-Za-z0-9_-]/g, "")}`;
    rms.ensureEmployee({
      id: employeeId,
      name: `${chatUser.display_name ?? chatUser.username} · ${provider.label ?? provider.id}`,
      role: "模型员工",
      providerId: provider.id,
      model: provider.model,
    });
  } else if (chatUser?.role === "boss") {
    employeeId = rms.employeeIdForProvider(provider.id);
  } else {
    employeeId = rms.employeeIdForProvider(provider.id);
  }
  let convId;
  try {
    convId = rms.ensureConversation({
      conversationId: body.session,
      employeeId,
      // 标题去掉附件注入前缀（否则监管页/建议卡片会出现"[附件文件：nasdaq-n…"这种半截文件名）
      title: String((Array.isArray(body.messages) ? body.messages.find((m) => m.role === "user")?.content : "") ?? "").replace(/\[附件文件：[^\]]*\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "对话",
      ownerUserId: chatUser?.id ?? null,
    });
  } catch (error) {
    // 会话归属冲突（CodeX AUTH-01）：明确 403，让前端能识别并新建会话，而不是整条流 500
    json(res, 403, { error: String(error?.message ?? error) });
    return;
  }
  if (provider.id !== "vf" && provider.protocol !== "vf") {
    rms.ensureEmployee({ id: employeeId, providerId: provider.id, model: provider.model });
  }
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...incoming].reverse().find((m) => m.role === "user");
  const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
  const toolStart = new Map();
  const seenTodos = new Set();
  let assistantText = "";
  let reasoningText = "";
  let toolErrors = 0;
  let toolResultChars = 0; // 工具结果字符量：成本突增规则按"变动部分"计（排除系统提示静态底座）
  const toolCallLog = [];
  const retrievedSources = new Map(); // 本轮知识库引用（docId -> {docId,title,excerpt}）：SSE sources 事件 + Ragas retrieved_contexts 口径
  let roundsReachedLimit = false;

  const persistTodo = (eventName, data) => {
    const name = String(data?.name ?? "");
    if (!name.includes("todo_write")) return;
    const tasks = data?.arguments?.tasks;
    if (Array.isArray(tasks)) {
      rms.recordTodoSet({ conversationId: convId, tasks });
      seenTodos.add(String(data.id ?? name));
    }
  };

  // 风险扫描：抽成幂等函数，成功路径与异常/中止路径各调用一次（只扫一次）。
  // 修复：原先扫描只写在 try 的成功分支里 —— 模型报错、用户中止、看门狗超时这些
  // **最该留证**的场景（工具失败、异常终止）反而完全不产生风险事件，
  // 监管视图上表现为"失败回合没有任何风险记录"。
  let riskScanned = false;
  const runRiskScan = () => {
    if (riskScanned) return [];
    riskScanned = true;
    if (process.env.VFLETCH_RMS_SCAN === "off") return [];
    try {
      return rms.scanTurnRisks({
        conversationId: convId,
        employeeId,
        lastUserText: userText,
        assistantText: reasoningText !== "" ? `${reasoningText}\n${assistantText}` : assistantText,
        toolErrorCount: toolErrors,
        roundsReachedLimit,
        turnTokens,
        estimatedChars: completionChars + toolResultChars, // 成本口径=变动部分（输出+工具结果）
      });
    } catch (error) {
      warn(SCOPE, "风险扫描失败", { error: String(error?.message ?? error) });
      return [];
    }
  };

  // 并发自保闸：上游模型网关限 40 次/分钟，超出配额只会雪崩式 429——
  // 并发回合超限的请求立即友好拒绝，而不是让用户排队数分钟后报错（阈值可用环境变量调）
  const maxConcurrentTurns = Number(process.env.VFLETCH_MAX_CONCURRENT_TURNS ?? 10);
  if (activeTurns.size >= maxConcurrentTurns) {
    json(res, 429, { error: `当前使用人数较多（${activeTurns.size} 个任务进行中），请稍候几秒再发送` });
    return;
  }

  sseHeaders(res);
  const controller = new AbortController();
  activeTurns.set(convId, { controller, ownerId: chatUser?.id ?? null });
  // 5 分钟硬超时：无论什么原因（模型死循环、工具卡住），整回合不超过 300s
  const hardTimeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      try { controller.abort(new Error("回合超时（5分钟）")); } catch {}
    }
  }, 300_000);
  res.on("close", () => {
    clearTimeout(hardTimeout);
    controller.abort();
    activeTurns.delete(convId);
    // 回合连接断开：该会话尚未裁决的审批请求一并作废（连接都没了，批了也没人收结果）
    for (const [key, entry] of pendingConfirms) {
      if (key.startsWith(`${convId}:`)) {
        try { entry.resolve({ approved: false, note: "回合已终止" }); } catch {}
      }
    }
  });

  // 上下文窗口（用户可选 300k–1M；越界值收敛到边界）
  const contextWindow = clampContextWindow(body.contextWindow ?? defaults.contextWindowTokens);

  let usageEvent = null;
  let turnTokens = 0;
  let promptChars = 0;
  let completionChars = 0;
  for (const m of incoming) {
    promptChars += typeof m.content === "string" ? m.content.length : JSON.stringify(m.content ?? "").length;
  }

  // 沙盒：AI 秘书（主控专用）获得全量工具（含 secretary__ 系统只读工具）；
  // 其他会话剥离 secretary__ 工具；非主控会话再剥离 MCP 安装/卸载与任意代码执行工具——
  // 成员/观察员走"发现 + 提案"路径（mcp_discovery__mcp_search / mcp_propose），安装闸门在主控手里
  const mcpForTurn = toolViewFor(chatUser, employeeId);

  sseSend(res, "start", { provider: provider.id, model: provider.model, toolCount: mcpForTurn.tools.size, session: convId });

  try {
    const result = await runInContext(
      { userId: chatUser?.id ?? null, role: chatUser?.role ?? null, username: chatUser?.username ?? null, employeeId },
      () => runTurn({
      messages: incoming,
      provider,
      defaults,
      mcp: mcpForTurn,
      contextWindow,
      identity: identityPrompt,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "usage") {
          usageEvent = event.usage;
          // 单轮可能多回合调用模型，累计整轮 token 供成本突增规则判定
          turnTokens += Number(event.usage?.prompt_tokens ?? event.usage?.input_tokens ?? 0);
          turnTokens += Number(event.usage?.completion_tokens ?? event.usage?.output_tokens ?? 0);
        } else if (event.type === "delta") {
          assistantText += event.text;
          completionChars += event.text?.length ?? 0;
        } else if (event.type === "reasoning") {
          reasoningText += event.text;
        } else if (event.type === "tool_call") {
          toolStart.set(event.id, Date.now());
          persistTodo("tool_call", event);
        } else if (event.type === "tool_result") {
          const durationMs = toolStart.has(event.id) ? Date.now() - toolStart.get(event.id) : null;
          toolResultChars += String(event.text ?? "").length;
          // 知识库检索结果 → 结构化引用（审计可溯源 + Ragas retrieved_contexts）
          if (String(event.name ?? "").includes("kb_search")) {
            try {
              const parsed = JSON.parse(event.text ?? "{}");
              for (const src of parsed.sources ?? []) {
                if (src?.docId != null) retrievedSources.set(src.docId, { docId: src.docId, title: src.title, excerpt: src.excerpt ?? "" });
              }
            } catch {}
          }
          rms.recordToolCall({
            conversationId: convId,
            toolName: event.name,
            arguments: event.arguments,
            result: event.text,
            isError: event.isError,
            durationMs,
          });
          toolCallLog.push(String(event.name ?? ""));
          if (event.isError) toolErrors += 1;
          persistTodo("tool_result", event);
        }
        sseSend(res, event.type, event);
      },
      // P0-2 事中拦截：code__ 系工具执行前的人工审批（SSE 发审批卡，120s 未决视为拒绝）
      confirm: async (request) => {
        const confirmId = `${convId}:${request.id}`;
        sseSend(res, "confirm_request", { id: confirmId, tool: request.tool, arguments: request.arguments, timeoutMs: CONFIRM_TIMEOUT_MS });
        return await new Promise((resolve) => {
          let entry;
          const timer = setTimeout(() => {
            entry.resolve({ approved: false, note: `审批超时（${Math.round(CONFIRM_TIMEOUT_MS / 1000)} 秒未处理，视为拒绝）` });
          }, CONFIRM_TIMEOUT_MS);
          entry = {
            username: chatUser?.username ?? null,
            resolve: (verdict) => {
              clearTimeout(timer);
              pendingConfirms.delete(confirmId);
              sseSend(res, "confirm_result", { id: confirmId, approved: !!verdict?.approved, note: verdict?.note ?? null });
              resolve(verdict);
            },
          };
          pendingConfirms.set(confirmId, entry);
        });
      },
      }) );
    // 修复：原判据 `finishReason === "length"` 与 OpenAI 兼容端点的"输出 token 上限截断"同值，
    // 一次正常的长回答截断就会被记成「长时间执行/疑似死循环」风险事件。改用引擎显式上报的语义位。
    roundsReachedLimit = result.roundsReachedLimit === true;

    // 落库：本轮新增的用户消息 + 最终助手回复（含思考过程）
    if (userText !== "") rms.recordMessage({ conversationId: convId, role: "user", content: userText });
    if (assistantText.trim() !== "" || reasoningText.trim() !== "") {
      rms.recordMessage({
        conversationId: convId,
        role: "assistant",
        content: assistantText.trim() === "" ? null : assistantText,
        reasoning: reasoningText.trim() === "" ? null : reasoningText,
      });
    }
    // 留痕上报（可选的跨实例使用留痕回传；未配置即静默跳过）
    reportEvent({
      kind: "turn",
      subject: employeeId ?? "local",
      summary: `用户：${String(userText).slice(0, 80)} → AI：${String(assistantText).slice(0, 120)}`,
      detail: JSON.stringify({ tools: (toolCallLog || []).slice(0, 10), rounds: result.rounds }),
    });
    if (usageEvent != null || completionChars > 0) {
      rms.recordUsageDb({ conversationId: convId, provider: provider.id, model: provider.model, usage: usageEvent, promptChars, completionChars });
    }
    // 风险扫描（工具失败 / 轮次打满 / 不可逆动作表述 / 敏感词 / 成本阈值）
    // 对照实验基线开关：VFLETCH_RMS_SCAN=off 时跳过扫描（用于"基线 vs 开启 RMS"对照实验）
    const riskEvents = runRiskScan();
    if (riskEvents.length > 0) sseSend(res, "risk_event", { events: riskEvents });
    // 引用来源：本轮回答依据的知识库文档（审计溯源 + Ragas retrieved_contexts）
    if (retrievedSources.size > 0) sseSend(res, "sources", { sources: [...retrievedSources.values()] });
    rms.closeConversation(convId, { markClosed: false });

    activeTurns.delete(convId);
    clearTimeout(hardTimeout);
    sseSend(res, "done", { finishReason: result.finishReason, rounds: result.rounds, session: convId, messages: result.messages });
    // 用量落库（不阻塞响应）：真实 usage 优先，缺失时按字符数估算
    try {
      const rec = recordUsage({
        provider: provider.id,
        model: provider.model,
        usage: usageEvent,
        promptChars,
        completionChars,
      });
      sseSend(res, "usage_recorded", rec);
    } catch (e) {
      warn(SCOPE, "用量记录失败", { error: String(e?.message ?? e) });
    }
  } catch (error) {
    // 失败/中止路径同样留证：补扫本轮风险（工具失败、轮次打满、不可逆表述等）
    try {
      const lateRisks = runRiskScan();
      if (lateRisks.length > 0) sseSend(res, "risk_event", { events: lateRisks });
    } catch {}
    sseSend(res, "error", { message: String(error?.message ?? error) });
  }
  res.end();
}

function parseEditRequest(row) {
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch { payload = { raw: row.payload }; }
  return { ...row, payload, key: payload?.key ?? null, action: payload?.action ?? "update", index: payload?.index ?? null, reason: payload?._reason ?? null };
}

// ---- 审计记录归属判定（分权）：本人 = 记录里的人员字段等于用户名/显示名；本部门 = 记录部门字段等于用户部门 ----
const AUDIT_PERSON_FIELDS = ["createdBy", "creator", "operator", "employeeName", "assignee", "responsiblePerson", "recruiter", "uploadedBy", "approver", "candidateName", "username", "employeeId", "userId"];
const AUDIT_DEPT_FIELDS = ["department", "fromDepartment", "toDepartment"];
function auditRecordScope(body, user) {
  const key = String(body?.key ?? "");
  const data = loadAuditData();
  const target = data[key];
  const me = new Set([user.username, user.display_name].filter(Boolean).map((v) => String(v).trim().toLowerCase()));
  const myDept = String(user.department ?? "").trim().toLowerCase();
  const matchRecord = (rec) => {
    if (rec == null || typeof rec !== "object") return { own: false, reason: "记录不存在" };
    for (const f of AUDIT_PERSON_FIELDS) {
      const v = rec[f];
      if (v != null && me.has(String(v).trim().toLowerCase())) return { own: true, reason: `本人（${f}）` };
    }
    if (myDept !== "") {
      for (const f of AUDIT_DEPT_FIELDS) {
        const v = rec[f];
        if (v != null && String(v).trim().toLowerCase() === myDept) return { own: true, reason: `本部门（${f}）` };
      }
    }
    return { own: false, reason: myDept === "" ? "你尚未被分配部门，且记录不属于你本人" : "非本人且非本部门记录" };
  };
  if (Array.isArray(target)) {
    if (body.action === "add") {
      if (body.record == null || typeof body.record !== "object") throw new Error("新增记录格式错误");
      // 新增：记录写的是本人/本部门才可直接加
      return matchRecord(body.record);
    }
    const i = Number(body.index);
    if (!Number.isInteger(i) || i < 0 || i >= target.length) throw new Error(`行号越界：${body.index}`);
    return matchRecord(target[i]);
  }
  if (target != null && typeof target === "object") return { own: false, reason: "全局指标/配置需主控审批" };
  throw new Error(`实体不存在：${key}`);
}

// ---- 登录 IP 与归属地 ----
// 修复 SEC-07 旁路：X-Forwarded-For 是**客户端可伪造**的请求头，原实现无条件信任它。
// 攻击者每次换一个 XFF 值即可完全绕过「用户名+IP」锁定与「单 IP 失败总量」限流，
// 还能反过来伪造受害者 IP 去锁死对方账号（并污染 auth_sessions.login_ip 审计字段）。
// 修复（第二轮）：即使对端确实是本机/内网反代，也不能取链首值 —— 反代普遍以 append 方式
// 追加真实来源（nginx `$proxy_add_x_forwarded_for`），链首永远是客户端自己写进去的，
// 取链首等于把限流键与审计 IP 全部交给攻击者。必须取**链尾最后一个合法 IP**（最近一跳看到的地址）。
// VFLETCH_TRUST_PROXY=0 可彻底关闭 XFF 采信（服务直接对外暴露时应当这样配）。
const TRUSTED_PROXY_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i;
function getClientIp(req) {
  const peer = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/i, "");
  const trustSetting = process.env.VFLETCH_TRUST_PROXY;
  const trustProxy = trustSetting === "0"
    ? false
    : trustSetting === "1" || TRUSTED_PROXY_RE.test(peer);
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.trim() !== "") {
      const chain = fwd.split(",").map((s) => s.trim().replace(/^::ffff:/i, "")).filter((s) => s !== "");
      for (let i = chain.length - 1; i >= 0; i -= 1) {
        if (net.isIP(chain[i]) !== 0) return chain[i];
      }
    }
  }
  return peer !== "" ? peer : "127.0.0.1";
}

// ip-api.com 免费归属地查询（无需密钥，45次/分钟；失败返回"未知"）
// 默认关闭：本地单机运行不应有任何隐藏的外网调用。需要登录 IP 归属地时设 VFLETCH_IP_GEO=1 启用。
const IP_GEO_ENABLED = process.env.VFLETCH_IP_GEO === "1";
const ipRegionCache = new Map();
async function lookupIpRegion(ip) {
  if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") return "本机";
  if (!IP_GEO_ENABLED) return "未知";
  if (ipRegionCache.has(ip)) return ipRegionCache.get(ip);
  // 局域网私有地址：查公网出口IP的归属地（同一路由器下的用户共享公网位置）
  const isPrivate = /^10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\./.test(ip);
  const lookupIp = isPrivate ? await getPublicIp() : ip;
  if (lookupIp == null) return isPrivate ? "局域网" : "未知";
  try {
    const r = await fetch(`http://ip-api.com/json/${lookupIp}?fields=status,country,regionName,city,isp&lang=zh-CN`, {
      signal: AbortSignal.timeout(5000),
    });
    const d = await r.json();
    if (d?.status === "success") {
      const region = [d.country, d.regionName, d.city].filter(Boolean).join(" · ") + (isPrivate ? `（内网出口）` : "");
      ipRegionCache.set(ip, region);
      return region;
    }
  } catch {}
  return isPrivate ? "局域网" : "未知";
}

// 公网出口IP（缓存 10 分钟，避免频繁外查）
let publicIpCache = { ip: null, at: 0 };
async function getPublicIp() {
  if (publicIpCache.ip != null && Date.now() - publicIpCache.at < 600_000) return publicIpCache.ip;
  try {
    const r = await fetch("http://ip-api.com/json/?fields=query", { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    if (d?.query) {
      publicIpCache = { ip: d.query, at: Date.now() };
      return d.query;
    }
  } catch {}
  return null;
}

function await_import_db() {
  // 延迟引用避免顶层 import 环
  let mod = globalThis.__vfDbHelpers;
  if (mod == null) {
    // eslint-disable-next-line no-require
    mod = { run: (...a) => dbRunProxy(...a) };
  }
  return mod;
}
let dbRunProxy = null;
let allRows = null;

// ---- 会话级取消：stop 键发 POST /api/chat/cancel 即时中止服务端回合 ----
const activeTurns = new Map(); // session -> { controller, ownerId }（记录归属，取消时必须校验，防 IDOR）
const pendingConfirms = new Map(); // confirmId -> { resolve, username }（P0-2 事中拦截：等待人工裁决的 code_run 调用）

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-headers": "*", "access-control-allow-methods": "*" });
    res.end();
    return;
  }

  // ---------- 账号系统：认证守卫 ----------
  // 公开：登录、健康检查、版本信息；其余 /api/* 需 Bearer 会话令牌
  // /api/ingest 例外：可选的跨实例留痕上报通道，只凭 VFLETCH_REPORT_KEY 鉴权（无用户令牌），
  // 若被登录守卫拦截，上报会被 401 静默丢弃
  // 本地单机模式：无许可证/授权校验接口。PUBLIC_API 仅保留登录与健康/版本，其余需会话令牌。
  const PUBLIC_API = new Set(["/api/auth/login", "/api/health", "/api/meta", "/api/ingest"]); // /api/models 需登录，不泄露模型拓扑
  const BOSS_ONLY_PREFIX = ["/api/admin", "/api/rms", "/api/settings", "/api/mcp", "/api/usage"];
  // 修复 SEC-01：原实现只拦 employee，observer 可穿透全部"主控专属"接口
  // （曾实测可建 boss 账号并登录、直调 code_run 执行任意代码、读全库密码哈希）。
  // 改为默认拒绝 + 观察员显式白名单。观察员在本系统中是"管理层/监管协作者"角色：
  // 可读名单与设置、可维护模型 API、可处置风险事件；但不得变更账号、关服、改激活模型、
  // 改 MCP 配置（=任意包执行）。白名单边界与 dev/apitest.mjs、dev/t-employee.mjs 的既有断言一致。
  const OBSERVER_ALLOWED = [
    { method: "GET", prefix: "/api/rms/" },              // 监管视图只读
    { method: "GET", prefix: "/api/usage" },             // 用量只读
    { method: "GET", prefix: "/api/mcp/list" },          // 工具清单只读
    { method: "POST", prefix: "/api/rms/events/" },      // 风险事件处置
    { method: "GET", prefix: "/api/admin/users" },       // 账号名单只读（IP/归属地已对非主控脱敏）
    { method: "GET", prefix: "/api/settings" },          // 设置只读
    { method: "POST", prefix: "/api/settings/provider" }, // 管理层：维护模型 API（含 provider-delete）
    // 直调通道放行给观察员，但**工具集由 toolViewFor 过滤**：仅可调用未被剥离的工具
    // （mcp_discovery__* 发现与提案、kb/audit/web 等业务工具），
    // code__ / secretary__ / mcp_admin__install 仍不可达（见 handle 内二次校验）。
    { method: "POST", prefix: "/api/mcp/call" },
  ];
  let currentUser = null;
  if (pathname.startsWith("/api/") && !PUBLIC_API.has(pathname)) {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    currentUser = token ? auth.verifyToken(token) : null;
    if (currentUser == null) {
      json(res, 401, { error: "未登录或会话已过期，请重新登录" });
      return;
    }
    if (BOSS_ONLY_PREFIX.some((p) => pathname.startsWith(p))) {
      const isBoss = currentUser.role === "boss";
      const observerOk = currentUser.role === "observer"
        && OBSERVER_ALLOWED.some((r) => req.method === r.method && pathname.startsWith(r.prefix));
      if (!isBoss && !observerOk) {
        json(res, 403, { error: "该操作仅限主控账号" });
        return;
      }
    }
  }

  try {
    if (pathname === "/api/auth/login" && req.method === "POST") {
      const body = await readJsonBody(req);
      const clientIp = getClientIp(req);
      try {
        const result = auth.login({ username: body.username, password: body.password, clientIp });
        // 异步查询归属地（不阻塞登录）
        lookupIpRegion(clientIp).then((region) => {
          try {
            const { run } = await_import_db();
            run("UPDATE auth_sessions SET login_ip = ?, ip_region = ? WHERE token = ?", clientIp, region, result.token);
          } catch {}
        });
        json(res, 200, { ...result, loginIp: clientIp });
      } catch (error) {
        json(res, 401, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      auth.logout(String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim());
      json(res, 200, { ok: true });
      return;
    }
    if (pathname === "/api/auth/me" && req.method === "GET") {
      if (currentUser == null) { json(res, 401, { error: "未登录" }); return; }
      json(res, 200, { user: currentUser });
      return;
    }
    if (pathname === "/api/meta" && req.method === "GET") {
      json(res, 200, { app: "v-fletch", version: APP_VERSION, auth: "enabled", startedAt: STARTED_AT, toolCount: mcp.tools.size });
      return;
    }

    // ---------- 主控：账号管理 ----------
    if (pathname === "/api/admin/users" && req.method === "GET") {
      // 附加最近登录 IP 与归属地
      const isBossReq = currentUser?.role === "boss";
      const users = auth.listUsers().map((u) => {
        const sess = isBossReq ? (() => {
          try { return allRows("SELECT login_ip, ip_region, last_seen FROM auth_sessions WHERE user_id = ? ORDER BY last_seen DESC LIMIT 1", u.id); } catch { return []; }
        })() : [];
        const s = sess[0] ?? {};
        const row = { ...u, lastLoginIp: s.login_ip ?? null, lastIpRegion: s.ip_region ?? null, lastSeen: s.last_seen ?? null };
        if (!isBossReq) {
          // 观察员是监管协作者而非系统管理员：不下发任何 IP/归属地（测试报告 P0 越权收敛）
          delete row.lastLoginIp;
          delete row.lastIpRegion;
        }
        return row;
      });
      json(res, 200, users);
      return;
    }
    if (pathname === "/api/admin/users" && req.method === "POST") {
      // 修复 SEC-01（纵深防御）：账号创建仅限主控，且不允许直接创建 boss（需主控显式两步）
      if (currentUser?.role !== "boss") { json(res, 403, { error: "该操作仅限主控账号" }); return; }
      const body = await readJsonBody(req);
      try {
        json(res, 200, auth.createUser(body ?? {}));
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    const adminSeg = pathname.split("/").filter(Boolean); // ["api","admin","users",id,action]
    // 移除账号：DELETE /api/admin/users/:id —— 仅限主控（管理员/观察员一律拒绝）；主控自身由 auth.deleteUser 拒绝
    if (adminSeg[1] === "admin" && adminSeg[2] === "users" && adminSeg.length === 4 && req.method === "DELETE") {
      if (currentUser?.role !== "boss") {
        json(res, 403, { error: "该操作仅限主控账号" });
        return;
      }
      const targetId = decodeURIComponent(adminSeg[3]);
      try {
        const result = auth.deleteUser(targetId);
        log(SCOPE, `账号已移除: ${result.removed?.username} (${targetId})，清理 会话=${result.cleaned.sessions} AI身份=${result.cleaned.employees} 团队引用=${result.cleaned.teams}`);
        json(res, 200, result);
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (adminSeg[1] === "admin" && adminSeg[2] === "users" && adminSeg.length === 5 && req.method === "POST") {
      // 修复 SEC-01（纵深防御）：角色/密码/状态/部门变更仅限主控
      if (currentUser?.role !== "boss") { json(res, 403, { error: "该操作仅限主控账号" }); return; }
      const body = await readJsonBody(req);
      const [ , , , targetId, action] = adminSeg;
      try {
        if (action === "status") json(res, 200, auth.setUserStatus(targetId, body?.status));
        else if (action === "password") json(res, 200, auth.resetPassword(targetId, body?.password));
        else if (action === "role") json(res, 200, auth.setUserRole(targetId, body?.role));
        else if (action === "department") json(res, 200, auth.setUserDepartment(targetId, body?.department));
        else json(res, 404, { error: "未知账号操作" });
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }

    if (pathname === "/api/health") {
      json(res, 200, { ok: true, mcpStartedAt: mcp.startedAt, toolCount: mcp.tools.size });
      return;
    }
    if (pathname === "/api/models" && req.method === "GET") {
      const data = redactedProviders();
      // 前端选择器按【数组】消费（选择器扁平化，见 ChatView/ModelPicker）；
      // 恒在数组最前面附加 VF 内置前台模型（非 AI 员工，仅接待引导）。
      // 2026-09-10 修复：此前误返回对象（asMap），前端 providers.some 报"不是函数"→ 登录后整页白屏。
      const list = Array.isArray(data.providers) ? data.providers : Object.values(data.providers ?? {});
      const withVf = {
        ...data,
        active: data.active ?? "vf",
        providers: [
          { id: "vf", label: "VF 模型 · 前台助手", model: "vf-greeter", protocol: "vf", supportsTools: false, supportsStream: true, apiKeyRef: null, hasApiKey: true, notes: "内置接待问答；正式能力请添加模型 API" },
          ...list,
        ],
      };
      json(res, 200, withVf);
      return;
    }
    // ---- MCP 安装提案（发现→审批→安装 的人工闸门） ----
    if (pathname === "/api/mcp/proposals" && req.method === "GET") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "仅主控账号可查看安装提案" }); return; }
      try {
        const { all: pAll } = await import("./lib/db.mjs");
        const pending = pAll("SELECT id, catalog_id, spec, reason, requested_by, role, created_at FROM mcp_proposals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 50");
        json(res, 200, { proposals: pending.map((r) => ({ ...r, spec: JSON.parse(r.spec ?? "{}") })) });
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) });
      }
      return;
    }
    const proposalSeg = pathname.split("/").filter(Boolean);
    if (proposalSeg[1] === "mcp" && proposalSeg[2] === "proposals" && proposalSeg.length === 5 && (proposalSeg[4] === "approve" || proposalSeg[4] === "reject") && req.method === "POST") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "仅主控账号可审批安装提案" }); return; }
      try {
        const { get: pGet, run: pRun } = await import("./lib/db.mjs");
        const row = pGet("SELECT * FROM mcp_proposals WHERE id = ? AND status = 'pending'", decodeURIComponent(proposalSeg[3]));
        if (row == null) { json(res, 404, { error: "提案不存在或已处理" }); return; }
        if (proposalSeg[4] === "reject") {
          pRun("UPDATE mcp_proposals SET status = 'rejected', decided_at = datetime('now','localtime') WHERE id = ?", row.id);
          log(SCOPE, `MCP 安装提案已驳回: ${row.catalog_id}（${row.requested_by}）`);
          json(res, 200, { ok: true, status: "rejected" });
          return;
        }
        // 批准：按目录规格安装（沿用现有安装校验与回滚）。
        // 需密钥的条目（draft=true）安装为停用草稿：主控在 MCP 页补齐环境变量后再启用。
        const spec = JSON.parse(row.spec ?? "{}");
        const outcome = await mcp.installServer(spec);
        pRun("UPDATE mcp_proposals SET status = 'approved', decided_at = datetime('now','localtime') WHERE id = ?", row.id);
        log(SCOPE, outcome?.draft
          ? `MCP 安装提案已批准（停用草稿，待补密钥）: ${row.catalog_id}（申请人 ${row.requested_by}）`
          : `MCP 安装提案已批准并安装: ${row.catalog_id}（申请人 ${row.requested_by}）`);
        json(res, 200, { ok: true, status: "approved", draft: outcome?.draft === true, snapshot: outcome.snapshot });
      } catch (error) {
        try {
          const { run: pRun } = await import("./lib/db.mjs");
          pRun("UPDATE mcp_proposals SET status = 'failed', install_error = ? WHERE id = ?", String(error?.message ?? error).slice(0, 300), decodeURIComponent(proposalSeg[3]));
        } catch {}
        json(res, 400, { error: `安装失败: ${String(error?.message ?? error)}` });
      }
      return;
    }
    if (pathname === "/api/mcp/list" && req.method === "GET") {
      json(res, 200, mcp.snapshot());
      return;
    }
    // 单个 server 的安装定义（主控「补密钥并启用」停用草稿用）；env 值非 "env:VAR" 引用的一律不回传
    if (pathname === "/api/mcp/definition" && req.method === "GET") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "该操作仅限主控账号" }); return; }
      const defId = new URL(req.url, "http://localhost").searchParams.get("id") ?? "";
      const { getMcpServerDefinition } = await import("./lib/settings.mjs");
      const def = getMcpServerDefinition(defId);
      if (def == null) { json(res, 404, { error: `未找到 server: ${defId}` }); return; }
      const env = {};
      for (const [k, v] of Object.entries(def.env ?? {})) env[k] = String(v).startsWith("env:") ? v : "";
      // env 与 headers 同口径脱敏：env 原本已处理，但远端 server 的 headers
      // （Authorization: Bearer sk-…）被原样下发到浏览器，等于把远端凭据明文回传前端。
      const headers = {};
      for (const [k, v] of Object.entries(def.headers ?? {})) headers[k] = String(v).startsWith("env:") ? v : "";
      json(res, 200, { ...def, env, headers });
      return;
    }
    if (pathname === "/api/mcp/reload" && req.method === "POST") {
      json(res, 200, await mcp.start());
      return;
    }
    // MCP 中心：动态添加 / 移除 server（仅主控账号）
    if (pathname === "/api/mcp/install" && req.method === "POST") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "添加 MCP Server 仅限主控账号" }); return; }
      const body = await readJsonBody(req);
      try {
        const result = await mcp.installServer(body ?? {});
        json(res, 200, { ok: true, snapshot: result.snapshot });
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/mcp/uninstall" && req.method === "POST") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "移除 MCP Server 仅限主控账号" }); return; }
      const body = await readJsonBody(req);
      try {
        const result = await mcp.uninstallServer(String(body?.id ?? ""));
        json(res, 200, { ok: true, snapshot: result.snapshot });
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/mcp/call" && req.method === "POST") {
      const body = await readJsonBody(req);
      // 修复 SEC-02：直调接口必须与聊天通道共用同一套工具过滤，否则会绕过聊天沙箱
      const view = toolViewFor(currentUser);
      if (!view.tools.has(String(body.name ?? ""))) {
        json(res, 403, { error: `工具 ${String(body.name ?? "")} 对当前角色不可用` });
        return;
      }
      // 注入调用身份：MCP 提案类工具需要记录"谁在请求"（run-context 供工具 handler 读取）
      const result = await runInContext(
        { userId: currentUser?.id ?? null, role: currentUser?.role ?? null, username: currentUser?.username ?? null, displayName: currentUser?.display_name ?? null },
        () => mcp.callTool(body.name, body.arguments ?? {}),
      );
      json(res, 200, { name: body.name, ...result });
      return;
    }
    if (pathname === "/api/mcp/probe" && req.method === "POST") {
      const body = await readJsonBody(req);
      json(res, 200, await probeRemoteMcp(body ?? {}));
      return;
    }

    // ---------- 监管风控中心（RMS / SQLite） ----------
    const seg = pathname.split("/").filter(Boolean); // ["api","rms",...]
    if (seg[1] === "rms" && seg.length === 2 && seg[0] === "api") {
      json(res, 400, { error: "缺少 RMS 资源" });
      return;
    }
    if (seg[0] === "api" && seg[1] === "rms" && req.method === "GET") {
      const query = url.searchParams;
      if (seg[2] === "overview") { json(res, 200, rms.rmsOverview()); return; }
      if (seg[2] === "events") {
        json(res, 200, rms.listRiskEvents({ status: query.get("status") ?? "all", level: query.get("level") ?? "all", limit: Number(query.get("limit")) || 50 }));
        return;
      }
      if (seg[2] === "activity") {
        json(res, 200, rms.listActivity({ limit: Number(query.get("limit")) || 30, type: query.get("type") ?? undefined }));
        return;
      }
      if (seg[2] === "employees") { json(res, 200, rms.listEmployees()); return; }
      if (seg[2] === "todos") {
        json(res, 200, rms.listTodos({ status: query.get("status") ?? "all", limit: Number(query.get("limit")) || 50, conversationId: query.get("conversation") ?? undefined }));
        return;
      }
      if (seg[2] === "conversations" && seg.length === 3) {
        json(res, 200, rms.listConversations({ limit: Number(query.get("limit")) || 30, status: query.get("status") ?? "all" }));
        return;
      }
      if (seg[2] === "conversations" && seg.length === 4) {
        const detail = rms.conversationDetail(decodeURIComponent(seg[3]));
        if (detail == null) { json(res, 404, { error: "会话不存在" }); return; }
        json(res, 200, detail);
        return;
      }
      if (seg[2] === "rules" && seg.length === 3) { json(res, 200, rms.listRules()); return; }
      if (seg[2] === "tasks" && seg.length === 3) {
        json(res, 200, rms.listTasks({ status: query.get("status") ?? "all", limit: Number(query.get("limit")) || 50 }));
        return;
      }
      if (seg[2] === "tasks" && seg.length === 4) {
        const detail = rms.taskDetail(decodeURIComponent(seg[3]));
        if (detail == null) { json(res, 404, { error: "任务不存在" }); return; }
        json(res, 200, detail);
        return;
      }
      json(res, 404, { error: "未知 RMS 查询" });
      return;
    }
    if (seg[0] === "api" && seg[1] === "rms" && req.method === "POST") {
      if (seg[2] === "tasks" && seg.length === 3) {
        const body = await readJsonBody(req);
        try {
          // 部门派活展开："team:<id>" → 部门成员接力（上限 4 棒）
          const assignees = team.expandAssignees(Array.isArray(body?.assignees) ? body.assignees : []);
          json(res, 200, rms.createTask({ title: body?.title, detail: body?.detail, assignees, createdBy: currentUser?.id }));
        } catch (error) {
          json(res, 400, { error: String(error?.message ?? error) });
        }
        return;
      }
      if (seg[2] === "tasks" && seg.length === 5 && seg[4] === "run") {
        const task = rms.taskDetail(decodeURIComponent(seg[3]));
        if (task == null) { json(res, 404, { error: "任务不存在" }); return; }
        if (task.status === "running") { json(res, 409, { error: "任务正在执行中" }); return; }
        executeTask(task.id).catch((error) => warn(SCOPE, "任务执行失败", { error: String(error?.message ?? error) }));
        json(res, 200, { ok: true, status: "running", id: task.id });
        return;
      }
      if (seg[2] === "rules" && seg.length === 3) {
        const body = await readJsonBody(req);
        try {
          json(res, 200, rms.createRule(body ?? {}));
        } catch (error) {
          json(res, 400, { error: String(error?.message ?? error) });
        }
        return;
      }
      if (seg[2] === "rules" && seg.length === 4) {
        const body = await readJsonBody(req);
        try {
          json(res, 200, rms.updateRule(decodeURIComponent(seg[3]), body ?? {}));
        } catch (error) {
          json(res, 400, { error: String(error?.message ?? error) });
        }
        return;
      }
      if (seg[2] === "events" && seg[4] === "resolve" && seg.length === 5) {
        try {
          json(res, 200, rms.resolveRiskEvent(decodeURIComponent(seg[3])));
        } catch (error) {
          // 修复：此处原先没有 try/catch，resolveRiskEvent 对不存在的 id 抛错会一路冒泡成 500。
          // 事件不存在/已被删除应当是明确的 404（前端处置卡点空、重复点击都会命中）。
          json(res, 404, { error: String(error?.message ?? error) });
        }
        return;
      }
      if (seg[2] === "employees" && seg[4] === "status" && seg.length === 5) {
        const body = await readJsonBody(req);
        try {
          json(res, 200, rms.setEmployeeStatus(decodeURIComponent(seg[3]), body?.status));
        } catch (error) {
          json(res, 400, { error: String(error?.message ?? error) });
        }
        return;
      }
      json(res, 404, { error: "未知 RMS 操作" });
      return;
    }
    if (seg[0] === "api" && seg[1] === "rms" && req.method === "DELETE") {
      if (seg[2] === "tasks" && seg.length === 4) {
        const taskId = decodeURIComponent(seg[3]);
        const task = rms.taskDetail(taskId);
        if (task == null) { json(res, 404, { error: "任务不存在" }); return; }
        const isStaffReq = currentUser?.role === "boss" || currentUser?.role === "observer";
        if (!isStaffReq && task.created_by !== currentUser?.id) {
          json(res, 403, { error: "仅主控/管理员或任务创建人可删除" });
          return;
        }
        try {
          json(res, 200, rms.deleteTask(taskId));
        } catch (error) {
          json(res, 400, { error: String(error?.message ?? error) });
        }
        return;
      }
      if (seg[2] === "rules" && seg.length === 4) {
        try {
          json(res, 200, rms.deleteRule(decodeURIComponent(seg[3])));
        } catch (error) {
          json(res, 400, { error: String(error?.message ?? error) });
        }
        return;
      }
      json(res, 404, { error: "未知 RMS 删除操作" });
      return;
    }

    // ---------- 员工辅助：一键优化提示词（用当前模型改写为结构化提示词） ----------
    if (pathname === "/api/prompt-polish" && req.method === "POST") {
      const body = await readJsonBody(req);
      const raw = String(body?.text ?? "").trim();
      if (raw === "") { json(res, 400, { error: "输入为空" }); return; }
      if (raw.length > 2000) { json(res, 400, { error: "输入过长（>2000 字）" }); return; }
      try {
        const provider = activeProvider().provider;
        const client = await createModelClient(provider);
        let polished = "";
        for await (const event of client.stream({
          messages: [
            { role: "system", content: "你是提示词优化器。把用户的简短、口语化输入改写为一条高质量的结构化任务提示词：明确目标、必要背景、执行要求（分步骤）、期望输出格式。保持原意，不添加用户没提的新要求，不编造背景。直接输出改写后的提示词本身，不要任何解释、前缀或代码块包裹。" },
            { role: "user", content: raw },
          ],
          temperature: 0.3,
          maxOutputTokens: 800,
        })) {
          if (event.type === "delta") polished += event.text;
        }
        json(res, 200, { polished: polished.trim(), model: provider.label ?? provider.id });
      } catch (error) {
        json(res, 500, { error: `提示词优化失败: ${String(error?.message ?? error)}` });
      }
      return;
    }

    // ---------- 员工辅助：图片生成（直达内置 image_generate，结果以 Markdown 图片返回） ----------
    if (pathname === "/api/image" && req.method === "POST") {
      const body = await readJsonBody(req);
      const prompt = String(body?.prompt ?? "").trim();
      if (prompt === "") { json(res, 400, { error: "请填写画面描述" }); return; }
      try {
        const result = await mcp.callTool("media__image_generate", { prompt, size: body?.size, count: Math.max(1, Math.min(Number(body?.count) || 1, 4)) });
        if (result.isError) { json(res, 200, { ok: false, text: result.text, error: result.text }); return; }
        let parsed = null;
        try { parsed = JSON.parse(result.text); } catch {}
        const files = Array.isArray(parsed?.files) ? parsed.files : [];
        const markdown = files.map((f, i) => `![生成图片${files.length > 1 ? ` ${i + 1}` : ""}](${f.path})`).join(String.fromCharCode(10, 10));
        json(res, 200, { ok: files.length > 0, text: markdown || result.text, files, via: parsed?.via ?? null, model: parsed?.model ?? null });
      } catch (error) {
        json(res, 400, { error: `图片生成失败: ${String(error?.message ?? error)}` });
      }
      return;
    }

    // ---------- 审计风控（数据与内置 MCP 工具同源，全量返回） ----------
    if (pathname === "/api/audit/overview" && req.method === "GET") {
      const data = loadAuditData();
      json(res, 200, {
        ...data,
        _modules: Object.entries(AUDIT_MODULES).map(([id, m]) => ({ id, label: m.label, keys: m.keys })),
      });
      return;
    }

    // ---------- 审计库在线编辑（分权） ----------
    // 主控：直接生效。其他人（管理员/成员）：只能直接改"本人"或"本部门"的记录；
    // 其余记录（他人/他部门/无归属的全局指标与规则）→ 进入待审批队列，向主控申请，批准后生效。
    if (pathname === "/api/audit/record" && req.method === "PUT") {
      if (currentUser == null) { json(res, 401, { error: "未登录" }); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const applyNow = () => {
        const result = saveAuditRecord(body ?? {});
        log(SCOPE, `审计库编辑: ${currentUser.username} ${result.action} ${result.key}${body.index != null ? `[${body.index}]` : ""}`);
        json(res, 200, { ...result, applied: true });
      };
      const queue = (reason) => {
        const { run: reqRun } = await_import_db();
        // 入队时记下该行的稳定 id：审批期间若有其它增删改动行号，批准时按 id 重新定位（见 saveAuditRecord）
        let recordId = null;
        try {
          const rec = loadAuditData()?.[String(body?.key ?? "")]?.[Number(body?.index)];
          if (rec != null && typeof rec === "object" && rec.id != null) recordId = String(rec.id);
        } catch {}
        reqRun(
          "INSERT INTO audit_edit_requests (payload, requested_by) VALUES (?,?)",
          JSON.stringify({ ...(body ?? {}), _reason: reason, ...(recordId != null ? { _recordId: recordId } : {}) }),
          currentUser.username,
        );
        log(SCOPE, `审计修改申请: ${currentUser.username}（${reason}）→ 待主控审批`);
        json(res, 200, { ok: true, pending: true, message: `该记录不属于你或你的部门（${reason}），已提交主控审批，批准后生效` });
      };
      try {
        if (currentUser.role === "boss") { applyNow(); return; }
        // 修复：删除留痕属高危不可逆动作（合规场景下等于销毁证据），非主控一律走审批，
        // 不因"是本人/本部门记录"就即时生效；更新仍保留原有分权快车道以免影响日常协作。
        if (String(body?.action ?? "update") === "delete") { queue("删除留痕需主控审批"); return; }
        const scope = auditRecordScope(body ?? {}, currentUser);
        if (scope.own) applyNow();
        else queue(scope.reason);
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/audit/edits" && req.method === "GET") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "仅主控账号可审批" }); return; }
      const { all: edAll } = await import("./lib/db.mjs");
      json(res, 200, { requests: edAll("SELECT id, payload, requested_by AS requestedBy, status, created_at AS createdAt FROM audit_edit_requests WHERE status = 'pending' ORDER BY id DESC LIMIT 50").map(parseEditRequest) });
      return;
    }
    // 申请人视角：自己的申请（含已批准/已驳回，最近 30 条）
    if (pathname === "/api/audit/edits/mine" && req.method === "GET") {
      const { all: edAll } = await import("./lib/db.mjs");
      json(res, 200, { requests: edAll("SELECT id, payload, requested_by AS requestedBy, status, created_at AS createdAt, decided_at AS decidedAt FROM audit_edit_requests WHERE requested_by = ? ORDER BY id DESC LIMIT 30", currentUser.username).map(parseEditRequest) });
      return;
    }
    if (pathname === "/api/audit/edits/apply" && req.method === "POST") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "仅主控账号可审批" }); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      try {
        const { get: edGet, run: edRun } = await import("./lib/db.mjs");
        const pendingReq = edGet("SELECT * FROM audit_edit_requests WHERE id = ? AND status = 'pending'", Number(body?.id));
        if (!pendingReq) { json(res, 404, { error: "申请不存在或已处理" }); return; }
        const payload = JSON.parse(pendingReq.payload);
        // 行号可能已漂移：优先按入队时记录的稳定 id 定位（saveAuditRecord 内部处理）
        if (payload?._recordId != null && payload.recordId == null) payload.recordId = payload._recordId;
        saveAuditRecord(payload);
        edRun("UPDATE audit_edit_requests SET status = 'applied', decided_at = datetime('now','localtime') WHERE id = ?", Number(body.id));
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/audit/edits/reject" && req.method === "POST") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "仅主控账号可审批" }); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const { get: edGet, run: edRun } = await import("./lib/db.mjs");
      // 修复：原实现不过滤 status，可把**已批准生效**的申请再改成"已驳回"，
      // 审批台账与实际生效状态互相矛盾（审计追溯失真）。只允许驳回仍处于 pending 的申请。
      const pendingReq = edGet("SELECT id FROM audit_edit_requests WHERE id = ? AND status = 'pending'", Number(body?.id));
      if (!pendingReq) { json(res, 404, { error: "申请不存在或已处理" }); return; }
      edRun("UPDATE audit_edit_requests SET status = 'rejected', decided_at = datetime('now','localtime') WHERE id = ?", Number(body?.id));
      json(res, 200, { ok: true });
      return;
    }

    // ---------- AI 生成内容监测（管理员）----------
    if (pathname === "/api/aigc/overview" && req.method === "GET") {
      if (currentUser == null || (currentUser.role !== "boss" && currentUser.role !== "observer")) {
        json(res, 403, { error: "AI 监测需要管理员权限" });
        return;
      }
      json(res, 200, aigcOverview());
      return;
    }
    if (pathname === "/api/aigc/rescan" && req.method === "POST") {
      if (currentUser == null || (currentUser.role !== "boss" && currentUser.role !== "observer")) {
        json(res, 403, { error: "AI 监测需要管理员权限" });
        return;
      }
      try {
        const added = await runAigcScan();
        json(res, 200, { ok: true, added, overview: aigcOverview() });
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) });
      }
      return;
    }

    // ---------- 生图中继（本机出网不可达时经本实例中转取图） ----------
    const RELAY_KEY = process.env.VFLETCH_RELAY_KEY ?? "";
    if (pathname === "/relay/image" && req.method === "GET") {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (RELAY_KEY === "" || url.searchParams.get("k") !== RELAY_KEY) {
        json(res, 404, { error: "not found" });
        return;
      }
      const prompt = encodeURIComponent(String(url.searchParams.get("prompt") ?? "image").slice(0, 400));
      const width = Math.min(1024, Math.max(256, Number(url.searchParams.get("w")) || 512));
      const height = Math.min(1024, Math.max(256, Number(url.searchParams.get("h")) || 512));
      try {
        const upstream = await fetch(`https://image.pollinations.ai/prompt/${prompt}?width=${width}&height=${height}&nologo=true`, { signal: AbortSignal.timeout(90_000) });
        if (!upstream.ok) {
          json(res, 502, { error: `上游 HTTP ${upstream.status}` });
          return;
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        // 修复：中继图片响应缺少统一安全头，且 content-type 直接采信上游（可被构造成 text/html
        // 让 /relay/image 变成反射型内容载体）。强制白名单图片类型 + COMMON_HEADERS(nosniff)。
        const upstreamType = String(upstream.headers.get("content-type") ?? "");
        const safeType = /^image\/(png|jpe?g|webp|gif|avif)\b/i.test(upstreamType) ? upstreamType : "image/jpeg";
        res.writeHead(200, { ...COMMON_HEADERS, "content-type": safeType, "cache-control": "public, max-age=86400" });
        res.end(buf);
      } catch (error) {
        json(res, 502, { error: String(error?.message ?? error) });
      }
      return;
    }

    // ---------- 留痕上报查看（可选的跨实例上报记录） ----------
    if (pathname === "/api/ingest/events" && req.method === "GET") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "仅主控账号可查看上报记录" }); return; }
      try {
        const { all: ingAll } = await import("./lib/db.mjs");
        const rows = ingAll("SELECT subject, kind, summary, detail, happened_at AS happenedAt FROM ingest_events ORDER BY id DESC LIMIT 50");
        json(res, 200, { events: rows });
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/ingest" && req.method === "POST") {
      const body = await readJsonBody(req).catch(() => ({}));
      // 密钥口径：优先 VFLETCH_REPORT_KEY（与客户端上报端同名 env），兼容 VFLETCH_RELAY_KEY（历史约定）
      const ingestKeys = [process.env.VFLETCH_REPORT_KEY, RELAY_KEY].filter((k) => typeof k === "string" && k !== "");
      // 修复 SEC-05：原用 includes() 逐字符短路比较，存在时序侧信道；改常量时间比较
      const given = Buffer.from(String(body?.key ?? ""), "utf8");
      const keyOk = ingestKeys.some((k) => {
        const expect = Buffer.from(k, "utf8");
        return expect.length === given.length && timingSafeEqual(expect, given);
      });
      if (ingestKeys.length === 0 || !keyOk || !Array.isArray(body?.events)) {
        json(res, 403, { error: "上报密钥无效" });
        return;
      }
      try {
        const { run: ingRun } = await import("./lib/db.mjs");
        for (const ev of body.events.slice(0, 100)) {
          ingRun(
            "INSERT INTO ingest_events (subject, kind, summary, detail, happened_at) VALUES (?,?,?,?,?)",
            String(ev.subject ?? "unknown").slice(0, 80),
            String(ev.kind ?? "event").slice(0, 24),
            String(ev.summary ?? "").slice(0, 400),
            String(ev.detail ?? "").slice(0, 1000),
            String(ev.at ?? "").slice(0, 19),
          );
        }
        json(res, 200, { ok: true, accepted: Math.min(body.events.length, 100) });
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) });
      }
      return;
    }

    // ---------- 网页端文件上传（全员；存入工作区供 AI 读取处理） ----------
    if (pathname === "/api/upload" && req.method === "POST") {
      try {
        const rawName = decodeURIComponent(String(req.headers["x-file-name"] ?? "file"));
        const safeName = rawName.replace(/[\\/:*?"<>|]/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").slice(0, 120) || "file";
        const buf = await readRawBody(req);
        if (buf.length === 0) { json(res, 400, { error: "空文件" }); return; }
        const workspace = process.env.VFLETCH_WORKSPACE ?? process.cwd();
        const day = new Date().toISOString().slice(0, 10);
        const dir = path.join(workspace, "uploads", day);
        mkdirSync(dir, { recursive: true });
        const stored = path.join(dir, `${Date.now().toString(36)}_${safeName}`);
        writeFileSync(stored, buf);
        const TEXT_EXT = new Set([".md", ".txt", ".csv", ".json", ".log", ".html", ".htm", ".xml", ".yml", ".yaml", ".js", ".mjs", ".cjs", ".ts", ".py", ".sql", ".svg"]);
        const ext = path.extname(safeName).toLowerCase();
        const isText = TEXT_EXT.has(ext);
        const rel = `${path.relative(workspace, stored).replaceAll("\\", "/")}`;
        const reply = {
          ok: true,
          name: safeName,
          path: rel,
          size: buf.length,
          kind: isText ? "text" : "binary",
        };
        // 文本文件：小文件全文注入；大文件只注入小预览+工作区路径，
        // 并告知模型用 code_run 分段读取（修复"大文件只能分析一部分"的问题）。
        // 预览上限 4000（原 16000 会把对话刷成满屏数据——文件正文应以工作区+code_run 为准，预览只负责"让模型知道文件长什么样"）
        if (isText) {
          const full = buf.toString("utf8");
          const CHARS = 4000;
          reply.totalChars = full.length;
          if (full.length <= CHARS) {
            reply.content = full;
          } else {
            reply.truncated = true;
            reply.content =
              `【文件预览（前 ${CHARS} 字符，共 ${full.length} 字符）】
` +
              full.slice(0, CHARS) +
              `

【处理指引】完整文件已存于工作区路径 ${rel}（共 ${full.length} 字符）。` +
              `请用 code__code_run 读取该路径文件并按用户要求处理全文——可分段读取，不要只分析以上预览。`;
          }
        } else {
          reply.analysisHint = `二进制/大文件已存于工作区 ${rel}，可用 code__code_run 按需读取处理。`;
        }
        json(res, 200, reply);
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }

    // ---------- 企业共享知识库（全员可读；成员可投稿→主控/管理员审核；主控/管理员直发） ----------
    const kbIsStaff = currentUser?.role === "boss" || currentUser?.role === "observer";
    if (pathname === "/api/kb" && req.method === "GET") {
      try {
        const { all: kbAll } = await import("./lib/db.mjs");
        const me = currentUser?.username ?? "";
        // 主控/管理员：全部（active + pending）；成员：已发布 + 自己的待审核（进度可见）
        const rows = kbIsStaff
          ? kbAll("SELECT id, title, content, tags, created_by, status, created_at, updated_at FROM kb_docs WHERE status IN ('active','pending') ORDER BY updated_at DESC")
          : kbAll("SELECT id, title, content, tags, created_by, status, created_at, updated_at FROM kb_docs WHERE status = 'active' OR (status = 'pending' AND created_by = ?) ORDER BY updated_at DESC", me);
        json(res, 200, { docs: rows.map((r) => ({ ...r, tags: r.tags ? JSON.parse(r.tags) : [], mine: r.created_by === me })) });
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/kb" && req.method === "POST") {
      const body = await readJsonBody(req);
      const title = String(body?.title ?? "").trim();
      if (title === "") { json(res, 400, { error: "标题不能为空" }); return; }
      const status = kbIsStaff ? "active" : "pending"; // 成员投稿进入待审核
      try {
        const { run: kbRun } = await import("./lib/db.mjs");
        const id = "kb_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        kbRun(
          "INSERT INTO kb_docs (id, title, content, tags, created_by, status) VALUES (?,?,?,?,?,?)",
          id, title, String(body?.content ?? ""), JSON.stringify(Array.isArray(body?.tags) ? body.tags.slice(0, 8) : []), currentUser.username, status,
        );
        json(res, 200, { ok: true, id, status });
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/kb/archive" && req.method === "GET") {
      if (currentUser?.role !== "boss" && currentUser?.role !== "observer") { json(res, 403, { error: "回收站仅主控/管理员可见" }); return; }
      const { all: kbAll } = await import("./lib/db.mjs");
      json(res, 200, { docs: kbAll("SELECT id, title, created_by, updated_at FROM kb_docs WHERE status = 'archived' ORDER BY updated_at DESC LIMIT 100") });
      return;
    }
    if (pathname === "/api/kb/purge" && req.method === "POST") {
      if (currentUser?.role !== "boss" && currentUser?.role !== "observer") { json(res, 403, { error: "仅主控/管理员可彻底删除" }); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const { run: kbRun, get: kbGet } = await import("./lib/db.mjs");
      const doc = kbGet("SELECT id, status FROM kb_docs WHERE id = ?", String(body?.id ?? ""));
      if (!doc) { json(res, 404, { error: "文档不存在" }); return; }
      if (doc.status !== "archived") { json(res, 400, { error: "只能彻底删除回收站中的文档（请先归档）" }); return; } // 二级删除：先归档再清除
      const removed = kbRun("DELETE FROM kb_docs WHERE id = ?", doc.id).changes;
      log(SCOPE, `知识库彻底删除: ${currentUser.username} ${doc.id}`);
      json(res, 200, { ok: true, removed });
      return;
    }
    if (pathname === "/api/kb/restore" && req.method === "POST") {
      if (currentUser?.role !== "boss" && currentUser?.role !== "observer") { json(res, 403, { error: "仅主控/管理员可恢复" }); return; }
      const body = await readJsonBody(req).catch(() => ({}));
      const { run: kbRun, get: kbGet } = await import("./lib/db.mjs");
      const doc = kbGet("SELECT id, status FROM kb_docs WHERE id = ?", String(body?.id ?? ""));
      if (!doc) { json(res, 404, { error: "文档不存在" }); return; }
      if (doc.status !== "archived") { json(res, 400, { error: "该文档不在回收站" }); return; }
      kbRun("UPDATE kb_docs SET status = 'active', updated_at = datetime('now','localtime') WHERE id = ?", doc.id);
      json(res, 200, { ok: true });
      return;
    }
    if (pathname.startsWith("/api/kb/") && (req.method === "PUT" || req.method === "DELETE")) {
      const docId = pathname.split("/").filter(Boolean)[2];
      try {
        const { run: kbRun, get: kbGet } = await import("./lib/db.mjs");
        const doc = kbGet("SELECT id, created_by, status FROM kb_docs WHERE id = ?", docId);
        if (!doc) { json(res, 404, { error: "文档不存在" }); return; }
        if (kbIsStaff) {
          if (req.method === "DELETE") {
            kbRun("UPDATE kb_docs SET status = 'archived', updated_at = datetime('now','localtime') WHERE id = ?", docId);
          } else {
            const body = await readJsonBody(req);
            const approve = body?.approve === true;
            kbRun(
              "UPDATE kb_docs SET title = COALESCE(?, title), content = COALESCE(?, content), tags = COALESCE(?, tags), status = ?, updated_at = datetime('now','localtime') WHERE id = ?",
              body?.title != null ? String(body.title).trim() : null,
              body?.content != null ? String(body.content) : null,
              Array.isArray(body?.tags) ? JSON.stringify(body.tags.slice(0, 8)) : null,
              approve ? "active" : doc.status,
              docId,
            );
          }
        } else {
          if (doc.created_by !== currentUser.username) { json(res, 403, { error: "只能操作自己的投稿" }); return; }
          if (doc.status !== "pending") { json(res, 400, { error: "已发布的文档不可撤回，请联系管理员" }); return; }
          if (req.method === "DELETE") kbRun("UPDATE kb_docs SET status = 'archived', updated_at = datetime('now','localtime') WHERE id = ?", docId);
          else { json(res, 400, { error: "待审核投稿不可编辑，请撤回后重新提交" }); return; }
        }
        json(res, 200, { ok: true });
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) });
      }
      return;
    }

    // ---------- 本机运维（沙盒边界：仅主控账号，管理员/员工一律拒绝） ----------
    if ((pathname === "/api/admin/license" || pathname === "/api/admin/shutdown") && currentUser?.role !== "boss") {
      json(res, 403, { error: "该操作仅限主控账号" });
      return;
    }
    // 本地单机模式：不存在远程许可开关，恒为可用（接口保留仅为兼容前端历史调用）
    if (pathname === "/api/admin/license" && req.method === "POST") {
      json(res, 200, { enabled: true, local: true });
      return;
    }
    if (pathname === "/api/admin/online" && req.method === "GET") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "仅主控账号可查看在线状态" }); return; }
      try {
        const { all: onAll } = await import("./lib/db.mjs");
        const rows = onAll(`
          SELECT u.username, u.display_name, u.role, u.department, s.login_ip AS last_login_ip, s.ip_region, MAX(s.last_seen) AS last_seen
          FROM auth_sessions s JOIN users u ON u.id = s.user_id
          GROUP BY u.id ORDER BY last_seen DESC LIMIT 50`);
        const ONLINE_MS = 3 * 60 * 1000; // 与前端/控制台一致：3 分钟无心跳视为离线
        const toTs = (v) => { const t = Date.parse(v ?? ""); return Number.isFinite(t) ? t : 0; }; // last_seen 为 ISO 字符串
        json(res, 200, {
          online: rows.filter((r) => Date.now() - toTs(r.last_seen) < ONLINE_MS),
          recent: rows,
          now: Date.now(),
        });
      } catch (error) {
        json(res, 500, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/admin/license" && req.method === "GET") {
      json(res, 200, { enabled: true, local: true });
      return;
    }
    if (pathname === "/api/admin/shutdown" && req.method === "POST") {
      log(SCOPE, "收到停止指令，3 秒后退出");
      json(res, 200, { ok: true, message: "3 秒后退出" });
      setTimeout(() => process.exit(0), 3000);
      return;
    }

    // ---------- 会话取消（停止键的服务端路径，浏览器主线程冻结也能送达） ----------
    if (pathname === "/api/chat/cancel" && req.method === "POST") {
      const body = await readJsonBody(req).catch(() => ({}));
      const session = String(body?.session ?? "");
      const entry = activeTurns.get(session);
      // 修复 IDOR：会话 id 由客户端生成且可预测（ChatView 用 s+Date.now().toString(36)），
      // 原实现不校验归属 —— 任何登录用户遍历 session 名就能中止**别人**正在跑的回合，
      // 批量发送即可让全员对话持续中断（低成本拒绝服务），且日志里看不出是谁干的。
      if (entry != null && entry.ownerId != null && entry.ownerId !== currentUser?.id && currentUser?.role !== "boss") {
        log(SCOPE, `拒绝跨用户取消: ${currentUser?.username ?? "?"} → ${session}`);
        json(res, 403, { error: "只能终止自己的会话" });
        return;
      }
      if (entry != null) {
        try { entry.controller.abort(new Error("用户终止")); } catch {}
        activeTurns.delete(session);
        log(SCOPE, `会话已取消: ${session}（操作者 ${currentUser?.username ?? "?"}）`);
        json(res, 200, { ok: true, cancelled: session });
      } else {
        json(res, 200, { ok: true, cancelled: null }); // 没有活跃回合也算成功（幂等）
      }
      return;
    }

    // ---------- P0-2 事中拦截：对话流内裁决高危工具（审批卡按钮的落点） ----------
    if (pathname === "/api/chat/confirm" && req.method === "POST") {
      const body = await readJsonBody(req).catch(() => ({}));
      const confirmId = String(body?.id ?? "");
      const entry = pendingConfirms.get(confirmId);
      if (entry == null) {
        json(res, 404, { error: "审批请求不存在或已超时" });
        return;
      }
      // 修复（fail-open）：原判据 `entry.username != null && ...` 在归属为空的审批请求上直接放行，
      // 任何登录用户都能替别人批准高危工具。改为**要求归属明确且一致**，归属缺失一律拒绝（fail-closed，
      // 最坏情况是该审批卡超时自动拒绝，而不是被陌生账号批准执行删库/发布类动作）。
      if (currentUser == null || entry.username == null || entry.username !== currentUser.username) {
        json(res, 403, { error: "只有发起会话的账号可以裁决该请求" });
        return;
      }
      const approved = body?.approve === true;
      entry.resolve({ approved, note: approved ? "已批准" : "已拒绝" });
      json(res, 200, { ok: true, approved });
      return;
    }

    // ---------- AI 员工自助体系（成员可建/转交/组部门；管理员与观察员可管理全部） ----------
    if (pathname === "/api/team/employees" && req.method === "GET") {
      json(res, 200, team.listChatEmployees(currentUser));
      return;
    }
    if (pathname === "/api/team/employees" && req.method === "POST") {
      const body = await readJsonBody(req);
      try {
        json(res, 200, team.createAiEmployee(currentUser, body ?? {}));
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    const teamSeg = pathname.split("/").filter(Boolean);
    if (teamSeg[1] === "team" && teamSeg[2] === "employees" && teamSeg.length === 5 && req.method === "POST") {
      const body = await readJsonBody(req);
      const [ , , , targetId, action] = teamSeg;
      try {
        if (action === "update") json(res, 200, team.updateAiEmployee(currentUser, targetId, body ?? {}));
        else if (action === "transfer") json(res, 200, team.transferAiEmployee(currentUser, targetId, body?.to));
        else json(res, 404, { error: "未知操作" });
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/team/teams" && req.method === "GET") {
      json(res, 200, team.listTeams({ includeDisbanded: url.searchParams.get("all") === "1" }));
      return;
    }
    if (pathname === "/api/team/teams" && req.method === "POST") {
      const body = await readJsonBody(req);
      try {
        json(res, 200, team.createTeam(currentUser, { name: body?.name, purpose: body?.purpose, memberIds: body?.memberIds, memberUserIds: body?.memberUserIds, isProject: body?.isProject, grantCode: body?.grantCode }));
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    // 部门创建授权码（仅主控签发/查看）
    if (pathname === "/api/team/grants" && req.method === "GET") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "仅主控账号可管理授权码" }); return; }
      json(res, 200, { grants: team.listTeamGrants() });
      return;
    }
    if (pathname === "/api/team/grants" && req.method === "POST") {
      if (currentUser?.role !== "boss") { json(res, 403, { error: "仅主控账号可签发授权码" }); return; }
      json(res, 200, team.issueTeamGrant(currentUser.username ?? "central"));
      return;
    }
    if (teamSeg[1] === "team" && teamSeg[2] === "teams" && teamSeg.length === 5 && teamSeg[4] === "disband" && req.method === "POST") {
      try {
        json(res, 200, team.disbandTeam(currentUser, teamSeg[3]));
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }

    // ---------- 欢迎页快捷指令（按使用数据实时生成，按当前账号作用域） ----------
    if (pathname === "/api/suggest" && req.method === "GET") {
      json(res, 200, buildSuggestions({
        limit: Number(url.searchParams.get("limit")) || 4,
        offset: Number(url.searchParams.get("offset")) || 0,
        userId: currentUser?.id ?? null,
      }));
      return;
    }

    // ---------- 设置（模型 API 配置，Codex 式层级） ----------
    if (pathname === "/api/settings" && req.method === "GET") {
      const data = getSettings();
      if (currentUser?.role !== "boss") {
        // 非主控（观察员）只读摘要：不下发 baseUrl 与配置文件绝对路径（测试报告 P1）
        delete data.configFile;
        data.providers = Object.fromEntries(Object.entries(data.providers ?? {}).map(([id, p]) => [
          id, { id, label: p.label, model: p.model, protocol: p.protocol, hasApiKey: p.hasApiKey },
        ]));
      }
      json(res, 200, data);
      return;
    }
    if (pathname === "/api/settings/provider" && req.method === "POST") {
      const body = await readJsonBody(req);
      // 观察员可维护模型 API（管理层），但两个边界与白名单设计一致：
      // ① 保存不得切换激活模型（/api/settings/active 是主控专属，不能借 save 绕过）；
      // ② 响应与 GET 同口径脱敏（不下发 baseUrl/configFile，否则保存一次就全量泄露）。
      const isBossCaller = currentUser?.role === "boss";
      const result = saveProvider({ id: body.id, fields: body.fields ?? body, setActive: isBossCaller ? body.active : undefined });
      // MCP 重扫放后台（stdio 连接最长 20s），不让保存请求干等
      if (body.reload !== false) mcp.start().catch(() => {});
      try {
        rms.syncProviderEmployees(usableProviders());
      } catch {}
      const settingsView = getSettings();
      if (!isBossCaller) {
        delete settingsView.configFile;
        settingsView.providers = Object.fromEntries(Object.entries(settingsView.providers ?? {}).map(([id, p]) => [
          id, { id, label: p.label, model: p.model, protocol: p.protocol, hasApiKey: p.hasApiKey },
        ]));
      }
      json(res, 200, { ...result, settings: settingsView });
      return;
    }
    if (pathname === "/api/settings/active" && req.method === "POST") {
      const body = await readJsonBody(req);
      try {
        json(res, 200, setActiveProvider(body.id));
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/settings/provider-delete" && req.method === "POST") {
      const body = await readJsonBody(req);
      try {
        const result = deleteProvider(body.id);
        // 同步清理该供应商自动创建的模型员工（防止僵尸员工在组织页/对话下拉里越积越多）
        let cleaned = null;
        try { cleaned = rms.removeProviderEmployee(body.id); } catch {}
        json(res, 200, { ...result, removedEmployee: cleaned ?? null });
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }
    if (pathname === "/api/settings/mcp" && req.method === "POST") {
      const body = await readJsonBody(req);
      // 修复（破坏性 fail-open）：原实现是 saveMcpServers(body.servers ?? []) —— 把"没传 servers"
      // 当成"清空全部 MCP 定义"。任何字段名写错/旧客户端/空 body 的调用都会静默删掉所有 server
      // 且返回 200（本次巡检实测踩到：传 {mcpServers:[...]} 后 mcp.json 变成 servers: []，工具数 69→28）。
      // 现在把 undefined/非数组交给 saveMcpServers 自身的 !Array.isArray 校验抛错，统一 400；
      // 显式传 { servers: [] } 仍然可以清空（意图明确）。同时补 try/catch，避免校验错误冒泡成 500。
      try {
        const result = saveMcpServers(body?.servers);
        const snapshot = await mcp.start();
        json(res, 200, { ...result, snapshot });
      } catch (error) {
        json(res, 400, { error: String(error?.message ?? error) });
      }
      return;
    }

    // ---------- 用量 ----------
    if (pathname === "/api/usage" && req.method === "GET") {
      json(res, 200, usageSummary());
      return;
    }
    if (pathname === "/api/chat" && req.method === "POST") {
      await handleChat(req, res);
      return;
    }
    // ---------- 生成的图片（image_generate 落盘到 CONFIG_DIR/generated） ----------
    if (pathname.startsWith("/generated/")) {
      const name = path.basename(pathname);
      const target = path.join(CONFIG_DIR, "generated", name);
      if (name.includes("..") || !existsSync(target) || !statSync(target).isFile() || statSync(target).size === 0) {
        json(res, 404, { error: "图片不存在" });
        return;
      }
      const imgType = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" }[path.extname(name).toLowerCase()] ?? "application/octet-stream";
      res.writeHead(200, { ...COMMON_HEADERS, "content-type": imgType, "cache-control": "public, max-age=86400" });
      createReadStream(target).pipe(res);
      return;
    }

    if (pathname.startsWith("/api/")) {
      json(res, 404, { error: `未知接口 ${pathname}` });
      return;
    }
    serveStatic(req, res, pathname);
  } catch (error) {
    warn(SCOPE, "请求处理失败", { pathname, error: String(error?.message ?? error) });
    if (res.headersSent) {
      res.end();
      return;
    }
    json(res, 500, { error: String(error?.message ?? error) });
  }
});

// 打开监管数据库（SQLite；初始化建表+种子）
try {
  const health = dbHealthy();
  if (health.ok !== true) throw new Error(health.error ?? "数据库不可用");
  log(SCOPE, `监管数据库就绪: SQLite ${health.sqlite} @ ${health.file}`);
  if (health.sqlite == null) throw new Error("sqlite_version 不可用");
  openDb();
} catch (error) {
  warn(SCOPE, `监管数据库初始化失败（降级为仅内存监控）: ${String(error?.message ?? error)}`);
}

// 可用供应商：key 已解析非空，或本地端点（vLLM/Ollama 常免鉴权）
function usableProviders() {
  try {
    const cfg = loadModelConfig();
    return Object.values(cfg.providers ?? {}).filter((p) => {
      if (String(p.id ?? "").toLowerCase() === "vf" || String(p.protocol ?? "").toLowerCase() === "vf") return false; // 前台模型不生成 AI 员工（大小写不敏感）
      if ((p.apiKey ?? "") !== "") return true;
      return /\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(String(p.baseUrl ?? ""));
    });
  } catch {
    return [];
  }
}

// 初始化 DB 辅助引用（login IP 写入用）
import { all as dbAllRows, run as dbRun } from "./lib/db.mjs";
allRows = dbAllRows;
dbRunProxy = dbRun;
await_import_db = () => ({ run: dbRun });

// 模型 API → AI 员工档案同步（切换模型即切换员工，监管页可见分员工留痕）
try {
  const synced = rms.syncProviderEmployees(usableProviders());
  log(SCOPE, `AI 员工同步完成：${synced.map((e) => `${e.id}${e.created ? "(新)" : ""}`).join("、") || "无可用模型供应商"}`);
} catch (error) {
  warn(SCOPE, "AI 员工同步失败", { error: String(error?.message ?? error) });
}

// 账号系统：首次启动种子管理员账号（用户名 central；初始密码见下方日志，登录后可在设置页改密）
try {
  const seeded = auth.seedBoss();
  if (seeded) {
    log(SCOPE, `账号系统就绪：已创建管理员账号 "${seeded.username}"，初始密码 ${seeded.password}` +
      (seeded.generated ? "（公开的开发默认口令——面向他人开放前请设置 VF_BOSS_P 或登录后立即改密）" : "（取自 VF_BOSS_P 环境变量）"));
  } else {
    log(SCOPE, "账号系统就绪");
  }
} catch (error) {
  warn(SCOPE, "账号系统初始化失败", { error: String(error?.message ?? error) });
}

// HTTP 监听：端口被占（TIME_WAIT/残留实例）时自动重试；监听错误不再变成未捕获异常
function startListening(attempt = 0) {
  server.once("error", (error) => {
    if (error?.code === "EADDRINUSE" && attempt < 3) {
      warn(SCOPE, `端口 ${PORT} 被占用，0.8s 后重试 (${attempt + 1}/3)`);
      setTimeout(() => startListening(attempt + 1), 800);
      return;
    }
    warn(SCOPE, "HTTP 服务启动失败", { error: String(error?.message ?? error) });
  });
  // 长连接参数（Node 默认 keepAliveTimeout 只有 5s）：
  // 客户端连接池的空闲超时通常也在 4~5s 量级，两边在相近时刻各自关闭同一条连接时，
  // 后到的那次请求会撞上服务端正在关闭的 socket，客户端看到的就是 ECONNRESET
  // （压测中表现为"几十分之一概率的 fetch failed"，浏览器里表现为偶发请求失败）。
  // 把服务端空闲超时抬到远超客户端、并让 headersTimeout 略大于它，竞态窗口即消失，
  // 同时省掉每 5s 重建一次 TCP 握手。
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.listen(PORT, HOST, () => {
    log(SCOPE, `V-Fletch 后端已启动 http://${HOST}:${PORT}`);
    log(SCOPE, `接口: /api/health /api/models /api/mcp/list /api/mcp/reload /api/mcp/call /api/chat /api/rms/*`);
    // AI 生成内容实时监测：启动即扫一遍历史，之后每 30s 增量扫描（消息 + 工作区文件）
    const scanAigc = async () => {
      try {
        const added = await runAigcScan();
        if (added > 0) log("aigc", `新增监测记录 ${added} 条`);
      } catch (error) {
        warn("aigc", "扫描失败", { error: String(error?.message ?? error) });
      }
    };
    scanAigc();
    setInterval(scanAigc, 30000);
  });
}

// ---------------------------------------------------------------------------
// 优雅退出（修复：重启服务会泄漏一整套 MCP 子进程）
//
// Node 在 Windows 上收到 `process.kill(pid,"SIGTERM")` 时直接 TerminateProcess，
// **不会**执行任何 JS 回调；而 Ctrl+C 的 SIGINT 是会走回调的。所以：
//   ① SIGINT/SIGTERM：停收新连接 → 回收 MCP 子进程 → 退出（带 2s 硬超时兜底，避免卡住不退）；
//   ② process.on("exit")：同步兜底再杀一遍已登记的子进程树（覆盖异常退出路径）。
// 两者都不改变任何对外接口与进程模型，只是把"退出"这件事做完整。
let shuttingDown = false;
async function gracefulShutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(SCOPE, `收到 ${reason}，正在退出（回收 MCP 子进程）…`);
  const hardExit = setTimeout(() => {
    killOrphanedMcpChildrenSync();
    process.exit(0);
  }, 2000);
  hardExit.unref?.();
  try {
    await new Promise((resolve) => {
      try { server.close(() => resolve()); } catch { resolve(); }
      setTimeout(resolve, 1500).unref?.();
    });
    await mcp.stopAll();
  } catch (error) {
    warn(SCOPE, "退出清理异常", { error: String(error?.message ?? error) });
  } finally {
    clearTimeout(hardExit);
    killOrphanedMcpChildrenSync();
    process.exit(0);
  }
}
process.on("SIGINT", () => { gracefulShutdown("SIGINT"); });
process.on("SIGTERM", () => { gracefulShutdown("SIGTERM"); });
process.on("exit", () => { killOrphanedMcpChildrenSync(); });

mcp
  .start()
  .then((snapshot) => {
    log(SCOPE, `MCP 初始化完成：${snapshot.servers.filter((s) => s.status === "connected").length} 个已连接，${snapshot.toolCount} 个工具，${snapshot.conflicts.length} 条诊断`);
    startListening();
  })
  .catch((error) => {
    warn(SCOPE, "MCP 初始化失败", { error: String(error?.message ?? error) });
    startListening();
    log(SCOPE, `V-Fletch 后端已启动（MCP 未就绪） http://${HOST}:${PORT}`);
  });

export { normalizeToolResult };
