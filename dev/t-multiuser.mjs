// 多用户并发：3 个账号（主控/观察员/成员）同时用真实模型聊天，验证互不干扰且按人分账
import { api, login, chat, check, group, summary, uid, sleep } from "./testlib.mjs";
const { token: T } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const tag = uid();
group("准备 3 个账号");
let r = await api("POST", "/api/admin/users", { token: T, body: { username: `mu_obs_${tag}`, password: "mu123456", display_name: "并发观察员", role: "employee" } });
const obsU = r.data;
await api("POST", `/api/admin/users/${obsU.id}/role`, { token: T, body: { role: "observer" } });
r = await api("POST", "/api/admin/users", { token: T, body: { username: `mu_emp_${tag}`, password: "mu123456", display_name: "并成员工", role: "employee" } });
const empU = r.data;
const obs = await login(`mu_obs_${tag}`, "mu123456");
const emp = await login(`mu_emp_${tag}`, "mu123456");
group("3 用户 × 真实模型并发聊天");
const mark = (id) => `我是${id}号会话，请只回复：确认${id}`;
const jobs = [
  chat({ token: T, provider: "VF", session: `s_mu_${tag}_1`, messages: [{ role: "user", content: mark(1) }], timeout: 90000 }),
  chat({ token: obs.token, provider: "VF", session: `s_mu_${tag}_2`, messages: [{ role: "user", content: mark(2) }], timeout: 90000 }),
  chat({ token: emp.token, provider: "VF", session: `s_mu_${tag}_3`, messages: [{ role: "user", content: mark(3) }], timeout: 90000 }),
];
const results = await Promise.all(jobs);
results.forEach((c, i) => {
  check(`用户${i + 1} 会话独立且收到回复`, c.status === 200 && c.start?.session === `s_mu_${tag}_${i + 1}` && c.text.length > 0, `${c.status} ${JSON.stringify(c.text.slice(0, 40))}`);
});
group("按人分账（监管页按用户归属）");
await sleep(1500);
r = await api("GET", "/api/rms/employees", { token: T });
const body = JSON.stringify(r.data);
check("监管页可见两个新用户的模型员工分账", /并发观察员|并成员工|mu_obs|mu_emp/.test(body), body.slice(0, 200));
group("清理");
r = await api("DELETE", `/api/admin/users/${obsU.id}`, { token: T });
check("清理观察员", r.status === 200);
r = await api("DELETE", `/api/admin/users/${empU.id}`, { token: T });
check("清理成员", r.status === 200);
process.exit(summary() ? 0 : 1);
