import { api, login } from "./testlib.mjs";
const { token: T } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
let r = await api("POST", "/api/admin/users", { token: T, body: { username: "demo_fin", password: "demo123456", display_name: "财务小李", role: "employee" } });
if (r.status !== 200) { const u = (await api("GET", "/api/admin/users", { token: T })).data.find((x) => x.username === "demo_fin"); await api("POST", `/api/admin/users/${u.id}/password`, { token: T, body: { password: "demo123456" } }); await api("POST", `/api/admin/users/${u.id}/status`, { token: T, body: { status: "active" } }); }
await api("POST", `/api/admin/users/${(await api("GET", "/api/admin/users", { token: T })).data.find((x) => x.username === "demo_fin").id}/department`, { token: T, body: { department: "财务部" } });
console.log("demo_fin ready");
