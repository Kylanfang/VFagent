// 调试：打印线上实例实际暴露的工具名（不外显口令）
const BASE = "http://127.0.0.1:8790";
const U = process.env.VF_BOSS_U || "central";
const P = process.env.VF_BOSS_P ?? "vfletch-dev";
const r = await fetch(BASE + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: U, password: P }) });
const T = (await r.json()).token;
const L = await (await fetch(BASE + "/api/mcp/list", { headers: { authorization: "Bearer " + T } })).json();
const names = [];
for (const s of L.servers || []) {
  for (const t of s.tools || []) names.push(t.exposedName);
}
console.log("TOTAL", names.length);
for (const n of names) console.log(n);
