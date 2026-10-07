// 并发写竞态：审计库并行编辑是否丢更新；记忆库并行保存是否丢条目
import { api, login, check, group, summary, uid } from "./testlib.mjs";
const { token: T } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const tag = uid();
let r;

group("A. 审计库 10 路并行编辑不同记录");
const audit = (await api("GET", "/api/audit/overview", { token: T })).data;
const n = Math.min(10, audit.employees.length);
const orig = audit.employees.map((e) => e.position);
// 并行 PUT：第 i 条记录岗位改为 POS_i
const results = await Promise.all(Array.from({ length: n }, (_, i) =>
  api("PUT", "/api/audit/record", { token: T, body: { key: "employees", action: "update", index: i, patch: { position: `POS_${tag}_${i}` } } })));
const after = (await api("GET", "/api/audit/overview", { token: T })).data;
let applied = 0;
for (let i = 0; i < n; i += 1) if (after.employees[i].position === `POS_${tag}_${i}`) applied += 1;
check(`并行编辑 ${n} 条全部生效（无丢更新）`, applied === n, `applied=${applied}/${n}`);
// 还原
await Promise.all(Array.from({ length: n }, (_, i) =>
  api("PUT", "/api/audit/record", { token: T, body: { key: "employees", action: "update", index: i, patch: { position: orig[i] } } })));

group("B. 记忆库 8 路并行保存");
await Promise.all(Array.from({ length: 8 }, (_, i) =>
  api("POST", "/api/mcp/call", { token: T, body: { name: "memory__memory_save", arguments: { key: `race/${tag}/${i}`, content: `并发记忆${i}` } } })));
// 验证方式：直接读 memory.json（memory_recall/search 受用户授权门控，直接调用会被拒绝——属隐私设计）
const { readFileSync } = await import("node:fs");
const memPath = new URL("../.autotest/memory.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const memJson = JSON.parse(readFileSync(memPath, "utf8"));
const entries = memJson.entries ?? memJson;
const getKey = (e) => (typeof e === "string" ? e : JSON.stringify(e));
let persisted = 0;
for (let i = 0; i < 8; i += 1) {
  if (getKey(entries).includes(`race/${tag}/${i}`) && getKey(entries).includes(`并发记忆${i}`)) persisted += 1;
}
check(`并行保存 8 条全部持久化（无丢写）`, persisted === 8, `persisted=${persisted}/8`);
group("C. 清理记忆");
for (let i = 0; i < 8; i += 1) await api("POST", "/api/mcp/call", { token: T, body: { name: "memory__memory_forget", arguments: { key: `race/${tag}/${i}` } } });
process.exit(summary() ? 0 : 1);
