import { login, chat, uid } from "./testlib.mjs";
const { token } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const q = "用你的只读工具查一下：系统里有几张数据表、当前有多少个用户账号、进程运行了多久。用表格回答。";
let ok = 0;
for (let i = 0; i < 3; i += 1) {
  const c = await chat({ token, provider: "VF", employee: "emp_secretary", session: "s_" + uid(), messages: [{ role: "user", content: q }], timeout: 120000 });
  const used = c.tools.filter((t) => String(t.name).startsWith("secretary__")).map((t) => t.name);
  const real = /ai_employees|auth_sessions|kb_docs/.test(c.text);
  console.log(`#${i + 1} tools=[${used.join(",")}] realTables=${real} text=${JSON.stringify(c.text.slice(0, 90))}`);
  if (used.length > 0 && real) ok += 1;
}
console.log(`工具真实率 ${ok}/3`);
