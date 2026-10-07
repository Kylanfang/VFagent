import { api, login, chat, check, group, summary, uid } from "./testlib.mjs";

const { token } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));

group("聊天基线：内置 vf 前台");
let r = await chat({ token, provider: "vf", session: "s_" + uid(), messages: [{ role: "user", content: "你好" }], timeout: 20000 });
console.log("   status", r.status, "start", JSON.stringify(r.start), "text", JSON.stringify(r.text.slice(0, 80)), "errors", JSON.stringify(r.errors), "done", JSON.stringify(r.done));
check("vf greeter 有回复", r.text.length > 0, JSON.stringify(r.errors));

for (const pid of ["VF", "deepseek-v4"]) {
  group(`聊天基线：真实模型 ${pid}`);
  const t0 = Date.now();
  r = await chat({ token, provider: pid, session: "s_" + uid(), messages: [{ role: "user", content: "只回复两个字：收到" }], timeout: 60000 });
  console.log(`   status ${r.status} ${Date.now() - t0}ms start=${JSON.stringify(r.start)} text=${JSON.stringify(r.text.slice(0, 120))} errors=${JSON.stringify(r.errors).slice(0, 400)} done=${JSON.stringify(r.done).slice(0, 200)} rawError=${JSON.stringify(r.rawError)}`);
  console.log("   事件类型序列:", r.events.map((e) => e.ev).join(","));
  check(`${pid} 有回复`, r.text.length > 0, JSON.stringify(r.errors));
}
summary();
