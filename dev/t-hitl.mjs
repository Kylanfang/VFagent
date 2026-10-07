// P0-2 事中拦截（HITL）守护测试：code__ 系工具执行前必须经人工审批。
// 两层验证，全部确定性（stub OpenAI 兼容模型服务器，不依赖真实模型/外网）：
//   第一层：进程内直调 runTurn，双引擎（langgraph 默认 + legacy）× 批准/拒绝/无人值守 三分支；
//   第二层：起真实服务器（独立配置目录 + 端口 8797），走完整 SSE 链路：
//           批准执行 / 拒绝后模型收到拒因 / 超时自动拒绝（VFLETCH_CONFIRM_TIMEOUT_MS=2500）/ 非本人裁决 403。
import { killChild } from "./testlib.mjs";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✅ ${name} ${extra}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

// ---------- stub 模型服务器（openai-compatible，非流式 JSON） ----------
// 行为脚本：历史里没有工具结果 → 请求执行 code__code_run；有工具结果 → 收尾文本。
// sawRefusal：模型侧确实收到了【事中拦截】拒因（拒绝路径的闭环证据）。
const stubState = { sawRefusal: false, lastPromptChars: 0, holdUntil: 0, httpStatus: 0, doubleCall: false };
const STUB_PORT = 18787;
const stubServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    const reply = () => {
      // 注入非 200 状态（如 429 限流）：返回 OpenAI 风格错误体
      if (stubState.httpStatus > 0) {
        res.writeHead(stubState.httpStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `test upstream ${stubState.httpStatus}`, type: "test_error" } }));
        return;
      }
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      stubState.lastPromptChars = messages.length;
      const toolMsg = messages.find((m) => m.role === "tool");
      if (toolMsg != null) {
        if (/事中拦截/.test(String(toolMsg.content ?? ""))) stubState.sawRefusal = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "已了解，本次不执行代码，改为直接给出结论。" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            // G 组去重测试：doubleCall=true 时同一回合返回两次完全相同的调用
            tool_calls: stubState.doubleCall ? [
              { id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name: "code__code_run", arguments: JSON.stringify({ language: "node", code: "console.log('dup')" }) } },
              { id: `call_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name: "code__code_run", arguments: JSON.stringify({ language: "node", code: "console.log('dup')" }) } },
            ] : [{
              id: `call_${Math.random().toString(36).slice(2, 8)}`,
              type: "function",
              function: { name: "code__code_run", arguments: JSON.stringify({ language: "node", code: "console.log(2+3)" }) },
            }],
          },
          finish_reason: "tool_calls",
        }],
        usage: { prompt_tokens: 30, completion_tokens: 15 },
      }));
    };
    // 并发闸测试用：把模型响应挂住到 holdUntil，让进行中的回合保持 in-flight
    setTimeout(reply, Math.max(0, stubState.holdUntil - Date.now()));
  });
});
await new Promise((r) => stubServer.listen(STUB_PORT, "127.0.0.1", r));

const provider = {
  id: "stub", label: "stub", protocol: "openai-compatible", model: "stub-1",
  baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`, apiKey: "sk-stub",
  supportsTools: true, supportsStream: false, contextWindow: null,
};
const executed = [];
const mcpStub = {
  servers: [],
  toOpenAiTools: () => [{ type: "function", function: { name: "code__code_run", description: "run code", parameters: { type: "object", properties: {} } } }],
  callTool: async (name, args) => { executed.push({ name, args }); return { text: `ran ${name}` }; },
};
const { runTurn, CONFIRM_TIMEOUT_MS } = await import("../server/lib/chat.mjs");

async function unitTurn({ confirm, engine }) {
  executed.length = 0;
  stubState.sawRefusal = false;
  const prevEngine = process.env.VFLETCH_AGENT_ENGINE;
  if (engine != null) process.env.VFLETCH_AGENT_ENGINE = engine; else delete process.env.VFLETCH_AGENT_ENGINE;
  try {
    const events = [];
    const result = await runTurn({
      messages: [{ role: "user", content: "帮我跑段代码" }],
      provider,
      defaults: { temperature: 0.3, maxToolRounds: 5 },
      mcp: mcpStub,
      contextWindow: 300000,
      onEvent: (e) => events.push(e),
      confirm,
      signal: undefined,
    });
    return { events, result };
  } finally {
    if (prevEngine == null) delete process.env.VFLETCH_AGENT_ENGINE; else process.env.VFLETCH_AGENT_ENGINE = prevEngine;
  }
}
const toolResults = (events) => events.filter((e) => e.type === "tool_result");

console.log("\n▶ 第一层：进程内双引擎闸门（stub 模型）");
for (const engine of [null, "legacy"]) {
  const label = engine == null ? "langgraph(默认)" : "legacy";

  const ok = await unitTurn({ engine, confirm: async () => ({ approved: true }) });
  check(`[${label}] 批准 → code_run 真实执行 1 次`, executed.length === 1 && executed[0]?.name === "code__code_run", `(执行 ${executed.length} 次)`);
  check(`[${label}] 批准 → tool_result 非 error`, toolResults(ok.events).length === 1 && toolResults(ok.events)[0].isError !== true);

  const deny = await unitTurn({ engine, confirm: async () => ({ approved: false, note: "测试拒绝" }) });
  check(`[${label}] 拒绝 → 绝不执行`, executed.length === 0, `(执行 ${executed.length} 次)`);
  const dr = toolResults(deny.events)[0];
  check(`[${label}] 拒绝 → tool_result 携带拒因给模型`, dr?.isError === true && /事中拦截/.test(dr?.text ?? "") && /测试拒绝/.test(dr?.text ?? ""));
  check(`[${label}] 拒绝 → 下一轮模型确实收到拒因`, stubState.sawRefusal);

  const none = await unitTurn({ engine });
  check(`[${label}] 无审批通道（无人值守）→ 直接拒绝不执行`, executed.length === 0 && /事中拦截/.test(toolResults(none.events)[0]?.text ?? ""));
}

// ---------- 第二层：真实服务器 E2E（SSE 全链路） ----------
console.log("\n▶ 第二层：真实服务器 SSE 全链路（端口 8797，超时 2.5s）");
const HITL_DIR = path.join(ROOT, ".autotest-hitl");
const PORT = 8797;
const BASE = "http://127.0.0.1:" + PORT;
try { rmSync(HITL_DIR, { recursive: true, force: true, maxRetries: 3 }); } catch {}
mkdirSync(HITL_DIR, { recursive: true });
writeFileSync(path.join(HITL_DIR, "model.json"), JSON.stringify({
  active: "stub",
  defaults: { temperature: 0.3, maxOutputTokens: 1024, maxToolRounds: 5, contextWindowTokens: 300000 },
  providers: { stub: provider },
}, null, 2), "utf8");

const CONFIRM_TIMEOUT_MS_E2E = 2500;
const child = spawn(process.execPath, ["server/main.mjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    VFLETCH_CONFIG_DIR: HITL_DIR,
    VFLETCH_PORT: String(PORT),
    VFLETCH_HOST: "127.0.0.1",
    VFLETCH_WORKSPACE: path.join(HITL_DIR, "workspace"),
    VFLETCH_CONFIRM_TIMEOUT_MS: String(CONFIRM_TIMEOUT_MS_E2E),
    VFLETCH_MAX_CONCURRENT_TURNS: "1",
  },
  stdio: "ignore", detached: true,
});
let up = false;
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { const h = await fetch(BASE + "/api/health"); if (h.ok) { up = true; break; } } catch {}
}
if (!up) { console.log("独立 HITL 测试服务器启动失败"); await killChild(child); stubServer.close(); process.exit(1); }

const login = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "central", password: (process.env.VF_BOSS_P ?? "vfletch-dev") }) }).then((r) => r.json()).catch(() => null);
const T = login?.token;
if (!T) { console.log("主控登录失败，E2E 中止"); await killChild(child); stubServer.close(); process.exit(1); }
check("服务器就绪 + 主控登录", true, `(超时=${CONFIRM_TIMEOUT_MS}ms 配置，E2E=${CONFIRM_TIMEOUT_MS_E2E}ms)`);

async function sseChat(session, handleFrame) {
  const res = await fetch(BASE + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + T },
    body: JSON.stringify({ messages: [{ role: "user", content: "帮我跑段代码" }], provider: "stub", session }),
  });
  if (!res.ok) throw new Error("chat HTTP " + res.status);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const frames = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /^event: (.*)$/m.exec(frame)?.[1];
      const dataRaw = /^data: (.*)$/m.exec(frame)?.[1];
      const data = dataRaw ? JSON.parse(dataRaw) : null;
      if (ev != null) { frames.push({ event: ev, data }); await handleFrame?.(ev, data); }
    }
  }
  return frames;
}
const frameOf = (frames, ev) => frames.find((f) => f.event === ev)?.data;

// A. 批准 → 真实执行
let approveFrames = [];
{
  let confirmId = null;
  approveFrames = await sseChat(`hitl-ok-${Date.now()}`, async (ev, data) => {
    if (ev === "confirm_request" && confirmId == null) {
      confirmId = data.id;
      check("A confirm_request 下发（含工具名/代码/超时）", data.tool === "code__code_run" && typeof data.arguments?.code === "string" && data.timeoutMs === CONFIRM_TIMEOUT_MS_E2E);
      await fetch(BASE + "/api/chat/confirm", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + T }, body: JSON.stringify({ id: confirmId, approve: true }) });
    }
  });
}
const aRes = frameOf(approveFrames, "confirm_result");
check("A confirm_result 回流：已批准", aRes?.approved === true);
{
  const aText = String(frameOf(approveFrames, "tool_result")?.text ?? "");
  check("A tool_result 为真实执行结果（2+3=5）", frameOf(approveFrames, "tool_result")?.isError !== true && /\b5\b/.test(aText), `(text=${aText.slice(0, 80).replace(/\n/g, " ")})`);
}
check("A 回合正常收尾（done）", frameOf(approveFrames, "done") != null);

// B. 拒绝 → 模型收到拒因并收尾
let denyFrames = [];
{
  let confirmId = null;
  stubState.sawRefusal = false;
  denyFrames = await sseChat(`hitl-no-${Date.now()}`, async (ev, data) => {
    if (ev === "confirm_request" && confirmId == null) {
      confirmId = data.id;
      await fetch(BASE + "/api/chat/confirm", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + T }, body: JSON.stringify({ id: confirmId, approve: false }) });
    }
  });
}
const dRes = frameOf(denyFrames, "confirm_result");
check("B confirm_result：已拒绝", dRes?.approved === false);
check("B tool_result 为拦截拒因", frameOf(denyFrames, "tool_result")?.isError === true && /事中拦截/.test(frameOf(denyFrames, "tool_result")?.text ?? ""));
check("B 拒绝后模型改道收尾（done）", frameOf(denyFrames, "done") != null && stubState.sawRefusal);

// C. 超时不裁决 → 自动拒绝
let timeoutFrames = [];
{
  stubState.sawRefusal = false;
  timeoutFrames = await sseChat(`hitl-t-${Date.now()}`, async () => {}); // 收到 confirm_request 也故意不理
}
const tRes = frameOf(timeoutFrames, "confirm_result");
check("C 超时自动拒绝", tRes?.approved === false && /超时/.test(tRes?.note ?? ""), `(note=${(tRes?.note ?? "").slice(0, 30)})`);
check("C 超时后 tool_result 为拦截且模型收到", frameOf(timeoutFrames, "tool_result")?.isError === true && stubState.sawRefusal);

// D. 裁决接口防御：伪造 id → 404；他人（未登录）→ 401/403
const bogus = await fetch(BASE + "/api/chat/confirm", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + T }, body: JSON.stringify({ id: "nope:call_x", approve: true }) });
check("D1 伪造审批 id → 404", bogus.status === 404, `(实际 ${bogus.status})`);
const anon = await fetch(BASE + "/api/chat/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "whatever", approve: true }) });
check("D2 未登录裁决 → 401/403", anon.status === 401 || anon.status === 403, `(实际 ${anon.status})`);

// E. 并发自保闸（MAX_CONCURRENT_TURNS=1）：第一个回合进行中，第二个请求 429 友好拒绝
{
  stubState.holdUntil = Date.now() + 2500; // 挂住模型响应，让回合 A 保持进行中
  const aPromise = sseChat(`hitl-cc-${Date.now()}`, async () => {});
  await new Promise((r) => setTimeout(r, 600)); // 确认 A 已进入回合
  const b = await fetch(BASE + "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + T },
    body: JSON.stringify({ messages: [{ role: "user", content: "x" }], provider: "stub", session: `hitl-cc2-${Date.now()}` }),
  });
  check("E1 并发超限 → 429", b.status === 429, `(实际 ${b.status})`);
  const bBody = await b.json().catch(() => null);
  check("E2 429 携带可读中文提示", /稍候|进行中/.test(bBody?.error ?? ""), `(error=${String(bBody?.error ?? "").slice(0, 40)})`);
  const aFrames = await aPromise;
  check("E3 首个回合不受影响正常收尾", frameOf(aFrames, "done") != null);
  stubState.holdUntil = 0;
}

// F. 上游 429 限流：不自动重试（重试会占用"失败也计费"的分钟级配额、加剧雪崩），报错人话化
{
  // F1/F2 单元层（langgraph 默认引擎）：429 直接抛出、无自动重试 delta
  stubState.httpStatus = 429;
  executed.length = 0;
  stubState.sawRefusal = false;
  let threw = null;
  const events = [];
  try {
    const prevEngine = process.env.VFLETCH_AGENT_ENGINE;
    delete process.env.VFLETCH_AGENT_ENGINE;
    try {
      await runTurn({
        messages: [{ role: "user", content: "帮我跑段代码" }],
        provider, defaults: { temperature: 0.3, maxToolRounds: 5 }, mcp: mcpStub, contextWindow: 300000,
        onEvent: (e) => events.push(e),
      });
    } finally { if (prevEngine == null) delete process.env.VFLETCH_AGENT_ENGINE; else process.env.VFLETCH_AGENT_ENGINE = prevEngine; }
  } catch (e) { threw = String(e?.message ?? e); }
  check("F1 上游429 → 快速失败并带人话提示", threw != null && /HTTP 429/.test(threw) && /限流/.test(threw), `(err=${(threw ?? "(未抛)").slice(0, 60)})`);
  check("F2 上游429 → 不自动重试（无重试提示文本）", !events.some((e) => e.type === "delta" && /自动重试/.test(e.text ?? "")), `(delta 数 ${events.filter((e) => e.type === "delta").length})`);

  // F3 E2E 层：SSE error 事件透出人话提示，且回合以 error 收尾（不悬挂）
  let fFrames = [];
  fFrames = await sseChat(`hitl-429-${Date.now()}`, async () => {});
  const fErr = frameOf(fFrames, "error");
  check("F3 E2E 429 → SSE error 人话提示", fErr != null && /HTTP 429/.test(fErr?.message ?? "") && /限流/.test(fErr?.message ?? ""), `(msg=${(fErr?.message ?? "(无)").slice(0, 60)})`);
  stubState.httpStatus = 0;
}


// G. 同轮去重：相同工具+相同参数的重复调用只真执行一次（修 dsh 实测的审计问答打转问题）
{
  executed.length = 0;
  stubState.doubleCall = true;
  stubState.sawRefusal = false;
  const prevEngine = process.env.VFLETCH_AGENT_ENGINE;
  delete process.env.VFLETCH_AGENT_ENGINE;
  const events = [];
  try {
    await runTurn({
      messages: [{ role: "user", content: "帮我跑段代码" }],
      provider,
      defaults: { temperature: 0.3, maxToolRounds: 5 },
      mcp: mcpStub,
      contextWindow: 300000,
      onEvent: (e) => events.push(e),
      confirm: async () => ({ approved: true }),
    });
  } finally {
    if (prevEngine == null) delete process.env.VFLETCH_AGENT_ENGINE; else process.env.VFLETCH_AGENT_ENGINE = prevEngine;
  }
  const callEvents = events.filter((e) => e.type === "tool_call");
  const resultEvents = events.filter((e) => e.type === "tool_result");
  check("G1 同轮两次相同调用 → 仅真实执行 1 次", executed.length === 1, `(执行 ${executed.length} 次)`);
  check("G2 两次调用都有 tool_call/tool_result 事件（前端显示完整）", callEvents.length === 2 && resultEvents.length === 2, `(${callEvents.length}/${resultEvents.length})`);
  check("G3 第二次结果标记为复用并劝阻重复", /复用结果/.test(resultEvents[1]?.text ?? "") === true);
  stubState.doubleCall = false;
}

console.log("\n==== HITL 守护结果: 通过 " + pass + " / 失败 " + fail + " ====");
await killChild(child);
stubServer.close();
process.exit(fail === 0 ? 0 : 1);
