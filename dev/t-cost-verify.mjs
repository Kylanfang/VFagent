// 成本规则"变动口径"专项验证：长输出应触发、短输出不应触发
import { login, chat, check, group, summary, uid } from "./testlib.mjs";
const { token } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
group("成本规则变动口径");
let c = await chat({ token, provider: "VF", session: "s_cv_long", messages: [{ role: "user", content: "用代码打印斐波那契数列前 1500 项，每行一个，完整输出不要省略。" }], timeout: 120000 });
const longFlag = c.events.filter((e) => e.ev === "risk_event").length > 0;
check("长输出触发成本规则", longFlag, `risks=${JSON.stringify(c.events.filter(e=>e.ev==='risk_event'))}`);
c = await chat({ token, provider: "VF", session: "s_cv_short", messages: [{ role: "user", content: "用代码算一下 6 乘 7" }], timeout: 90000 });
const shortFlag = c.events.filter((e) => e.ev === "risk_event").length > 0;
check("短输出不触发", !shortFlag, JSON.stringify(c.events.filter(e=>e.ev==='risk_event')).slice(0,120));
process.exit(summary() ? 0 : 1);
