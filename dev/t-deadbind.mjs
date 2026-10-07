import { api, login, chat, check, group, summary, uid } from "./testlib.mjs";
import { readFileSync } from "node:fs";
const KEYS = (() => { try { return JSON.parse(readFileSync(new URL("../.autotest/keys.json", import.meta.url), "utf8")); } catch { return { qiyuan_key: process.env.QIYUAN_KEY ?? "", campus_key: process.env.CAMPUS_KEY ?? "" }; } })();
const { token: T } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const tag = uid();
let r;
group("绑定失效员工的可见性与使用");
const pid = `tmp_${tag}`;
await api("POST", "/api/settings/provider", { token: T, body: { id: pid, fields: { label: pid, baseUrl: "https://api.qiyuanapi.cc/v1", model: "deepseek-v4.1", apiKey: KEYS.qiyuan_key, supportsTools: true, supportsStream: true }, reload: false } });
r = await api("POST", "/api/team/employees", { token: T, body: { name: "短命员工", providerId: pid } });
const emp = r.data;
check("建员工（绑定临时 provider）", r.status === 200 && emp.id, JSON.stringify(r.data).slice(0, 120));
r = await api("POST", "/api/settings/provider-delete", { token: T, body: { id: pid } });
check("删除该 provider", r.status === 200);
r = await api("GET", "/api/team/employees", { token: T });
const row = r.data.find((e) => e.id === emp.id);
check("员工列表标注 providerMissing", row != null && row.providerMissing === true, JSON.stringify(row).slice(0, 160));
const c = await chat({ token: T, employee: emp.id, provider: "VF", session: `s_dead_${tag}`, messages: [{ role: "user", content: "hi" }], timeout: 20000 });
check("用绑定失效的员工聊天 → 400 明确报错（不静默换模型）", c.status === 400 && /已被移除/.test(c.rawError?.error ?? ""), `${c.status} ${JSON.stringify(c.rawError)}`);
// 清理：删除员工记录（直接 SQL，测试环境）
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(new URL("../.autotest/vfletch.db", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
db.exec("PRAGMA busy_timeout = 5000;"); // 与 db.mjs 一致：避开服务端 30s AIGC 扫描持写锁的 SQLITE_BUSY
db.prepare("DELETE FROM ai_employees WHERE id = ?").run(emp.id);
db.close();
check("清理测试员工", true);
process.exit(summary() ? 0 : 1);
