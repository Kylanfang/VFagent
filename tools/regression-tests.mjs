// V-Fletch 定向回归测试（CodeX 评审缺陷修复验证）
// 运行：node tools/regression-tests.mjs   （隔离环境：临时 DB + 替身，不调真实模型）
// 覆盖：CTX-01/02（窗口收缩与成组裁剪）、MEM-01（并发授权上下文）、AUTH-01（会话归属）
import { mkdirSync, rmSync } from "node:fs";

const TMP = new URL("../.tmp-test-config/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(TMP, { recursive: true });
process.env.VFLETCH_CONFIG_DIR = TMP;

const results = [];
const check = async (id, name, fn) => {
  try {
    const detail = await fn();
    results.push({ id, name, pass: true, detail: detail ?? "" });
  } catch (e) {
    results.push({ id, name, pass: false, detail: String(e?.message ?? e) });
  }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ---- CTX-01：小窗口尊重原值，不再被放大 ----
const ctx = await import("../server/lib/context.mjs");
await check("CTX-01", "小窗口不被放大（8192 保持 8192）", async () => {
  assert(ctx.clampContextWindow(8192) === 8192, `8192 → ${ctx.clampContextWindow(8192)}`);
  assert(ctx.clampContextWindow(128000) === 128000, "128000 应保持");
  assert(ctx.clampContextWindow(null) === 300000, "缺省应为 300000");
  assert(ctx.clampContextWindow(5000000) === 1000000, "上限 1M");
  return "8192/128000/默认300k/上限1M 全部正确";
});

// ---- CTX-02：裁剪不产生孤立 tool 消息 ----
await check("CTX-02", "成组裁剪：tool 结果不与 assistant.tool_calls 分离", async () => {
  const big = "x".repeat(12000); // 每条约 8000 token
  const history = [{ role: "system", content: "sys" }];
  // u1 a1(tool_calls)+r1 | u2 a2(tool_calls)+r2 | u3 final
  history.push({ role: "user", content: `u1 ${big}` });
  history.push({ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] });
  history.push({ role: "tool", tool_call_id: "c1", content: `r1 ${big}` });
  history.push({ role: "user", content: `u2 ${big}` });
  history.push({ role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "t", arguments: "{}" } }] });
  history.push({ role: "tool", tool_call_id: "c2", content: `r2 ${big}` });
  history.push({ role: "user", content: "u3 final" });
  history.push({ role: "assistant", content: "done" });
  const r = ctx.trimHistoryToWindow(history, 30000); // 强触发裁剪
  const kept = r.history;
  // 每条 tool 消息前面必须能找到携带对应 tool_call_id 的 assistant
  const ids = new Set();
  for (const m of kept) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls)) m.tool_calls.forEach((c) => ids.add(c.id));
    if (m.role === "tool") assert(ids.has(m.tool_call_id), `孤立 tool 消息: ${m.tool_call_id}`);
  }
  assert(r.dropped > 0, "应发生裁剪");
  assert(kept[kept.length - 1].content === "done", "最后一条应保留");
  return `裁掉 ${r.dropped} 条，无孤立 tool 消息`;
});

// ---- MEM-01：并发上下文授权互不覆盖 ----
const rc = await import("../server/lib/run-context.mjs");
const mem = await import("../server/lib/memory.mjs");
await check("MEM-01", "并发轮次记忆授权互不覆盖", async () => {
  let consentAAfterB = null;
  await rc.runInContext({ userId: "A" }, async () => {
    mem.beginMemoryTurn("还记得我之前说过什么吗");
    assert(mem.memoryTurnConsent().recall === true, "A 应已授权");
    // 模拟并发：B 的轮次在 A 的上下文存活期间开启
    await rc.runInContext({ userId: "B" }, () => {
      mem.beginMemoryTurn("帮我算一道题");
      assert(mem.memoryTurnConsent().recall === false, "B 应未授权");
    });
    consentAAfterB = mem.memoryTurnConsent();
  });
  assert(consentAAfterB.recall === true, `B 轮次覆盖了 A 的授权（recall=${consentAAfterB.recall}）`);
  return "A 授权在 B 轮次之后仍保持";
});

// ---- AUTH-01：会话归属校验 ----
const rms = await import("../server/lib/rms.mjs");
await check("AUTH-01", "他人会话被拒绝", async () => {
  const conv = rms.ensureConversation({ conversationId: "conv_owner_A", employeeId: "emp_default", title: "A 的会话", ownerUserId: "u_A" });
  assert(conv === "conv_owner_A", "首次创建应成功");
  let rejected = false;
  try {
    rms.ensureConversation({ conversationId: "conv_owner_A", employeeId: "emp_default", ownerUserId: "u_B" });
  } catch {
    rejected = true;
  }
  assert(rejected, "用户 B 复用 A 的会话 id 未被拒绝");
  // 本人复用应成功（幂等）
  rms.ensureConversation({ conversationId: "conv_owner_A", employeeId: "emp_default", ownerUserId: "u_A" });
  return "B 被拒绝；A 本人幂等复用正常";
});

// ---- 汇总 ----
let pass = 0;
for (const r of results) {
  console.log(`${r.pass ? "✓" : "✗"} ${r.id} ${r.name}${r.detail ? " — " + r.detail : ""}`);
  if (r.pass) pass += 1;
}
console.log(`\n${pass}/${results.length} 通过`);
try { rmSync(TMP, { recursive: true, force: true }); } catch { /* SQLite 句柄延迟释放，临时目录留待下次覆盖 */ }
process.exit(pass === results.length ? 0 : 1);
