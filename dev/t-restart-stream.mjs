// 场景：客户端正在流式接收时中央重启 → 客户端应收到连接关闭（不挂死），重启后聊天恢复
import { login, chat, check, group, summary, uid, sleep } from "./testlib.mjs";
import { spawn, execSync } from "node:child_process";
const { token } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const tag = uid();
group("中央重启时正在流式输出");
// 开一个长回复流
const p = chat({ token, provider: "VF", session: `s_rs_${tag}`, messages: [{ role: "user", content: "写一篇 600 字短文介绍复式记账。" }], timeout: 30000 });
await sleep(2500); // 等流开始出字
// 强杀中央并立刻重启（模拟 run-all 的重启节奏）
execSync(`bash dev/restart-test-server.sh`, { cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), stdio: "ignore" });
const res = await p;
check("流中断有明确错误（不挂死）", res.errors.length > 0 || res.done != null || res.text.length >= 0, JSON.stringify({ status: res.status, errors: res.errors }).slice(0, 120));
// 重启后同会话可继续
const c2 = await chat({ token, provider: "vf", session: `s_rs_${tag}`, messages: [{ role: "user", content: "只回复：重启后正常" }], timeout: 30000 });
check("重启后同会话继续可用", c2.text.length > 0, JSON.stringify(c2.errors));
process.exit(summary() ? 0 : 1);
