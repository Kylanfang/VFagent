import { api, login, chat, check, group, summary, uid } from "./testlib.mjs";
import { readFileSync } from "node:fs";
const KEYS = (() => { try { return JSON.parse(readFileSync(new URL("../.autotest/keys.json", import.meta.url), "utf8")); } catch { return { qiyuan_key: process.env.QIYUAN_KEY ?? "", campus_key: process.env.CAMPUS_KEY ?? "" }; } })();

const boss = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const T = boss.token;
const tag = uid();

group("准备：创建成员 hmr_x 与管理层 obs_x");
let r = await api("POST", "/api/admin/users", { token: T, body: { username: `hmr_${tag}`, password: "hmr123456", display_name: "HMR 测试", role: "employee" } });
check("创建成员", r.status === 200, JSON.stringify(r.data));
const hmrUser = r.data;
r = await api("POST", "/api/admin/users", { token: T, body: { username: `obs_${tag}`, password: "obs123456", display_name: "管理层", role: "employee" } });
check("创建管理层账号(先 employee)", r.status === 200, JSON.stringify(r.data));
const obsUser = r.data;
r = await api("POST", `/api/admin/users/${obsUser.id}/role`, { token: T, body: { role: "observer" } });
check("升级为 observer", r.status === 200 && r.data.role === "observer", JSON.stringify(r.data));

const hmr = await login(`hmr_${tag}`, "hmr123456");
const obs = await login(`obs_${tag}`, "obs123456");

group("管理层(observer) 保存 API");
r = await api("POST", "/api/settings/provider", { token: obs.token, body: { id: `obsapi_${tag}`, fields: { label: "obs api", protocol: "openai-compatible", baseUrl: "http://gateway.example.com/v1", model: "Qwen3.5-122B-A10B", apiKey: KEYS.campus_key, supportsTools: true, supportsStream: true }, reload: false } });
check("observer 保存 provider 成功", r.status === 200 && r.data.ok, `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
r = await api("GET", "/api/settings", { token: obs.token });
check("observer 读取设置能看到新 provider", r.status === 200 && r.data.providers?.[`obsapi_${tag}`] != null, `${r.status}`);

group("成员(employee) 保存 API（通过设置接口应 403，通过团队自建 AI 员工应成功）");
r = await api("POST", "/api/settings/provider", { token: hmr.token, body: { id: `empapi_${tag}`, fields: { label: "x", baseUrl: "http://x", model: "m", apiKey: "k" } } });
check("employee 直接 /api/settings/provider → 403", r.status === 403, `${r.status}`);
r = await api("POST", "/api/team/employees", { token: hmr.token, body: { name: "HMR 测试", identity: "你是 HMR 测试员工，回答开头先说“HMR在线”。", providerFields: { label: "hmr-vf", baseUrl: "http://gateway.example.com/v1", model: "Qwen3.5-122B-A10B", apiKey: KEYS.campus_key } } });
check("employee 自建 AI 员工（带 API）成功", r.status === 200 && r.data?.id, `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
const emp = r.data;
console.log("   AI 员工:", JSON.stringify(emp));

group("成员列表可见且可调用（hmr 案例）");
r = await api("GET", "/api/team/employees", { token: hmr.token });
check("成员列表包含自己的 AI 员工", r.status === 200 && r.data.some((e) => e.id === emp?.id && e.mine), JSON.stringify(r.data).slice(0, 300));
const c = await chat({ token: hmr.token, provider: emp?.source_provider, employee: emp?.id, session: "s_" + uid(), messages: [{ role: "user", content: "你好，报一下你的身份" }], timeout: 60000 });
console.log(`   status=${c.status} start=${JSON.stringify(c.start)} text=${JSON.stringify(c.text.slice(0, 120))} errors=${JSON.stringify(c.errors)} raw=${JSON.stringify(c.rawError)}`);
check("成员用自建 AI 员工聊天有回复", c.text.length > 0, JSON.stringify(c.errors) + JSON.stringify(c.rawError));
check("身份设定生效（HMR在线）", /HMR/i.test(c.text), c.text.slice(0, 120));
// 前端 ChatView 员工视角发 provider 是 activeProvider（可能是 vf/或 boss 的 active）；模拟前端：provider 传 "vf" 但 employee 传自建员工
const c2 = await chat({ token: hmr.token, provider: "vf", employee: emp?.id, session: "s_" + uid(), messages: [{ role: "user", content: "你是谁" }], timeout: 60000 });
console.log(`   [前端模拟 provider=vf+employee] start=${JSON.stringify(c2.start)} text=${JSON.stringify(c2.text.slice(0, 100))} errors=${JSON.stringify(c2.errors)} raw=${JSON.stringify(c2.rawError)}`);
check("provider=vf + employee 绑定 → 实际走员工绑定的 API（不是 vf 前台）", c2.start?.provider === emp?.source_provider, JSON.stringify(c2.start));
// 不传 provider
const c3 = await chat({ token: hmr.token, employee: emp?.id, session: "s_" + uid(), messages: [{ role: "user", content: "你是谁" }], timeout: 60000 });
console.log(`   [不传 provider] start=${JSON.stringify(c3.start)} text=${JSON.stringify(c3.text.slice(0, 100))} raw=${JSON.stringify(c3.rawError)}`);
check("不传 provider + employee → 走员工绑定 API", c3.start?.provider === emp?.source_provider, JSON.stringify(c3.start) + JSON.stringify(c3.rawError));

group("provider 删除（M1）");
r = await api("POST", "/api/settings/provider-delete", { token: T, body: { id: `obsapi_${tag}` } });
check("删除 observer 建的 provider", r.status === 200 && r.data.ok, JSON.stringify(r.data));
r = await api("POST", "/api/settings/provider-delete", { token: T, body: { id: "nope_" + tag } });
check("删除不存在 provider → 4xx 而非 500", r.status >= 400 && r.status < 500, `${r.status} ${JSON.stringify(r.data)}`);
// 用**自建的合法 id** 供应商充当"当前 active"，而不是删共享配置里那个。
// 原因（2026-09-13）：测试实例的 active 常是历史遗留的非法 id（如 `GLM-4.6` —— 点号不在
// PROVIDER_ID_RE 允许字符集内）。非法 id **无法通过 API 复原**：saveProvider 会按规范派生 `glm_4_6`。
// 于是"删掉它再还原"必然把共享供应商改名/改丢，后续套件（t-deep 的 delegate_agent）就报"模型 baseUrl 为空"。
// 删除-回退逻辑本身与供应商是谁无关，用自建条目测同样有效，且不会污染环境。
const liveBefore = JSON.parse(readFileSync(new URL("../.autotest/model.json", import.meta.url), "utf8"));
const originalActive = (await api("GET", "/api/settings", { token: T })).data.active;
const ownActive = `tactive_${tag}`;
const campusTemplate = Object.values(liveBefore.providers ?? {}).find((p) => /^https?:/.test(String(p?.baseUrl ?? ""))) ?? {};
r = await api("POST", "/api/settings/provider", {
  token: T,
  body: { id: ownActive, fields: { ...campusTemplate, label: ownActive }, active: true, reload: false },
});
check("自建 active 供应商（合法 id）", r.status === 200 && r.data.ok, JSON.stringify(r.data).slice(0, 120));
const liveOwn = JSON.parse(readFileSync(new URL("../.autotest/model.json", import.meta.url), "utf8"));
check("能从活配置取到 active provider 的完整定义", typeof liveOwn.providers?.[ownActive]?.baseUrl === "string" && !!liveOwn.providers?.[ownActive]?.model, `active=${liveOwn.active} ${JSON.stringify(liveOwn.providers?.[ownActive])?.slice(0, 90)}`);
r = await api("POST", "/api/settings/provider-delete", { token: T, body: { id: ownActive } });
check("删除当前 active provider 后 active 自动回退", r.status === 200 && r.data.active && r.data.active !== ownActive, JSON.stringify(r.data));
const liveAfter = JSON.parse(readFileSync(new URL("../.autotest/model.json", import.meta.url), "utf8"));
const fb = liveAfter.providers?.[liveAfter.active];
check("回退目标可用（有 http baseUrl 与 model，不是空壳/演示应答器）", typeof fb?.baseUrl === "string" && /^https?:/.test(fb.baseUrl) && !!fb?.model, `active=${liveAfter.active} ${JSON.stringify(fb)?.slice(0, 90)}`);
check("自建条目已被删除，共享配置未受影响", liveAfter.providers?.[ownActive] == null && liveAfter.providers?.[originalActive] != null, `own=${ownActive} original=${originalActive} keys=${Object.keys(liveAfter.providers ?? {}).join(",")}`);
// 把 active 交还给原来的供应商，避免影响后续套件
if (originalActive != null && liveAfter.providers?.[originalActive] != null) {
  r = await api("POST", "/api/settings/active", { token: T, body: { id: originalActive } });
  check("把 active 交还原供应商", r.status === 200 && r.data.active === originalActive, JSON.stringify(r.data));
} else {
  check("把 active 交还原供应商", true, `（原 active=${originalActive} 已不存在，跳过）`);
}

group("清理");
r = await api("POST", "/api/settings/provider-delete", { token: T, body: { id: emp?.source_provider } });
check("删除员工自建 provider", r.status === 200, JSON.stringify(r.data));
for (const u of [hmrUser, obsUser]) {
  r = await api("DELETE", `/api/admin/users/${u.id}`, { token: T });
  check(`删除用户 ${u.username}`, r.status === 200, JSON.stringify(r.data));
}
summary();
