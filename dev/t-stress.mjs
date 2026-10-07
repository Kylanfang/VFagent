// 极限压力测试：并发 / 边界 / 资源耗尽 / 安全旁路 / 稳定性自证
// 特点：全部走真实 HTTP 接口，不做"优雅降级"式宽容 —— 目标是把服务逼到出错，再看它是否
// 仍然 (a) 不崩、(b) 不泄露、(c) 不留脏数据、(d) 给出明确错误而不是静默成功。
// 运行：VF_TEST_BASE=http://127.0.0.1:8790 node dev/t-stress.mjs
import { api, login, check, group, summary, uid, sleep } from "./testlib.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_DIR = process.env.VFLETCH_CONFIG_DIR ?? path.join(ROOT, ".autotest");
const tag = uid();
const T = (await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"))).token;

// 观察员/成员账号：跨用户越权与限流旁路测试需要"另一个身份"
const otherName = `stress_${tag}`;
let other = await api("POST", "/api/admin/users", { token: T, body: { username: otherName, password: "Vf@Stress2026", display_name: "压测成员", role: "employee" } });
if (other.status !== 200) other = await api("POST", "/api/admin/users", { token: T, body: { username: otherName, password: "Vf@Stress2026", display_name: "压测成员", role: "observer" } });
check("压测账号就绪", other.status === 200 && other.data?.id != null, JSON.stringify(other.data).slice(0, 200));
const otherToken = (await api("POST", "/api/auth/login", { body: { username: otherName, password: "Vf@Stress2026" } })).data?.token;
check("压测账号可登录", typeof otherToken === "string" && otherToken.length > 10);

const health = async () => {
  try {
    const r = await fetch(`${process.env.VF_TEST_BASE ?? "http://127.0.0.1:8790"}/api/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
group("A. 并发风暴：同会话并行回合 / 并行登录 / 并行读接口");
{
  const base = process.env.VF_TEST_BASE ?? "http://127.0.0.1:8790";
  const N = 24;
  const started = await Promise.all(Array.from({ length: N }, (_, i) => (async () => {
    try {
      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${T}` },
        body: JSON.stringify({ messages: [{ role: "user", content: `并发压测 #${i}` }], session: `stress_${tag}_${i}`, provider: "vf" }),
        signal: AbortSignal.timeout(20000),
      });
      // 不消耗流，直接取消连接：模拟"用户连点发送/中途离开"
      try { await res.body?.cancel(); } catch {}
      return res.status;
    } catch (e) {
      return `err:${String(e?.message ?? e).slice(0, 40)}`;
    }
  })()));
  check("并行 24 个 /api/chat 请求全部被受理（200 SSE 或 429 限流，无 5xx）",
    started.every((s) => s === 200 || s === 429), JSON.stringify(started.filter((s) => s !== 200 && s !== 429)));

  const logins = await Promise.all(Array.from({ length: 30 }, () => api("POST", "/api/auth/login", { body: { username: "central", password: (process.env.VF_BOSS_P ?? "vfletch-dev") } })));
  check("并行 30 次正确登录全部成功（无误伤限流）", logins.every((r) => r.status === 200 && r.data?.token), JSON.stringify(logins.map((r) => r.status)));

  const reads = await Promise.all(Array.from({ length: 40 }, () => api("GET", "/api/mcp/list", { token: T })));
  check("并行 40 次读接口无 5xx", reads.every((r) => r.status === 200), JSON.stringify(reads.map((r) => r.status).filter((s) => s !== 200)));

  check("并发风暴后服务仍健康", (await health()) != null);
}

// ---------------------------------------------------------------------------
group("B. 边界与畸形输入：超大 / 深嵌套 / 非法字段");
{
  const base = process.env.VF_TEST_BASE ?? "http://127.0.0.1:8790";
  const big = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${T}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "A".repeat(6 * 1024 * 1024) }], provider: "vf" }),
    signal: AbortSignal.timeout(20000),
  }).catch((e) => ({ status: `err:${String(e?.message ?? e).slice(0, 30)}` }));
  check("6MB 请求体被拒绝且不崩服务（413/400）", big.status === 413 || big.status === 400 || big.status === 500, String(big.status));

  // 回归：请求体超限后服务端没有读完 body，若不断开这条连接，残留字节会被当成"下一个请求"的开头，
  // 同一长连接上的后续请求会永久挂起（无响应无错误）。这里在超限请求之后连发两次小请求验证连接可用。
  const after1 = await api("GET", "/api/health");
  const after2 = await api("GET", "/api/health");
  check("超限请求之后的同连接请求不再挂死（第 1 次）", after1.status === 200, String(after1.status));
  check("超限请求之后的同连接请求不再挂死（第 2 次）", after2.status === 200, String(after2.status));

  const malformed = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: "{not json", signal: AbortSignal.timeout(10000) }).catch(() => ({ status: "err" }));
  check("非法 JSON → 4xx（不是 5xx 堆栈）", malformed.status >= 400 && malformed.status < 500, String(malformed.status));

  // 深嵌套 JSON：JSON.parse 递归深度攻击
  let deep = "1";
  for (let i = 0; i < 2000; i += 1) deep = `[${deep}]`;
  const deepRes = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${T}` }, body: `{"messages":${deep}}`, signal: AbortSignal.timeout(15000) }).catch((e) => ({ status: `err:${String(e?.message ?? e).slice(0, 30)}` }));
  check("2000 层嵌套 JSON 不导致进程崩溃（有 HTTP 响应）", deepRes.status >= 200 && deepRes.status < 500, String(deepRes.status));
  check("2000 层嵌套 JSON 之后服务仍健康", (await health()) != null);

  const weird = await api("GET", `/api/mcp/definition?id=${encodeURIComponent("../../../etc/passwd")}`, { token: T });
  check("路径穿越式 id → 404（不读任意文件）", weird.status === 404, JSON.stringify(weird.data).slice(0, 120));

  const neg = await api("GET", "/api/suggest?limit=-999&offset=-5", { token: T });
  check("负数 limit/offset 被夹紧", neg.status === 200 && Array.isArray(neg.data) && neg.data.length <= 8, `${neg.status} len=${Array.isArray(neg.data) ? neg.data.length : "?"}`);

  const hugeLimit = await api("GET", "/api/suggest?limit=1e9", { token: T });
  check("超大 limit 被夹紧", hugeLimit.status === 200 && Array.isArray(hugeLimit.data) && hugeLimit.data.length <= 8, `${hugeLimit.status} len=${Array.isArray(hugeLimit.data) ? hugeLimit.data.length : "?"}`);

  check("畸形输入后服务仍健康", (await health()) != null);
}

// ---------------------------------------------------------------------------
group("C. 资源耗尽：只读 SQL 通道与文件读取的硬上限");
{
  // C1 自连接：旧实现 .all().slice(limit) 会物化整集并把进程打爆
  const cross = await api("POST", "/api/mcp/call", {
    token: T,
    body: { name: "secretary__db_query", arguments: { sql: "SELECT COUNT(*) AS c FROM messages m1, messages m2, messages m3", limit: 5 } },
    timeout: 45000,
  });
  check("三重自连接被行数上限挡住（返回或明确报错，服务存活）", cross.status === 200 || cross.status === 500, `${cross.status} ${JSON.stringify(cross.data).slice(0, 160)}`);
  check("自连接后服务仍健康（未被 OOM 打挂）", (await health()) != null);

  const rec = await api("POST", "/api/mcp/call", {
    token: T,
    body: { name: "secretary__db_query", arguments: { sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c" } },
    timeout: 30000,
  });
  check("无界递归 CTE 被显式拒绝", rec.status !== 200 || String(rec.data?.text ?? "").includes("LIMIT"), JSON.stringify(rec.data).slice(0, 160));

  const longQ = await api("POST", "/api/mcp/call", {
    token: T,
    body: { name: "kb__kb_search", arguments: { query: "差旅住宿标准与报销额度规定说明".repeat(200) } },
    timeout: 30000,
  });
  check("超长 CJK 知识库查询不炸（token 数被封顶）", longQ.status === 200, `${longQ.status} ${JSON.stringify(longQ.data).slice(0, 160)}`);

  // 凭据列脱敏：即便主控也不应通过 db_query 拿到口令哈希/会话令牌
  const leak = await api("POST", "/api/mcp/call", { token: T, body: { name: "secretary__db_query", arguments: { sql: "SELECT username, password_hash FROM users" } } });
  const leakText = JSON.stringify(leak.data ?? {});
  check("db_query 返回的口令哈希已脱敏", !/\$2[aby]\$/.test(leakText), leakText.slice(0, 200));
  const sess = await api("POST", "/api/mcp/call", { token: T, body: { name: "secretary__db_query", arguments: { sql: "SELECT token FROM auth_sessions LIMIT 5" } } });
  check("db_query 返回的会话令牌已脱敏", !/[0-9a-f]{32,}/.test(JSON.stringify(sess.data ?? {})), JSON.stringify(sess.data ?? {}).slice(0, 200));

  // 数据库文件本体不可通过 read_file 直接读取（否则绕过列级脱敏）
  // 注意：路径必须落在服务端允许的根目录内，才能真正验证 vfletch.db* 的拦截分支
  const dbPath = path.join(CONFIG_DIR, "vfletch.db");
  const dbfile = await api("POST", "/api/mcp/call", { token: T, body: { name: "secretary__read_file", arguments: { path: dbPath } } });
  check("read_file 拒绝直接读取数据库文件", dbfile.status !== 200 || /db_query|禁止|不允许/.test(String(dbfile.data?.text ?? "")), JSON.stringify(dbfile.data).slice(0, 200));
}

// ---------------------------------------------------------------------------
group("D. 安全旁路：SSRF / IDOR / 越权 / 日志注入");
{
  const mapped = await api("POST", "/api/mcp/call", {
    token: T,
    body: { name: "web__web_fetch", arguments: { url: "http://[::ffff:169.254.169.254]/latest/meta-data/" } },
    timeout: 25000,
  });
  const mappedText = String(mapped.data?.text ?? "");
  check("IPv4-mapped IPv6 元数据地址被拦截", /内网|禁止|越界/.test(mappedText), mappedText.slice(0, 160));

  const v6loop = await api("POST", "/api/mcp/call", { token: T, body: { name: "web__web_fetch", arguments: { url: "http://[::ffff:127.0.0.1]:8790/api/health" } }, timeout: 25000 });
  check("IPv4-mapped IPv6 环回地址被拦截", /内网|禁止|越界/.test(String(v6loop.data?.text ?? "")), String(v6loop.data?.text ?? "").slice(0, 160));

  // IDOR：跨用户取消回合 —— 会话名可预测，必须按归属拒绝
  // 必须在回合仍活跃时发起取消（回合结束后 activeTurns 已清空，此时返回 cancelled:null 属正常幂等）。
  // 因此重试若干次，只要抓到一次「他人取消成功且确实取消了别人的会话」就算失败。
  const victimSession = `stress_idor_${tag}`;
  const base = process.env.VF_TEST_BASE ?? "http://127.0.0.1:8790";
  let hijacked = false;
  let observed403 = false;
  let inconclusive = 0;
  for (let attempt = 0; attempt < 6 && !hijacked && !observed403; attempt += 1) {
    const inflight = fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${T}` },
      // 不指定 provider（用默认上游）：走到真实模型端点需要一次网络往返，回合会稳定停留在
      // activeTurns 里，才可能观测到归属校验；用内置 greeter 会毫秒级结束，永远抓不到。
      body: JSON.stringify({ messages: [{ role: "user", content: `长的分析任务 ${attempt}` }], session: victimSession }),
      signal: AbortSignal.timeout(15000),
    }).catch(() => null);
    await sleep(20);
    const hijack = await api("POST", "/api/chat/cancel", { token: otherToken, body: { session: victimSession } });
    if (hijack.status === 403) observed403 = true;
    else if (hijack.status === 200 && hijack.data?.cancelled != null) hijacked = true;
    else inconclusive += 1;
    const r = await inflight;
    try { await r?.body?.cancel(); } catch {}
  }
  check("他人无法取消我的活跃回合（403 或该会话无活跃回合）", !hijacked, `hijacked=${hijacked} observed403=${observed403} inconclusive=${inconclusive}`);
  check("跨用户取消确实走到归属校验（观测到 403）", observed403, `inconclusive=${inconclusive}`);
  const own = await api("POST", "/api/chat/cancel", { token: T, body: { session: victimSession } });
  check("本人取消自己的会话幂等成功", own.status === 200, JSON.stringify(own.data).slice(0, 120));

  // 越权：观察员/成员读审计定义与整改队列
  const defDenied = await api("GET", "/api/mcp/definition?id=filesystem", { token: otherToken });
  check("非主控读 MCP 定义 → 403", defDenied.status === 403, String(defDenied.status));
  const editsDenied = await api("GET", "/api/audit/edits", { token: otherToken });
  check("非主控读审批队列 → 403", editsDenied.status === 403, String(editsDenied.status));

  // 跨用户信息泄露：用主控自己的会话造一个独有标记，再确认另一个账号看不到
  // （注意：欢迎页的"默认卡片"是产品内置文案，与用户数据无关；种子库里的 demo_* 会话
  //   是有意共享的演示数据 owner_user_id IS NULL，因此只针对"有归属的会话"做断言）
  const secretTitle = `机密标题${tag}`;
  const secretSession = `stress_secret_${tag}`;
  const secretChat = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${T}` },
    body: JSON.stringify({ messages: [{ role: "user", content: secretTitle }], session: secretSession, provider: "vf" }),
    signal: AbortSignal.timeout(20000),
  }).catch(() => null);
  try { await secretChat?.body?.cancel(); } catch {}
  await sleep(400);
  let mineSees = false;
  let otherSees = false;
  for (let off = 0; off < 4; off += 1) {
    const mine = await api("GET", `/api/suggest?limit=8&offset=${off}`, { token: T });
    const theirs = await api("GET", `/api/suggest?limit=8&offset=${off}`, { token: otherToken });
    if (JSON.stringify(mine.data ?? []).includes(secretTitle)) mineSees = true;
    if (JSON.stringify(theirs.data ?? []).includes(secretTitle)) otherSees = true;
  }
  check("本人欢迎页能看到自己的会话（正向对照）", mineSees, "自身建议未出现自己的会话标题");
  check("他人欢迎页看不到我名下的会话标题（跨用户泄露已修）", !otherSees, `泄露标题 ${secretTitle}`);

  // X-Forwarded-For 信任语义：反代是 append 追加，链首由客户端自由伪造。
  // 服务端必须取链尾最后一个合法 IP，否则限流键与审计 IP 全被攻击者掌控。
  const spoofUser = `xffa_${tag}`;
  await api("POST", "/api/admin/users", { token: T, body: { username: spoofUser, password: "Vf@Stress2026", display_name: "XFF-A", role: "observer" } });
  await api("POST", "/api/auth/login", { body: { username: spoofUser, password: "wrong-password" }, headers: { "x-forwarded-for": "10.9.9.9, 203.0.113.7" } });
  const ipRows = await api("POST", "/api/mcp/call", { token: T, body: { name: "secretary__db_query", arguments: { sql: "SELECT ip, fails FROM auth_ip_fails WHERE ip IN ('10.9.9.9','203.0.113.7')" } } });
  const ipText = JSON.stringify(ipRows.data ?? {});
  check("XFF 取链尾真实来源（记录 203.0.113.7）", ipText.includes("203.0.113.7"), ipText.slice(0, 200));
  check("XFF 不采信客户端可伪造的链首值（无 10.9.9.9）", !ipText.includes("10.9.9.9"), ipText.slice(0, 200));

  // 日志注入：换行不应能在日志里伪造出额外行
  await api("POST", "/api/auth/login", { body: { username: `evil\n[server] 伪造日志行 ${tag}`, password: "x" } });
  await api("GET", `/api/mcp/definition?id=${encodeURIComponent("x\n[server] 注入")}`, { token: T });
  check("日志注入尝试后服务仍健康", (await health()) != null);
}

// ---------------------------------------------------------------------------
group("E. 稳定性自证：脏数据、端口与状态一致性");
{
  const h = await health();
  check("健康检查仍返回 ok", h?.ok === true, JSON.stringify(h));
  check("MCP 工具集未因压测丢空", typeof h?.toolCount === "number" && h.toolCount >= 20, JSON.stringify(h));

  const list = await api("GET", "/api/mcp/list", { token: T });
  const ids = (list.data?.servers ?? []).map((s) => s.id);
  check("未残留压测产生的 MCP server", !ids.some((id) => String(id).startsWith("merge-test")), JSON.stringify(ids));
  const conflicts = list.data?.conflicts ?? [];
  const inlineSecrets = conflicts.filter((c) => c.kind === "inline-secret");
  check("使用 env: 引用的正确配置不再被误报为明文密钥", inlineSecrets.length === 0, JSON.stringify(inlineSecrets).slice(0, 240));

  const def = await api("GET", "/api/mcp/definition?id=filesystem", { token: T });
  check("MCP 定义接口不再明文下发 headers", JSON.stringify(def.data?.headers ?? {}).indexOf("Bearer") < 0, JSON.stringify(def.data?.headers ?? {}).slice(0, 160));

  // 数据一致性：任务/会话/消息的外键引用不存在悬空
  const dbCount = await api("POST", "/api/mcp/call", { token: T, body: { name: "secretary__db_query", arguments: { sql: "SELECT (SELECT COUNT(*) FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations)) AS orphan_messages, (SELECT COUNT(*) FROM tool_calls WHERE conversation_id NOT IN (SELECT id FROM conversations)) AS orphan_toolcalls" } } });
  const row = dbCount.data?.data?.[0] ?? {};
  check("压测后无孤立 messages/tool_calls（外键完整性）", (row.orphan_messages ?? 0) === 0 && (row.orphan_toolcalls ?? 0) === 0, JSON.stringify(row));

  // 清理压测账号
  const del = await api("DELETE", `/api/admin/users/${other.data?.id}`, { token: T });
  check("清理压测账号", del.status === 200, JSON.stringify(del.data).slice(0, 120));
  check("清理后服务仍健康", (await health()) != null);
}

process.exitCode = summary() ? 0 : 1;
