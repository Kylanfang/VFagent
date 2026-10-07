// V-Fletch 欢迎页快捷指令引擎：按真实使用数据（SQLite）实时生成建议
// 数据源优先级：开放风险 > 未完成待办 > 高频工具 > 最近会话 > 内置默认
// 无任何使用数据时回退到默认四张，保证欢迎页永远有卡片。
import { all, get } from "./db.mjs";

const TOOL_SUGGESTIONS = [
  {
    match: /(^|_)audit_|^audit/,
    title: "审计风控总览",
    prompt: "当前审计风控总览是什么情况？高风险告警有哪些？用图表展示风险分布",
  },
  {
    match: /web__search|web_search|bing|duckduckgo|web__fetch/,
    title: "联网查政策要点",
    prompt: "联网查一下最近关于研发费用加计扣除的政策要点，并整理成表格",
  },
  {
    match: /code__|python|run_code|execute/,
    title: "本地跑 Python 测算",
    prompt: "用 Python 计算一组等额本息还款的月供与总利息，本金 120 万，年利率 4.2%，30 年",
  },
  {
    match: /filesystem__(read|list|search)|(^|_)read_file|list_dir/,
    title: "汇总本地文件要点",
    prompt: "帮我汇总工作目录下最近的文件清单，并挑重点文件提炼要点",
  },
  {
    match: /media__|generate_image|image/,
    title: "生成审计配图",
    prompt: "为本周审计周报生成一张简洁的封面配图",
  },
  {
    match: /sequential|thinking/,
    title: "深度拆解复杂问题",
    prompt: "用分步推理帮我拆解：科创企业授信尽调应覆盖哪些特有风险点",
  },
];

const DEFAULTS = [
  { title: "审计风控总览 + 风险分布图", prompt: "当前审计风控总览是什么情况？高风险告警有哪些？用图表展示风险分布", tag: "推荐" },
  { title: "联网查政策并表格化", prompt: "联网查一下最近关于研发费用加计扣除的政策要点，并整理成表格", tag: "推荐" },
  { title: "本地跑 Python 测算", prompt: "用 Python 计算一组等额本息还款的月供与总利息，本金 120 万，年利率 4.2%，30 年", tag: "推荐" },
  { title: "列出审计任务与进度", prompt: "列出所有审计任务及其进度", tag: "推荐" },
  { title: "生成一张审计周报封面图", prompt: "为本周审计周报生成一张蓝白配色、含盾牌元素的简洁封面图", tag: "推荐" },
  { title: "检索企业知识库制度", prompt: "在企业知识库里查一下差旅报销的制度要求，并列出关键条款", tag: "推荐" },
  { title: "费用异常同比分析", prompt: "假设各部门本期与上期费用如下：财务部 120/98 万、采购部 80/110 万、技术部 150/140 万，做同比分析并用图表展示异常", tag: "推荐" },
  { title: "写一份合规自查清单", prompt: "为中小企业财务部门写一份季度合规自查清单，按风险等级分组，表格化输出", tag: "推荐" },
  { title: "科创企业授信风险拆解", prompt: "用分步推理帮我拆解：科创企业授信尽调应覆盖哪些特有风险点", tag: "推荐" },
];

// 会话标题清洗：去掉附件注入前缀、控制字符，按语义边界截断并加省略号（避免"继续：[附件文件：nasdaq-n"这种硬截断）
function cleanTitle(raw, max = 14) {
  let t = String(raw ?? "").replace(/\[附件文件：[^\]]*\]/g, " ").replace(/[\uFFFD\u0000-\u001F]/g, " ").replace(/\s+/g, " ").trim();
  if (t === "") return "";
  if (t.length <= max) return t;
  let cut = t.slice(0, max);
  const m = /^(.*?)[\s，。、；：,.;:()（）\-_/]+[^\s，。、；：,.;:()（）\-_/]*$/.exec(cut);
  if (m != null && m[1].length >= Math.floor(max / 2)) cut = m[1];
  return cut.trim() + "…";
}

/** offset：换一批时轮转候选池（候选池比展示数多，保证每次点击真的换） */
export function buildSuggestions({ limit = 4, offset = 0, userId = null } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 4, 1), 8);
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (out.length >= cap * 3 || seen.has(item.prompt)) return;
    seen.add(item.prompt);
    out.push(item);
  };

  // 修复（跨用户信息泄露）：下面四条查询原先完全不分租户 —— 任何用户的欢迎页都会把
  // **别人**的待办正文、会话标题、开放风险条数当成"猜你想问"渲染出来（多账号部署下等于
  // 一个随手可得的旁路信息泄露面）。现在统一按 userId 限定到本人（及无归属的系统会话）。
  const scoped = userId != null && String(userId) !== "";
  const uid = scoped ? String(userId) : null;
  const ownConv = scoped ? " AND (owner_user_id = ? OR owner_user_id IS NULL)" : "";
  const ownByConv = scoped
    ? " AND (conversation_id IN (SELECT id FROM conversations WHERE owner_user_id = ? OR owner_user_id IS NULL))"
    : "";
  const p = () => (scoped ? [uid] : []);

  // 1) 开放风险（风控产品的第一优先建议）
  try {
    const risks = get(`SELECT COUNT(*) c FROM risk_events WHERE status='open' AND level IN ('warning','critical')${ownByConv}`, ...p());
    if ((risks?.c ?? 0) > 0) {
      push({ title: `处置 ${risks.c} 条开放风险`, prompt: "列出当前所有待处置的风控事件，按严重程度排序并给出处置建议", tag: "风险" });
    }
  } catch {}

  // 2) 未完成待办
  try {
    const todos = all(`SELECT text FROM todos WHERE status != 'completed' AND text IS NOT NULL${ownByConv} ORDER BY updated_at DESC LIMIT 2`, ...p());
    for (const t of todos) {
      push({ title: `待办：${String(t.text).slice(0, 14)}`, prompt: `继续处理这条待办：${t.text}`, tag: "待办" });
    }
  } catch {}

  // 3) 高频工具（最多 2 条，保持多样性）
  try {
    const tools = all(`SELECT tool_name, COUNT(*) c FROM tool_calls WHERE 1=1${ownByConv} GROUP BY tool_name ORDER BY c DESC LIMIT 20`, ...p());
    let toolCount = 0;
    for (const row of tools) {
      if (toolCount >= 2) break;
      const tpl = TOOL_SUGGESTIONS.find((t) => t.match.test(row.tool_name));
      if (tpl != null) {
        push({ ...tpl, tag: `高频 ×${row.c}` });
        toolCount += 1;
      }
    }
  } catch {}

  // 4) 最近会话（继续话题，最多 1 条；跳过含无效编码字符的坏标题）
  try {
    const convs = all(
      `SELECT title FROM conversations WHERE title IS NOT NULL AND title NOT IN ('新对话','对话')${ownConv} ORDER BY started_at DESC LIMIT 6`,
      ...p(),
    );
    let convCount = 0;
    for (const c of convs) {
      const title = cleanTitle(c.title);
      if (title === "" || title === "…") continue;
      const before = out.length;
      push({ title: `继续：${title}`, prompt: `接着上次的话题「${cleanTitle(c.title, 40)}」继续，先简要回顾结论再往下推进。`, tag: "继续上次" });
      if (out.length > before) convCount += 1;
      if (convCount >= 2) break;
    }
  } catch {}

  // 5) 兜底默认
  for (const d of DEFAULTS) push(d);
  // 轮转：offset 每次 +cap，候选池环形取窗；池子比展示数大，保证"换一批"真的换
  if (out.length <= cap) return out;
  const start = ((Number(offset) || 0) * cap) % out.length;
  const rotated = [...out.slice(start), ...out.slice(0, start)];
  return rotated.slice(0, cap);
}
