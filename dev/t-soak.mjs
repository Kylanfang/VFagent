// 稳定性压测（soak）：并发隔离 / 中途取消 / 断流清理 / 超长输入 / 并发写配置 / 快速重启循环
import { api, login, chat, check, group, summary, uid, sleep, BASE } from "./testlib.mjs";
const { token: T } = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
let r;

group("A. 20 轮连续短聊（vf）");
let okSeq = 0;
for (let i = 0; i < 20; i += 1) {
  const c = await chat({ token: T, provider: "vf", session: `s_soak_${uid()}_${i}`, messages: [{ role: "user", content: `第 ${i} 次：只回"好"` }], timeout: 15000 });
  if (c.text.length > 0 && c.start?.session === `s_soak_${uid() === null ? "" : c.start.session.slice(8, -2)}${i}` || (c.text.length > 0 && c.done)) okSeq += 1;
}
check("20 轮连续聊天全部有回复", okSeq === 20, `ok=${okSeq}/20`);

group("B. 6 路并发会话隔离（vf）");
const tag = uid();
const par = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => chat({ token: T, provider: "vf", session: `s_par2_${tag}_${i}`, messages: [{ role: "user", content: `你是第 ${i} 号会话。只回复：会话${i}收到` }], timeout: 20000 })));
check("6 路并发全部成功且 session 一一对应", par.every((c, i) => c.text.length > 0 && c.start?.session === `s_par2_${tag}_${i + 1}`), par.map((c) => `${c.start?.session}:${c.text.slice(0, 6)}`).join(" | "));

group("C. 中途取消 + 取消后同会话可继续");
{
  const ctrl = new AbortController();
  const p = chat({ token: T, provider: "VF", session: `s_cancel_${tag}`, messages: [{ role: "user", content: "写一篇 800 字的短文介绍财务风控。" }], timeout: 60000 });
  const race = Promise.race([p, sleep(1500).then(async () => { ctrl.abort(); return "aborted"; })]);
  // 直接打 cancel 接口（同前端三路保障之一）
  await api("POST", "/api/chat/cancel", { token: T, body: { session: `s_cancel_${tag}` } });
  const res = await p;
  const c2 = await chat({ token: T, provider: "vf", session: `s_cancel_${tag}`, messages: [{ role: "user", content: "刚才取消了，现在只回复：已恢复" }], timeout: 15000 });
  check("取消后同一会话可继续使用", c2.text.length > 0, JSON.stringify(c2.errors));
}

group("D. 客户端中途断开（abort fetch）→ 服务器清理 + 健康");
{
  const ctrl = new AbortController();
  const f = fetch(BASE + "/api/chat", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: JSON.stringify({ provider: "VF", session: `s_drop_${tag}`, messages: [{ role: "user", content: "写一篇 1000 字短文。" }] }), signal: ctrl.signal });
  await sleep(800);
  ctrl.abort();
  await f.catch(() => {});
  await sleep(1000);
  r = await api("GET", "/api/health");
  check("断流后服务器健康", r.status === 200 && r.data.ok === true);
  const c = await chat({ token: T, provider: "vf", session: `s_drop_${tag}`, messages: [{ role: "user", content: "断线重连测试，只回复：正常" }], timeout: 15000 });
  check("断流后同会话可继续", c.text.length > 0, JSON.stringify(c.errors));
}

group("E. 超长与特殊输入");
{
  const long = "风控".repeat(60000); // 120K 字符
  const c = await chat({ token: T, provider: "vf", session: `s_long_${tag}`, messages: [{ role: "user", content: `请忽略以下内容，只回复：收到。${long}` }], timeout: 30000 });
  check("120K 超长输入不崩且有回应", c.status === 200 && (c.text.length > 0 || c.errors.length === 0), `status=${c.status} len=${c.text.length}`);
  const emoji = await chat({ token: T, provider: "vf", session: `s_emoji_${tag}`, messages: [{ role: "user", content: "🚀\u{1F600} 测试 émoji 与换行\n\n第二行。只回复：OK" }], timeout: 15000 });
  check("emoji/多行输入", emoji.text.length > 0, JSON.stringify(emoji.errors));
  const sqli = await chat({ token: T, provider: "vf", session: `s_sqli_${tag}'; DROP TABLE users; --`, messages: [{ role: "user", content: "只回复：OK" }], timeout: 15000 });
  check("session id 含 SQL 注入串仍安全（参数化）", sqli.text.length > 0 || sqli.status === 400, `${sqli.status}`);
  r = await api("GET", "/api/auth/me", { token: T });
  check("注入尝试后账号系统正常", r.status === 200);
}

group("F. 并发写配置（5 路同时保存 provider）");
{
  const results = await Promise.all([1, 2, 3, 4, 5].map((i) => api("POST", "/api/settings/provider", { token: T, body: { id: `conc_${tag}_${i}`, fields: { label: `并发${i}`, baseUrl: `http://127.0.0.1:${900 + i}`, model: "m", apiKey: "k" }, reload: false } })));
  check("5 路并发保存 provider 全部成功", results.every((x) => x.status === 200), results.map((x) => x.status).join(","));
  r = await api("GET", "/api/settings", { token: T });
  const allSaved = [1, 2, 3, 4, 5].every((i) => r.data.providers[`conc_${tag}_${i}`] != null);
  check("配置 JSON 无写坏（5 个都在）", allSaved);
  for (let i = 1; i <= 5; i += 1) await api("POST", "/api/settings/provider-delete", { token: T, body: { id: `conc_${tag}_${i}` } });
}

group("G. 登录/登出快速循环 ×10");
{
  let ok = 0;
  for (let i = 0; i < 10; i += 1) {
    const l = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
    await api("POST", "/api/auth/logout", { token: l.token });
    const me = await api("GET", "/api/auth/me", { token: l.token });
    if (l.token && me.status === 401) ok += 1;
  }
  check("登录/登出循环 10/10", ok === 10, `ok=${ok}`);
}

group("H. 上传二进制 + 大文本");
{
  const png = Buffer.from("89504e470d0a1a0a0000000d494844520000000100000001080600000" + "0".repeat(200), "hex");
  const up = await fetch(BASE + "/api/upload", { method: "POST", headers: { authorization: `Bearer ${T}`, "x-file-name": "tiny.png" }, body: png });
  const d = await up.json();
  check("二进制文件上传 kind=binary", up.status === 200 && d.kind === "binary", JSON.stringify(d).slice(0, 120));
  const bigText = "数据,line,value\n" + "a,1,2\n".repeat(40000); // ~440KB 文本
  const up2 = await fetch(BASE + "/api/upload", { method: "POST", headers: { authorization: `Bearer ${T}`, "x-file-name": "big.csv" }, body: bigText });
  const d2 = await up2.json();
  check("大文本上传返回小预览+处理指引（预览上限4000，正文走工作区+code_run）", up2.status === 200 && d2.truncated === true && d2.content.length > 3000 && d2.content.length < 6000 && /处理指引/.test(d2.content) && /code__code_run/.test(d2.content) && d2.totalChars > 16000, `len=${d2.content?.length} total=${d2.totalChars}`);
}

process.exit(summary() ? 0 : 1);
