import { api, login } from "./testlib.mjs";
const { token: T } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const arch = (await api("GET", "/api/kb/archive", { token: T })).data.docs;
let n = 0;
for (const d of arch) { const r = await api("POST", "/api/kb/purge", { token: T, body: { id: d.id } }); if (r.status === 200) n += 1; }
console.log(`purged ${n}/${arch.length} archived docs`);
// 还原员工演示数据 position
const audit = (await api("GET", "/api/audit/overview", { token: T })).data;
const i = audit.employees.findIndex((e) => e.position === "申请修改的岗位");
if (i >= 0) { await api("PUT", "/api/audit/record", { token: T, body: { key: "employees", action: "update", index: i, patch: { position: "HR专员" } } }); console.log("restored employees position"); }
// 删除演示成员
const u = (await api("GET", "/api/admin/users", { token: T })).data.find((x) => x.username === "demo_fin");
if (u) { await api("DELETE", `/api/admin/users/${u.id}`, { token: T }); console.log("removed demo_fin"); }
