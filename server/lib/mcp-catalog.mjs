// MCP 目录库：经核验的常见 MCP server 目录（发现/提案制安装的数据源）。
// 所有 npm 包名已于 2026-09-11 在 registry 实名核验并逐条实测连接。
// 收录标准（实测教训）：① 包名真实存在；② 免密钥条目必须开箱即连（stdio 默认可用、
//   无首次巨量下载）—— excel(@negokaz) 静默挂起、puppeteer 首次下载浏览器内核超 60s，
//   均因此撤出目录，Office/浏览器场景由内置 code_run 覆盖；③ 需密钥条目走「草稿安装」。
// 目录只描述"能装什么"，真正安装必须走人工审批（提案路由），agent 无法绕过。
// 安装规格默认 npx 方式（mcp-manager 会把 Windows 的 npx 自动映射为 npx.cmd）。
// envKeys 非空的条目走「草稿安装」：批准后先落盘为停用，主控补齐密钥再启用。

const CATALOG = [
  // ---- 文件与代码 ----
  { id: "filesystem", name: "文件系统", category: "文件", description: "读写/搜索/管理指定目录内的本地文件", keywords: ["文件", "读写", "目录", "搜索文件", "本地"], spec: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "{{WORKSPACE}}"] }, envKeys: [] },
  { id: "github", name: "GitHub", category: "研发", description: "仓库/Issue/PR 查询与管理（需 GITHUB_PERSONAL_ACCESS_TOKEN）", keywords: ["github", "issue", "pr", "代码仓库", "版本"], spec: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }, envKeys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
  { id: "kubernetes", name: "Kubernetes 只读", category: "研发", description: "查询 K8s 集群工作负载与事件（只读模式）", keywords: ["k8s", "kubernetes", "集群", "容器"], spec: { transport: "stdio", command: "npx", args: ["-y", "mcp-server-kubernetes", "--readonly"] }, envKeys: [] },
  { id: "seq-think", name: "深度思考链", category: "通用", description: "结构化分步推理与动态规划（复杂任务先想清楚再动手）", keywords: ["思考", "推理", "规划", "分步", "反思", "复杂任务"], spec: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] }, envKeys: [] },
  // ---- 数据与检索 ----
  { id: "memory-graph", name: "知识记忆图", category: "数据", description: "基于知识图谱的长期记忆（实体/关系/事实）", keywords: ["记忆", "图谱", "知识", "长期"], spec: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }, envKeys: [] },
  { id: "brave-search", name: "联网搜索（Brave）", category: "数据", description: "联网搜索实时信息（需 BRAVE_API_KEY）", keywords: ["搜索", "联网", "实时", "资料"], spec: { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"] }, envKeys: ["BRAVE_API_KEY"] },
  // ---- 金融（对齐本系统风控场景） ----
  { id: "finance", name: "金融数据（Tushare）", category: "金融", description: "A股/港股/美股行情、三大报表、基金债券宏观（需 TUSHARE_TOKEN）", keywords: ["股票", "行情", "财报", "金融", "tushare", "报表"], spec: { transport: "stdio", command: "npx", args: ["-y", "finance-mcp"] }, envKeys: ["TUSHARE_TOKEN"] },
  // ---- 工具 ----
  { id: "time", name: "时间与时区", category: "工具", description: "查询当前时间/时区换算/日期间隔（系统内置零依赖实现）", keywords: ["时间", "时区", "日期", "日历", "当前时间"], spec: { transport: "stdio", command: "node", args: ["{{APP}}/server/mcp-time-stdio.mjs"] }, envKeys: [] },
];

export const MCP_CATALOG = CATALOG;

/** 按查询词匹配目录：命中关键词/名称/描述的条目按相关度排序（已安装可传入排除） */
export function searchCatalog(query, { excludeIds = [] } = {}) {
  const q = String(query ?? "").toLowerCase().trim();
  const terms = q.split(/[\s,，、]+/).filter((t) => t.length >= 2);
  const exclude = new Set(excludeIds);
  const scored = [];
  for (const entry of CATALOG) {
    if (exclude.has(entry.id)) continue;
    const name = entry.name.toLowerCase();
    const category = entry.category.toLowerCase();
    const description = entry.description.toLowerCase();
    const kws = (entry.keywords ?? []).map((k) => k.toLowerCase()).filter((k) => k.length >= 2);
    const hay = `${entry.id} ${name} ${category} ${description} ${kws.join(" ")}`;
    let score = 0;
    for (const t of terms) {
      if (name.includes(t)) score += 3;
      if (kws.some((k) => k.includes(t) || t.includes(k))) score += 3;
      if (description.includes(t)) score += 2;
      if (category.includes(t)) score += 1;
    }
    // CJK 友好：查询整句包含关键词/名称（如"查询时区时间"包含"时区"）也算命中
    if (q.length >= 2 && (kws.some((k) => q.includes(k)) || q.includes(name) || name.includes(q) && q.length >= 2)) score += 4;
    if (kws.some((k) => q.includes(k)) || terms.some((t) => hay.includes(t)) || q.includes(entry.name.toLowerCase())) {
      if (score > 0) scored.push({ id: entry.id, name: entry.name, category: entry.category, description: entry.description, keywords: entry.keywords, envKeys: entry.envKeys, risk: entry.risk ?? null, installHint: describeInstall(entry), score });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 6);
}

/** 目录条目 → 可读的安装方式说明 */
export function describeInstall(entry) {
  const spec = entry.spec ?? {};
  if (spec.transport === "http") return `HTTP 端点：${spec.url ?? ""}`;
  return `${spec.command} ${(spec.args ?? []).join(" ")}`.slice(0, 120);
}

/** 按 id 取目录条目（含完整安装规格） */
export function getCatalogEntry(id) {
  return CATALOG.find((e) => e.id === String(id ?? "").trim()) ?? null;
}
