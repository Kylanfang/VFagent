#!/usr/bin/env node
// V-Fletch 稳定性压测脚本（零依赖，node >= 20）
//
// 模式：
//   api  —— 混合打 /api/health /api/rms/overview /api/rms/rules /api/mcp/list /api/audit/overview，
//           模拟多人监管大屏 + 配置轮询（不消耗模型 token，可长时间运行）
//   chat —— 真实 /api/chat SSE 对话（走当前 active 模型，消耗 token！小规模冒烟用）
//
// 用法：
//   node tools/loadtest.mjs --target http://127.0.0.1:8787 --users 10 --minutes 30 --mode api
//   node tools/loadtest.mjs --target http://127.0.0.1:8787 --users 3 --minutes 10 --mode chat --token <访问令牌>
//
// 输出：每 30s 一行进度，结束时打印成功率 / P50 / P95 / P99 / SSE 完整率 / 错误分布。

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback;
};

const TARGET = opt("target", "http://127.0.0.1:8787").replace(/\/+$/, "");
const USERS = Math.max(1, Number(opt("users", 10)));
const MINUTES = Math.max(0.2, Number(opt("minutes", 30)));
const MODE = opt("mode", "api");
const TOKEN = opt("token", process.env.VFLETCH_ACCESS_TOKEN ?? "");
const HEADERS = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

const stats = {
  requests: 0, ok: 0, fail: 0,
  latencies: [],
  sseDone: 0, sseBroken: 0,
  errors: {},
};
const percentile = (p) => {
  if (stats.latencies.length === 0) return 0;
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const recordError = (tag) => { stats.errors[tag] = (stats.errors[tag] ?? 0) + 1; };

async function hitApi(userId) {
  const paths = [
    "/api/health",
    "/api/rms/overview",
    "/api/rms/rules",
    "/api/rms/employees",
    "/api/mcp/list",
    "/api/audit/overview",
  ];
  const path = paths[Math.floor(Math.random() * paths.length)];
  const t0 = Date.now();
  try {
    const res = await fetch(`${TARGET}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => ({}));
    const ms = Date.now() - t0;
    stats.requests += 1;
    stats.latencies.push(ms);
    if (res.ok && body.ok !== false) stats.ok += 1;
    else { stats.fail += 1; recordError(`${path} HTTP ${res.status}`); }
  } catch (e) {
    stats.requests += 1; stats.fail += 1;
    recordError(`${path} ${String(e?.message ?? e).slice(0, 40)}`);
  }
}

async function hitChat(userId, turn) {
  const t0 = Date.now();
  let firstDelta = null;
  let sawDone = false;
  try {
    const res = await fetch(`${TARGET}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", ...HEADERS },
      body: JSON.stringify({
        session: `loadtest_u${userId}_t${turn}`,
        employee: `emp_loadtest_u${userId}`,
        contextWindow: 300000,
        messages: [{ role: "user", content: `稳定性测试第${turn}轮：请只回复"OK"两个字，不要调用工具。` }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok || !res.body) { stats.fail += 1; recordError(`/api/chat HTTP ${res.status}`); return; }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (firstDelta == null && buf.includes("event: delta")) firstDelta = Date.now() - t0;
      if (buf.includes("event: done")) sawDone = true;
    }
    stats.requests += 1;
    stats.latencies.push(Date.now() - t0);
    if (firstDelta != null) stats.latencies.push(-firstDelta); // 负值=首字延迟样本
    if (sawDone) { stats.ok += 1; stats.sseDone += 1; }
    else { stats.fail += 1; stats.sseBroken += 1; recordError("/api/chat 流未收到 done"); }
  } catch (e) {
    stats.requests += 1; stats.fail += 1;
    recordError(`/api/chat ${String(e?.message ?? e).slice(0, 40)}`);
  }
}

async function userLoop(userId, deadline) {
  let turn = 0;
  const gap = MODE === "chat" ? 8000 + Math.random() * 6000 : 500 + Math.random() * 1500;
  while (Date.now() < deadline) {
    if (MODE === "chat") { await hitChat(userId, (turn += 1)); }
    else { await hitApi(userId); }
    await new Promise((r) => setTimeout(r, gap * (0.5 + Math.random())));
  }
}

const startedAt = Date.now();
const deadline = startedAt + MINUTES * 60_000;
console.log(`V-Fletch 压测：target=${TARGET} mode=${MODE} users=${USERS} minutes=${MINUTES}${TOKEN ? " (带令牌)" : ""}`);

const progressTimer = setInterval(() => {
  const elapsedMin = ((Date.now() - startedAt) / 60000).toFixed(1);
  const rate = stats.requests === 0 ? "-" : `${((stats.ok / stats.requests) * 100).toFixed(1)}%`;
  const latencyOnly = stats.latencies.filter((n) => n >= 0);
  const savedAll = stats.latencies; stats.latencies = latencyOnly;
  const p95 = percentile(95); stats.latencies = savedAll;
  console.log(`[${elapsedMin}min] 请求 ${stats.requests} · 成功率 ${rate} · P95 ${p95}ms` +
    (MODE === "chat" ? ` · SSE 完整 ${stats.sseDone}/${stats.sseDone + stats.sseBroken}` : ""));
}, 30_000);

await Promise.all(Array.from({ length: USERS }, (_, i) => userLoop(i + 1, deadline)));
clearInterval(progressTimer);

const firstByte = stats.latencies.filter((n) => n < 0).map((n) => -n);
const latency = stats.latencies.filter((n) => n >= 0);
const savedLatency = stats.latencies;
stats.latencies = latency;
console.log("\n========== 压测结果 ==========");
console.log(`总请求: ${stats.requests}  成功: ${stats.ok}  失败: ${stats.fail}`);
console.log(`成功率: ${stats.requests ? ((stats.ok / stats.requests) * 100).toFixed(2) : "-"}%`);
console.log(`延迟 P50/P95/P99: ${percentile(50)} / ${percentile(95)} / ${percentile(99)} ms`);
if (firstByte.length > 0) {
  stats.latencies = firstByte;
  console.log(`首字延迟 P50/P95: ${percentile(50)} / ${percentile(95)} ms`);
  stats.latencies = savedLatency;
}
if (MODE === "chat") {
  console.log(`SSE 完整率: ${stats.sseDone + stats.sseBroken ? ((stats.sseDone / (stats.sseDone + stats.sseBroken)) * 100).toFixed(1) : "-"}% (${stats.sseDone}/${stats.sseDone + stats.sseBroken})`);
}
const errorEntries = Object.entries(stats.errors).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log("错误分布:", errorEntries.length ? errorEntries.map(([k, v]) => `${k}×${v}`).join(" | ") : "无");
console.log(`时长: ${((Date.now() - startedAt) / 60000).toFixed(1)} 分钟（结果可作为“受控局域网负载测试”证据，请如实标注）`);
