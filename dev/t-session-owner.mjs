// 会话归属契约回归（对应 2026-09-13 晚的"点推荐话题 → 无权访问该会话：会话属于其他用户"）
//
// 背景：服务端 ensureConversation 按 conversations.owner_user_id 做归属校验（AUTH-01），
// 是正确的安全控制；但前端默认会话 id 曾写死 "s1"，多账号共用同一中央库时后来者必然撞 403。
// 本套件把两件事都钉住：
//   A. 归属校验本身必须仍然生效（他人 session id → 403，不能被"改好用了"顺手放宽）
//   B. 每个账号用自己的唯一 id 必须能正常建会话（前端修复后的行为）
import { api, login, chat, check, group, summary, uid } from "./testlib.mjs";

const { token: T } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const tag = uid();
let r;

group("A. 他人 session id 必须被拒（AUTH-01 归属校验不能被放宽）");
const first = await chat({
  token: T, provider: "vf", session: `s_owner_${tag}`,
  messages: [{ role: "user", content: "归属测试：你好" }], timeout: 20000,
});
check("主控先创建该会话", first.text.length > 0 && first.start?.session === `s_owner_${tag}`, JSON.stringify(first.errors));

// 造一个"另一个账号"
r = await api("POST", "/api/admin/users", { token: T, body: { username: `own_${tag}`, password: "own123456", display_name: "归属测试员", role: "employee" } });
const other = r.data;
check("创建第二账号", r.status === 200 && other?.id != null, JSON.stringify(r.data).slice(0, 160));
let otherToken = null;
if (other?.id != null) {
  const lr = await login(`own_${tag}`, "own123456");
  otherToken = lr.token;
  check("第二账号可登录", typeof otherToken === "string" && otherToken.length > 0);
}

if (otherToken != null) {
  // 用别人的 session id 发消息 → 必须 403（同前端的"无权访问该会话：会话属于其他用户"）
  const stolen = await api("POST", "/api/chat", {
    token: otherToken,
    body: { provider: "vf", session: `s_owner_${tag}`, messages: [{ role: "user", content: "我是别人的账号" }] },
  });
  const errText = JSON.stringify(stolen.data ?? {});
  check("用他人 session id 聊天 → 403 且明确提示归属冲突", stolen.status === 403 && /属于其他用户|无权访问/.test(errText), `${stolen.status} ${errText.slice(0, 160)}`);

  group("B. 本账号唯一 id 必须能正常建会话（前端修复后的真实路径）");
  const mineId = `s_${tag}_mine`;
  const mine = await chat({ token: otherToken, provider: "vf", session: mineId, messages: [{ role: "user", content: "只回复：收到" }], timeout: 20000 });
  check("唯一 session id 正常建会话并回复", mine.text.length > 0 && mine.errors.length === 0, JSON.stringify({ status: mine.status, errors: mine.errors }).slice(0, 200));

  // 前端的 id 形态（newSessionId 生成）：账号前缀 + 时间戳 + 随机，绝不含 "s1" 这类全局固定值
  const generated = `s_own_${tag}_${Date.now().toString(36)}abcd`;
  const g2 = await chat({ token: otherToken, provider: "vf", session: generated, messages: [{ role: "user", content: "只回复：收到" }], timeout: 20000 });
  check("按 newSessionId 形态生成的 id 可用", g2.text.length > 0, JSON.stringify(g2.errors).slice(0, 160));

  // 清理：删账号
  await api("DELETE", `/api/admin/users/${other.id}`, { token: T });
}

process.exit(summary() ? 0 : 1);
