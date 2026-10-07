// 自动化测试公共库：登录 / 请求 / SSE 聊天解析 / 断言收集
export const BASE = process.env.VF_TEST_BASE ?? "http://127.0.0.1:8790";

export const results = { pass: 0, fail: 0, items: [] };

export function check(name, cond, detail = "") {
  if (cond) {
    results.pass += 1;
    console.log(`  ✅ ${name}`);
  } else {
    results.fail += 1;
    results.items.push({ name, detail });
    console.log(`  ❌ ${name}${detail ? "  ← " + String(detail).slice(0, 300) : ""}`);
  }
  return !!cond;
}

export function group(title) {
  console.log(`\n▶ ${title}`);
}

export function summary() {
  console.log(`\n==== 结果: 通过 ${results.pass} / 失败 ${results.fail} ====`);
  for (const it of results.items) console.log(`  ✗ ${it.name}: ${String(it.detail).slice(0, 300)}`);
  return results.fail === 0;
}

export async function api(method, path, { token, body, headers = {}, timeout = 20000, raw = false } = {}) {
  const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeout) };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (body != null && !(body instanceof Uint8Array) && typeof body !== "string") {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  } else if (body != null) {
    init.body = body;
  }
  const res = await fetch(BASE + path, init);
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}

export async function login(username, password) {
  const r = await api("POST", "/api/auth/login", { body: { username, password } });
  if (r.status !== 200) throw new Error(`登录失败 ${username}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

/**
 * 发一次 SSE 聊天并收集全部事件。返回 { events, text, reasoning, tools, errors, start, done, status }
 */
export async function chat({ token, messages, provider, session, employee, timeout = 90000, extra = {}, autoConfirm = false }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("chat timeout")), timeout);
  const out = { events: [], text: "", reasoning: "", tools: [], errors: [], start: null, done: null, status: 0, rawError: null, confirms: [] };
  // P0-2 事中拦截：高危工具（如 code__code_run）会先下发 confirm_request 等人工裁决。
  // 默认保持 HITL 语义（不做任何裁决，由 t-hitl.mjs 专测）；传 autoConfirm: true 时立即批准，
  // 供"工具调用闭环"类断言使用 —— 否则它们会一路等到 120 秒审批超时被拒，表现为与产品无关的假失败。
  const confirmCalls = [];
  try {
    const res = await fetch(BASE + "/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ messages, provider, session, employee, ...extra }),
      signal: ctrl.signal,
    });
    out.status = res.status;
    const ctype = res.headers.get("content-type") ?? "";
    if (!ctype.includes("text/event-stream")) {
      const t = await res.text();
      try { out.rawError = JSON.parse(t); } catch { out.rawError = t; }
      return out;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const handleChunk = (chunk) => {
      let ev = "message";
      let data = "";
      for (const line of chunk.split("\n")) {
        if (line.startsWith("event:")) ev = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      let payload = data;
      try { payload = JSON.parse(data); } catch {}
      // 服务端所有事件都是 `data: <JSON>`（server/lib/util.mjs: sseSend）。若某个已知事件的数据解析不出来，
      // 说明流被上游切断/错帧 —— 记进 errors 暴露出来，而不是当成正常事件静默吞掉（曾见过
      // "Unexpected end of input" 这类半截帧被忽略，导致后续断言以"空回复"的形式误报）。
      const JSON_EVENTS = new Set(["start", "delta", "reasoning", "tool_call", "tool_result", "confirm_request", "error", "done", "end", "usage"]);
      if (typeof payload === "string" && JSON_EVENTS.has(ev) && data.trim() !== "" && !/^\[DONE\]$/.test(data.trim())) {
        out.errors.push({ event: ev, unparsed: data.slice(0, 160) });
        return;
      }
      out.events.push({ ev, payload });
      if (ev === "start") out.start = payload;
      else if (ev === "delta") out.text += payload?.text ?? "";
      else if (ev === "reasoning") out.reasoning += payload?.text ?? "";
      else if (ev === "tool_call") out.tools.push({ name: payload?.name, args: payload?.arguments, id: payload?.id });
      else if (ev === "tool_result") { const t = out.tools.find((x) => x.id === payload?.id); if (t) { t.result = payload?.text; t.isError = payload?.isError; } }
      else if (ev === "confirm_request") {
        out.confirms.push(payload);
        if (autoConfirm && payload?.id != null) {
          confirmCalls.push(fetch(BASE + "/api/chat/confirm", {
            method: "POST",
            headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ id: payload.id, approve: true }),
          }).catch(() => null));
        }
      }
      else if (ev === "error") out.errors.push(payload);
      else if (ev === "done" || ev === "end") out.done = payload;
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleChunk(chunk);
      }
    }
    // 修复：流结束时若最后一个事件没有以空行收尾，原实现把它留在 buf 里丢弃 ——
    // 恰好丢掉 done 事件时，测试会误判"回合未正常收束"。补一次收尾解析。
    if (buf.trim() !== "") handleChunk(buf);
  } catch (error) {
    out.errors.push({ transport: String(error?.message ?? error) });
  } finally {
    clearTimeout(timer);
    if (confirmCalls.length > 0) await Promise.all(confirmCalls);
  }
  return out;
}

export const uid = () => Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 结束自起的服务器子进程，并等它真正退出后再返回。
 * 修复：测试脚本普遍写成 `try { process.kill(child.pid) } catch {}` 后立刻 `process.exit()`。
 * 在 Windows 上，被终止的子进程句柄仍在关闭过程中就退出进程，会让 libuv 的 async 句柄
 * 被二次关闭并触发
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 * 测试进程以 0xC0000409(STATUS_STACK_BUFFER_OVERRUN) 收尾 —— 断言全部通过，但 CI 读到的是"崩溃"。
 * 等服务进程发完 exit 事件再退出即可稳定复现为通过。
 */
export async function killChild(child, timeoutMs = 8000) {
  if (child == null || child.exitCode != null || child.signalCode != null) return;
  // 修复（子进程孤儿化）：Windows 上 child.kill() 只终止直接子进程，服务进程 spawn 出来的
  // MCP server（npx → node server.js 的孙进程）会全部变成孤儿，连跑多套件后残留几十个 node
  // 进程拖垮整机（表现为后续套件莫名其妙的 20s 超时）。这里在 Windows 上按**进程树**回收。
  if (process.platform === "win32" && child.pid != null) {
    try {
      const { spawnSync } = await import("node:child_process");
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch { /* 进程可能已退出 */ }
  }
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    child.once("exit", done);
    try { child.kill(); } catch { done(); }
  });
}
