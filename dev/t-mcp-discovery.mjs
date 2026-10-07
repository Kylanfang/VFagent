// MCP 发现 + 审批安装 E2E：目录检索 → 成员提案 → 主控批准安装 / 驳回 / 草稿安装
// 角色说明：/api/mcp/call 为 staff 通道（成员经会话内 agent 调用，另由成员聊天 E2E 覆盖）
// 目录条目均已实测可连（excel/puppeteer 因开箱不可连已撤出目录，勿再回加）
import { api, login, chat, check, group, summary, uid, sleep } from "./testlib.mjs";
import { DatabaseSync } from "node:sqlite";
const tag = uid();
const boss = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const T = boss.token;
let r;

group("准备");
{
  const db = new DatabaseSync(new URL("../.autotest/vfletch.db", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  // 修复：测试直连库时没有 busy_timeout，而服务端每 30s 的 AIGC 扫描会持写锁，
  // 撞上时 SQLite 立刻返回 SQLITE_BUSY（`database is locked`）→ 整套件崩溃。
  // 服务端自己已设 busy_timeout=5000，测试侧的直连也必须同样设置。
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("DELETE FROM mcp_proposals");
  db.close();
}
check("历史提案清空", true);
r = await api("POST", "/api/admin/users", { token: T, body: { username: `disc_${tag}`, password: "dis123456", display_name: "发现测试员", role: "employee" } });
const memUser = r.data;
const mem = await login(`disc_${tag}`, "dis123456");
r = await api("POST", "/api/admin/users", { token: T, body: { username: `obs_${tag}`, password: "obs123456", display_name: "观察员甲", role: "employee" } });
const obsU = r.data;
await api("POST", `/api/admin/users/${obsU.id}/role`, { token: T, body: { role: "observer" } });
const obs = await login(`obs_${tag}`, "obs123456");
// 员工直调发现工具应被拒（toolView 剥离 + 路由双保险）
r = await api("POST", "/api/mcp/call", { token: mem.token, body: { name: "mcp_discovery__mcp_search", arguments: { query: "文件" } } });
check("员工直调发现通道 403（仅主控/观察员）", r.status === 403, String(r.status));

group("发现：目录检索（staff 通道）");
r = await api("POST", "/api/mcp/call", { token: obs.token, body: { name: "mcp_discovery__mcp_search", arguments: { query: "复杂任务 分步推理规划" } } });
check("检索命中 seq-think（未安装项可推荐）", r.status === 200 && !r.data.isError && /seq-think/i.test(r.data.text), r.data.text?.slice(0, 150));
r = await api("POST", "/api/mcp/call", { token: obs.token, body: { name: "mcp_discovery__mcp_search", arguments: { query: "读写文件" } } });
check("目录检索（filesystem 可推荐）", r.status === 200 && !r.data.isError, r.data.text?.slice(0, 120));
r = await api("POST", "/api/mcp/call", { token: obs.token, body: { name: "mcp_discovery__mcp_search", arguments: { query: "时区时间日期" } } });
check("CJK 检索（time 可推荐）", r.status === 200 && !r.data.isError && /time/i.test(r.data.text), r.data.text?.slice(0, 120));

group("提案：提交 / 幂等 / 越权");
r = await api("POST", "/api/mcp/call", { token: obs.token, body: { name: "mcp_discovery__mcp_propose", arguments: { id: "seq-think", reason: `复杂任务需要分步推理 ${tag}` } } });
check("观察员提交安装提案", r.status === 200 && /pending|已安装/.test(r.data.text ?? ""), r.data.text?.slice(0, 150));
r = await api("POST", "/api/mcp/call", { token: obs.token, body: { name: "mcp_discovery__mcp_propose", arguments: { id: "no_such_thing", reason: "x" } } });
check("目录外 id 提案 → 报错", r.data.isError === true, r.data.text?.slice(0, 120));
r = await api("GET", "/api/mcp/proposals", { token: T });
check("主控看到待审提案（含申请人）", r.status === 200 && r.data.proposals.some((p) => p.catalog_id === "seq-think" && p.requested_by === `obs_${tag}`), JSON.stringify(r.data).slice(0, 200));
r = await api("GET", "/api/mcp/proposals", { token: obs.token });
check("非主控不能看审批队列 403", r.status === 403);

group("批准 → 真实安装（seq-think 免密钥条目）");
r = await api("GET", "/api/mcp/proposals", { token: T });
const st = r.data.proposals.find((p) => p.catalog_id === "seq-think" );
check("seq-think 提案待审", st != null);
r = await api("POST", `/api/mcp/proposals/${st.id}/approve`, { token: T });
check("批准后自动安装", r.status === 200 && r.data.draft !== true, JSON.stringify(r.data).slice(0, 150));
r = await api("GET", "/api/mcp/list", { token: T });
check("安装后 mcp list 出现 seq-think 且已连接", r.data.servers?.some((s) => s.id === "seq-think" && s.status === "connected"), JSON.stringify(r.data.servers?.map((s) => [s.id, s.status])));

group("批准 → 草稿安装（brave-search 需密钥条目）");
r = await api("POST", "/api/mcp/call", { token: obs.token, body: { name: "mcp_discovery__mcp_propose", arguments: { id: "brave-search", reason: "要联网搜索" } } });
r = await api("GET", "/api/mcp/proposals", { token: T });
const bs = r.data.proposals.find((p) => p.catalog_id === "brave-search" );
check("brave-search 提案待审", bs != null);
r = await api("POST", `/api/mcp/proposals/${bs.id}/approve`, { token: T });
check("批准后落盘为停用草稿（不强制连接）", r.status === 200 && r.data.draft === true, JSON.stringify(r.data).slice(0, 150));
r = await api("GET", "/api/mcp/list", { token: T });
check("草稿状态为 disabled", r.data.servers?.some((s) => s.id === "brave-search" && s.status === "disabled"), JSON.stringify(r.data.servers?.map((s) => [s.id, s.status])));
r = await api("GET", "/api/mcp/definition?id=brave-search", { token: T });
check("主控可读草稿定义（env 为引用不落明文）", r.status === 200 && r.data.env?.BRAVE_API_KEY === "env:BRAVE_API_KEY", JSON.stringify(r.data?.env));
r = await api("GET", "/api/mcp/definition?id=brave-search", { token: obs.token });
check("观察员读定义 403", r.status === 403);
r = await api("POST", "/api/mcp/uninstall", { token: T, body: { id: "brave-search" } });
check("清理草稿", r.status === 200);

group("驳回路径");
r = await api("POST", "/api/mcp/call", { token: obs.token, body: { name: "mcp_discovery__mcp_propose", arguments: { id: "finance", reason: "要看行情" } } });
r = await api("GET", "/api/mcp/proposals", { token: T });
const fin = r.data.proposals.find((p) => p.catalog_id === "finance" );
check("finance 提案待审", fin != null);
r = await api("POST", `/api/mcp/proposals/${fin.id}/reject`, { token: T });
check("驳回提案", r.status === 200);
r = await api("GET", "/api/mcp/proposals", { token: T });
check("驳回后不在待审队列", !r.data.proposals.some((p) => p.id === fin.id));
r = await api("GET", "/api/mcp/list", { token: T });
check("驳回后未安装", !r.data.servers?.some((s) => s.id === "finance"));

group("清理（恢复初始状态）");
r = await api("POST", "/api/mcp/uninstall", { token: T, body: { id: "seq-think" } });
check("卸载 seq-think", r.status === 200, JSON.stringify(r.data).slice(0, 100));
for (const u of [memUser, obsU]) {
  r = await api("DELETE", `/api/admin/users/${u.id}`, { token: T });
  check(`删除测试账号 ${u.username}`, r.status === 200);
}
process.exit(summary() ? 0 : 1);
