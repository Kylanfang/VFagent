import { readFileSync } from "node:fs";
const KEYS = (() => { try { return JSON.parse(readFileSync(new URL("../.autotest/keys.json", import.meta.url), "utf8")); } catch { return { qiyuan_key: process.env.QIYUAN_KEY ?? "", campus_key: process.env.CAMPUS_KEY ?? "" }; } })();
// 韧性场景：坏密钥供应商错误可见性 / 上下文钳制 / 部门派活展开 / 待办落库 / 异常请求体
import { api, login, chat, check, group, summary, uid, sleep, BASE } from "./testlib.mjs";
const { token: T } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const tag = uid();
let r;

group("A. 坏密钥供应商 → 错误对用户可见（不静默挂死）");
r = await api("POST", "/api/settings/provider", { token: T, body: { id: `badkey_${tag}`, fields: { label: "坏密钥", baseUrl: "https://api.qiyuanapi.cc/v1", model: "deepseek-v4", apiKey: "sk-invalid-key-xxx", supportsTools: true, supportsStream: true }, reload: false } });
check("创建坏密钥 provider", r.status === 200);
{
  const c = await chat({ token: T, provider: `badkey_${tag}`, session: `s_bad_${tag}`, messages: [{ role: "user", content: "只回复：收到" }], timeout: 90000 });
  check("坏密钥聊天返回 error 事件（模型端 401 透传给用户）", c.errors.length > 0 || c.rawError != null, JSON.stringify({ status: c.status, errors: c.errors, raw: c.rawError }).slice(0, 200));
  check("服务器在坏密钥错误后仍健康", (await api("GET", "/api/health")).status === 200);
}
r = await api("POST", "/api/settings/provider-delete", { token: T, body: { id: `badkey_${tag}` } });
check("清理坏密钥 provider", r.status === 200);

group("B. 上下文窗口钳制");
{
  const tiny = await chat({ token: T, provider: "vf", session: `s_clamp_${tag}`, messages: [{ role: "user", content: "只回复：OK" }], contextWindow: 50, timeout: 30000 });
  check("contextWindow 低于下限 → 钳制后正常工作", tiny.status === 200 && tiny.text.length > 0, JSON.stringify(tiny.rawError));
  const huge = await chat({ token: T, provider: "vf", session: `s_clamp2_${tag}`, messages: [{ role: "user", content: "只回复：OK" }], contextWindow: 99999999, timeout: 30000 });
  check("contextWindow 超上限 → 钳制后正常工作", huge.status === 200 && huge.text.length > 0, JSON.stringify(huge.rawError));
}

group("C. 部门派活展开（team:<id> → 成员接力）");
{
  // 两名员工各自绑一个自建 provider
  const mk = async (name) => {
    const pid = `w_${name}_${tag}`.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    await api("POST", "/api/settings/provider", { token: T, body: { id: pid, fields: { label: pid, baseUrl: "https://api.qiyuanapi.cc/v1", model: "deepseek-v4.1", apiKey: KEYS.qiyuan_key, supportsTools: true, supportsStream: true }, reload: false } });
    const e = await api("POST", "/api/team/employees", { token: T, body: { name, identity: "你是执行工，收到任务直接给结果。", providerId: pid } });
    return e.data;
  };
  // 死绑定防护：绑定不存在的 providerId → 400
  const badBind = await api("POST", "/api/team/employees", { token: T, body: { name: "死绑定", providerId: `nope_${tag}` } });
  check("绑定不存在的 API → 400 明确报错", badBind.status === 400 && /不存在/.test(badBind.data.error ?? ""), JSON.stringify(badBind.data));
  const w1 = await mk("jiagong");
  const w2 = await mk("yigong");
  check("两名执行工就绪", w1?.id && w2?.id, JSON.stringify([w1?.id, w2?.id]));
  r = await api("POST", "/api/team/teams", { token: T, body: { name: `接力组${tag}`, memberIds: [w1.id, w2.id] } });
  check("建接力组", r.status === 200 && r.data.id, JSON.stringify(r.data).slice(0, 120));
  const teamId = r.data.id;
  r = await api("POST", "/api/rms/tasks", { token: T, body: { title: `接力 ${tag}`, detail: "直接回复两个字：完成", assignees: [`team:${teamId}`] } });
  check("部门派活展开为成员（≤4 棒）", r.status === 200 && JSON.stringify(r.data.assignees ?? r.data).includes(w1.id), JSON.stringify(r.data).slice(0, 200));
  const task = r.data;
  r = await api("POST", `/api/rms/tasks/${task.id}/run`, { token: T });
  check("接力任务可触发执行", r.status === 200);
  let finalStatus = null;
  let lastStatus = "unknown";
  for (let i = 0; i < 24; i += 1) {
    await sleep(5000);
    const d = (await api("GET", `/api/rms/tasks/${task.id}`, { token: T })).data;
    lastStatus = String(d?.status ?? "null");
    if (d.status !== "running") { finalStatus = d.status; break; }
  }
  // 失败详情带最后观测状态：区分"跑太久（预算 120s 用尽）"与"确实卡在 running"
  check("接力任务最终完成", finalStatus != null && finalStatus !== "running", `finalStatus=${finalStatus} lastStatus=${lastStatus}`);
  // 解散 + 清理
  await api("POST", `/api/team/teams/${teamId}/disband`, { token: T });
  await api("POST", "/api/settings/provider-delete", { token: T, body: { id: `w_甲工_${tag}` } });
  await api("POST", "/api/settings/provider-delete", { token: T, body: { id: `w_乙工_${tag}` } });
}

group("D. 聊天 todo_write → 监管待办落库");
{
  const c = await chat({ token: T, provider: "VF", session: `s_todo_${tag}`, messages: [{ role: "user", content: "请用 todo_write 工具写一个 2 项的清单：1) 核对报表 2) 归档凭证，然后只回复：已记录。" }], timeout: 90000 });
  check("模型调用了 todo_write", c.tools.some((t) => /todo_write/.test(t.name)), c.tools.map((t) => t.name).join(","));
  await sleep(1000);
  r = await api("GET", `/api/rms/todos?conversation=${c.start?.session}`, { token: T });
  check("待办按会话落库", r.status === 200 && (r.data.length ?? r.data.todos?.length ?? 0) > 0, JSON.stringify(r.data).slice(0, 200));
}

group("E. 异常请求体（不崩即胜利）");
{
  const cases = [
    ["messages 非数组", { provider: "vf", session: `s_x1_${tag}`, messages: "hi" }],
    ["缺 messages", { provider: "vf", session: `s_x2_${tag}` }],
    ["message.content 非字符串", { provider: "vf", session: `s_x3_${tag}`, messages: [{ role: "user", content: { evil: true } }] }],
    ["session 为对象", { provider: "vf", session: { a: 1 }, messages: [{ role: "user", content: "hi" }] }],
  ];
  for (const [name, body] of cases) {
    const c = await chat({ token: T, provider: "vf", session: body.session, messages: body.messages, timeout: 30000 });
    const alive = (await api("GET", "/api/health")).status === 200;
    check(`${name} → 服务器存活且 4xx/正常`, alive && (c.status === 200 || c.status < 500), `status=${c.status}`);
  }
}

process.exit(summary() ? 0 : 1);
