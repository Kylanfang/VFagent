import { api, login, chat, check, group, summary, uid, sleep } from "./testlib.mjs";
import { readFileSync } from "node:fs";
const KEYS = (() => { try { return JSON.parse(readFileSync(new URL("../.autotest/keys.json", import.meta.url), "utf8")); } catch { return { qiyuan_key: process.env.QIYUAN_KEY ?? "", campus_key: process.env.CAMPUS_KEY ?? "" }; } })();
const boss = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const { token: T } = boss;
const tag = uid();
let r;

group("准备观察员与任务");
r = await api("POST", "/api/admin/users", { token: T, body: { username: `ob_${tag}`, password: "ob123456", display_name: "观察员乙", role: "employee" } });
const obsU = r.data;
await api("POST", `/api/admin/users/${obsU.id}/role`, { token: T, body: { role: "observer" } });
r = await api("POST", "/api/admin/users", { token: T, body: { username: `em_${tag}`, password: "em123456", display_name: "成员丙", role: "employee" } });
const empU = r.data;
const obs = await login(`ob_${tag}`, "ob123456");
const emp = await login(`em_${tag}`, "em123456");

group("P0-B：observer 读用户名单 → 脱敏（无 IP/归属地）");
r = await api("GET", "/api/admin/users", { token: obs.token });
check("observer 仍可读名单（监管协作）", r.status === 200 && Array.isArray(r.data));
check("observer 视图不含 lastLoginIp/lastIpRegion", r.data.every((u) => u.lastLoginIp == null && u.lastIpRegion == null), JSON.stringify(r.data[0]).slice(0, 160));
check("observer 保留 lastSeen（在线判定）", r.data.every((u) => "lastSeen" in u));
r = await api("GET", "/api/admin/users", { token: T });
check("主控仍可见 IP/归属地", r.data.some((u) => u.lastLoginIp != null));

group("P1：observer 读 settings → 脱敏");
r = await api("GET", "/api/settings", { token: obs.token });
check("observer 视图无 configFile 绝对路径", r.data.configFile == null, String(r.data.configFile));
check("observer 视图 provider 无 baseUrl", Object.values(r.data.providers ?? {}).every((p) => p.baseUrl == null), JSON.stringify(Object.values(r.data.providers ?? {})[0]));
r = await api("GET", "/api/settings", { token: T });
check("主控视图仍含 baseUrl（可管理）", Object.values(r.data.providers ?? {}).some((p) => p.baseUrl));

group("P1：空 baseUrl 保存不抹掉原值（脱敏视图下可安全保存）");
r = await api("POST", "/api/settings/provider", { token: obs.token, body: { id: "VF", fields: { label: "VF", model: "Qwen3.5-122B-A10B" }, reload: false } });
check("observer 保存（无 baseUrl 字段）成功", r.status === 200, JSON.stringify(r.data).slice(0, 120));
r = await api("GET", "/api/settings", { token: T });
check("原 baseUrl 保留未丢", r.data.providers.VF?.baseUrl === "http://gateway.example.com/v1", r.data.providers.VF?.baseUrl);

group("P1：任务承接人与标题校验");
const mk = async (name) => {
  const pid = `as_${name}_${tag}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  await api("POST", "/api/settings/provider", { token: T, body: { id: pid, fields: { label: pid, baseUrl: "https://api.qiyuanapi.cc/v1", model: "deepseek-v4.1", apiKey: KEYS.qiyuan_key, supportsTools: true, supportsStream: true }, reload: false } });
  const e = await api("POST", "/api/team/employees", { token: T, body: { name, providerId: pid } });
  return e.data;
};
const workers = [];
for (const n of ["w1", "w2", "w3", "w4", "w5"]) workers.push(await mk(n));
check("5 名执行工就绪", workers.every((w) => w?.id), JSON.stringify(workers.map((w) => w?.id)));
r = await api("POST", "/api/rms/tasks", { token: T, body: { title: `超员 ${tag}`, detail: "x", assignees: workers.map((w) => w.id) } });
check("直接派 5 人 → 400 明确报错", r.status === 400 && /(1-4|上限 4)/.test(r.data.error ?? ""), JSON.stringify(r.data));
r = await api("POST", "/api/team/teams", { token: T, body: { name: `大组${tag}`, memberIds: workers.map((w) => w.id) } });
check("建 5 人部门", r.status === 200 && r.data.id, JSON.stringify(r.data).slice(0, 120));
r = await api("POST", "/api/rms/tasks", { token: T, body: { title: `部门超员 ${tag}`, detail: "x", assignees: [`team:${r.data.id}`] } });
check("部门展开超 4 → 400 明确报错（不再静默截断）", r.status === 400 && /上限 4/.test(r.data.error ?? ""), JSON.stringify(r.data));
r = await api("POST", "/api/rms/tasks", { token: T, body: { title: "长".repeat(300), detail: "x", assignees: [workers[0].id] } });
check("标题 >200 字 → 400", r.status === 400 && /200/.test(r.data.error ?? ""), JSON.stringify(r.data));

group("P2：任务删除（创建人/管理员）");
r = await api("POST", "/api/rms/tasks", { token: T, body: { title: `删除测试 ${tag}`, detail: "x", assignees: [workers[0].id] } });
const delTask = r.data;
r = await api("DELETE", `/api/rms/tasks/${delTask.id}`, { token: emp.token });
check("无关成员删除 → 403", r.status === 403, JSON.stringify(r.data));
r = await api("DELETE", `/api/rms/tasks/${delTask.id}`, { token: T });
check("主控删除任务", r.status === 200 && r.data.ok, JSON.stringify(r.data));
r = await api("GET", `/api/rms/tasks/${delTask.id}`, { token: T });
check("删除后 404", r.status === 404);
r = await api("DELETE", `/api/rms/tasks/nope`, { token: T });
check("删除不存在 → 404", r.status === 404);

group("mine 标注修正");
r = await api("GET", "/api/team/employees", { token: T });
const mineRows = r.data.filter((e) => e.owner_user_id != null);
check("staff 视图 mine 按归属标注（不再全 true）", mineRows.every((e) => e.mine === (e.owner_user_id === boss.user.id)), JSON.stringify(mineRows.slice(0, 2)).slice(0, 160));

group("清理");
for (const w of workers) await api("POST", "/api/settings/provider-delete", { token: T, body: { id: w.source_provider } });
for (const u of [obsU, empU]) await api("DELETE", `/api/admin/users/${u.id}`, { token: T });
process.exit(summary() ? 0 : 1);
