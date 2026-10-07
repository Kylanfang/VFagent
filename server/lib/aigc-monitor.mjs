// AI 生成内容实时监测引擎
// 两个真实可计算的指标：
//  1) AI 生成率 —— aiLikeness()：中文统计特征启发式（模板短语密度/句长均匀度/结构化密度/口语标记缺失），
//     对用户输入与工作区文本文件打分（0~1）；助手输出按定义计 1.0。
//  2) 幻觉率 —— groundingCheck()：数值溯源。AI 结论中抽取数值主张（金额/百分比/倍数等），
//     在同会话"证据语料"（工具返回 + 用户输入）中匹配（含 ±3% 容差），匹配不到即视为无依据主张。
// 扫描为增量式（消息按 id 水位、文件按 mtime 水位），由 main.mjs 每 30s 驱动。
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { all, get, run } from "./db.mjs";

const SCOPE = "aigc";
const WORKSPACE_ROOT = process.env.VFLETCH_WORKSPACE ?? "<WORKSPACE>";
const TEXT_EXT = new Set([".md", ".txt", ".csv", ".json", ".html", ".log", ".svg"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES_PER_SCAN = 120;

// ---- AI 文本特征 ----
const TEMPLATE_PHRASES = [
  "综上所述", "总而言之", "总体而言", "值得注意的是", "需要指出的是", "值得一提的是",
  "首先", "其次", "再次", "最后", "此外", "与此同时", "在此基础上", "进一步来看",
  "赋能", "抓手", "闭环", "颗粒度", "对齐", "链路", "沉淀", "组合拳", "方法论", "底层逻辑",
  "一定程度上", "从.*角度", "多维度", "全方位", "体系化", "一站式", "可落地",
];
const CASUAL_MARKERS = ["哈哈", "嘿嘿", "嗯嗯", "哦哦", "？？", "！！", "。。。", "咱", "俺", "整不", "搞不", "麻烦你", "帮我看看", "谢啦", "栓Q"];

function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

/** 中文文本 AI 相似度：返回 {score: 0~1, markers: 命中特征} */
export function aiLikeness(text) {
  const s = String(text ?? "");
  if (s.trim().length < 24) return { score: 0, markers: ["文本过短不计"] };
  const lenK = s.length / 1000;
  const markers = [];

  // 1) 模板短语密度（每千字命中数，8 次/千字封顶）
  let templateHits = 0;
  for (const p of TEMPLATE_PHRASES) {
    const re = new RegExp(p, "g");
    templateHits += (s.match(re) ?? []).length;
  }
  const templateDensity = templateHits / Math.max(lenK, 0.05);
  markers.push(`模板短语 ${templateHits} 处（${templateDensity.toFixed(1)}/千字）`);

  // 2) 句长均匀度：AI 行文句长方差小（1 - 变异系数/0.9）
  const sentences = s.split(/[。！？!?\n；;]+/).map((x) => x.trim()).filter((x) => x.length >= 5);
  let uniform = 0.5;
  if (sentences.length >= 3) {
    const lens = sentences.map((x) => x.length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
    uniform = clamp01(1 - sd / mean / 0.9);
    markers.push(`句长均匀度 ${uniform.toFixed(2)}（${sentences.length} 句）`);
  }

  // 3) 结构化密度：标题/编号列表/加粗（每千字 6 处封顶）
  const structHits = (s.match(/(^|\n)#{1,4} |(^|\n)\d+[.、)] |(^|\n)[-*] |\*\*[^*]+\*\*/g) ?? []).length;
  const structDensity = structHits / Math.max(lenK, 0.05);
  markers.push(`结构化标记 ${structHits} 处（${structDensity.toFixed(1)}/千字）`);

  // 4) 口语标记缺失：人类随手输入常带口语/情绪标记
  let casualHits = 0;
  for (const c of CASUAL_MARKERS) casualHits += s.split(c).length - 1;
  const casualFree = casualHits === 0 ? 1 : Math.max(0, 1 - casualHits * 0.25);
  if (casualHits > 0) markers.push(`口语标记 ${casualHits} 处（降低 AI 判定）`);

  const score = clamp01(
    0.40 * clamp01(templateDensity / 8) +
      0.25 * uniform +
      0.20 * clamp01(structDensity / 6) +
      0.15 * casualFree,
  );
  return { score: Math.round(score * 100) / 100, markers };
}

// ---- 数值溯源（幻觉检测） ----
const NUM_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(万亿|亿|万|千元|元|%|个百分点|pp|倍|个|条|笔|次|人|家|天|小时|分钟|年|月|日)?/g;

function parseNum(raw) {
  return Number(raw.replace(/,/g, ""));
}

/** 剔除围栏代码块：SVG/图表 JSON/代码里的数字是绘图坐标，不是事实主张 */
function stripFences(s) {
  return String(s ?? "").replace(/```[\s\S]*?(?:```|$)/g, "");
}

/** 抽取数值主张（过滤年份与纯小序号噪声） */
function extractClaims(text) {
  const s = String(text ?? "");
  const claims = [];
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(s)) !== null) {
    const raw = m[1];
    const unit = m[2] ?? "";
    const v = parseNum(raw);
    if (!Number.isFinite(v)) continue;
    if (unit === "" && (v >= 1900 && v <= 2099)) continue; // 年份
    if (unit === "年" && (v >= 1900 && v <= 2099)) continue; // 年份（如 2024年）
    if (unit === "" && v >= 0 && v <= 9) continue; // 小序号
    const start = Math.max(0, m.index - 18);
    claims.push({
      raw: `${raw}${unit}`,
      value: v,
      unit,
      context: s.slice(start, m.index + m[0].length + 10).replace(/\n/g, " "),
    });
  }
  return claims;
}

/** 证据语料中的全部数值（含容差匹配依据） */
function corpusNumbers(corpus) {
  const out = [];
  let m;
  NUM_RE.lastIndex = 0;
  while ((m = NUM_RE.exec(corpus)) !== null) {
    const v = parseNum(m[1]);
    if (Number.isFinite(v)) out.push({ value: v, unit: m[2] ?? "" });
  }
  return out;
}

/** 幻觉检测：返回 {claims, ungrounded, rate, examples} */
export function groundingCheck(text, corpus) {
  const claims = extractClaims(stripFences(text));
  if (claims.length === 0) return { claims: 0, ungrounded: 0, rate: null, examples: [] };
  // 去空白后做包含匹配（"42.9 万" 与 "42.9万" 视为同一写法）
  const corpusText = String(corpus ?? "").replace(/,/g, "").replace(/\s+/g, "");
  const cNums = corpusNumbers(corpusText);
  const examples = [];
  let ungrounded = 0;
  for (const c of claims) {
    const normRaw = c.raw.replace(/,/g, "").replace(/\s+/g, "");
    let grounded = corpusText.includes(normRaw);
    if (!grounded && cNums.length > 0 && c.unit !== "") {
      grounded = cNums.some((n) => {
        if (n.value === 0 || n.unit !== c.unit) return false;
        const rel = Math.abs(n.value - c.value) / Math.abs(n.value);
        return rel <= 0.03;
      });
    }
    if (!grounded) {
      ungrounded += 1;
      if (examples.length < 5) examples.push({ claim: c.raw, context: c.context.slice(0, 80) });
    }
  }
  return { claims: claims.length, ungrounded, rate: Math.round((ungrounded / claims.length) * 100) / 100, examples };
}

// ---- 增量扫描 ----
function watermark(key, next) {
  if (next == null) return get("SELECT value FROM aigc_state WHERE key = ?", key)?.value ?? null;
  run("INSERT INTO aigc_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(next));
  return null;
}

/** 扫描新消息：用户消息打 AI 分，助手消息做数值溯源 */
function scanMessages() {
  const mark = Number(watermark("msg_watermark") ?? 0);
  const convs = new Map(all("SELECT id, employee_id FROM conversations").map((c) => [c.id, c.employee_id]));
  const empNames = new Map(all("SELECT id, name FROM ai_employees").map((e) => [e.id, e.name]));
  const convEmployee = new Map([...convs].map(([cid, eid]) => [cid, empNames.get(eid) ?? eid ?? "前台"]));

  const rows = all(
    `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at
     FROM messages m WHERE m.id > ? ORDER BY m.id`,
    mark,
  );
  if (rows.length === 0) return 0;

  // 证据语料：按时间序合并该会话的用户输入与工具返回（助手结论晚于其出现才被计入依据）
  const corpora = new Map(); // conversation_id -> {seq: [{at, text}], ...} 简化为按会话拉全量再按时间过滤
  const needConvs = [...new Set(rows.map((r) => r.conversation_id))];
  for (const cid of needConvs) {
    const userTexts = all(
      `SELECT content, created_at FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY id`,
      cid,
    );
    const toolTexts = all(
      `SELECT result, created_at FROM tool_calls WHERE conversation_id = ? AND is_error = 0 ORDER BY id`,
      cid,
    );
    corpora.set(
      cid,
      [
        ...userTexts.map((r) => ({ at: r.created_at, text: r.content })),
        ...toolTexts.map((r) => ({ at: r.created_at, text: typeof r.result === "string" ? r.result : JSON.stringify(r.result ?? "") })),
      ].sort((a, b) => (a.at < b.at ? -1 : 1)),
    );
  }

  let inserted = 0;
  let maxId = mark;
  for (const r of rows) {
    maxId = Math.max(maxId, r.id);
    const content = String(r.content ?? "");
    if (content.trim() === "") continue;
    const subject = convEmployee.get(r.conversation_id) ?? "前台";
    if (r.role === "user") {
      const { score, markers } = aiLikeness(content);
      if (content.length >= 24) {
        run(
          // OR IGNORE + (kind, message_id) 唯一索引：扫描中途失败（水位未推进）时下一轮
          // 会把同一批消息重新插一遍，导致事件表重复、生成率/幻觉率被重复样本放大。
          "INSERT OR IGNORE INTO aigc_events (kind, conversation_id, message_id, subject, ai_score, claims, ungrounded, detail) VALUES (?,?,?,?,?,?,?,?)",
          "user", r.conversation_id, r.id, subject, score, null, null,
          JSON.stringify({ excerpt: content.slice(0, 120), markers: markers.slice(0, 4) }),
        );
        inserted += 1;
      }
    } else {
      const corpus = (corpora.get(r.conversation_id) ?? [])
        .filter((x) => x.at <= r.created_at)
        .map((x) => x.text)
        .join("\n");
      const g = groundingCheck(content, corpus);
      run(
        "INSERT OR IGNORE INTO aigc_events (kind, conversation_id, message_id, subject, ai_score, claims, ungrounded, detail) VALUES (?,?,?,?,?,?,?,?)",
        "assistant", r.conversation_id, r.id, subject, 1.0, g.claims, g.ungrounded,
        JSON.stringify({ excerpt: content.slice(0, 120), examples: g.examples }),
      );
      inserted += 1;
    }
  }
  watermark("msg_watermark", maxId);
  return inserted;
}

/** 扫描工作区文本文件（逐文件 mtime 增量） */
function scanFiles() {
  let files = [];
  const walk = (dir, depth) => {
    if (files.length > 2000 || depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "$RECYCLE.BIN") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) {
        try {
          const st = statSync(p);
          if (st.size <= MAX_FILE_BYTES) files.push({ p, mtime: st.mtime });
        } catch {}
      }
    }
  };
  walk(WORKSPACE_ROOT, 0);

  // 修复：原实现用"全局最大 mtime 水位（file_watermark）"判定增量 —— 两个真实缺陷：
  //  ① 任何 mtime 早于水位的文件（时钟回拨、从旧备份/压缩包拷入并保留原时间戳）被**永久跳过**；
  //  ② 单次只处理按 mtime 倒序的前 120 个，水位却写成全局最大值，第 121 个之后的文件
  //     永远落在水位之下，同样再也不会被扫描。
  // 改为逐文件记录 mtime，只处理"时间戳变了"的文件，与文件新旧顺序无关且天然幂等。
  const changed = [];
  for (const f of files) {
    const rel = path.relative(WORKSPACE_ROOT, f.p);
    const iso = f.mtime.toISOString();
    if (watermark(`file:${rel}`) === iso) continue;
    changed.push({ ...f, rel, iso });
  }
  changed.sort((a, b) => b.mtime - a.mtime);
  const batch = changed.slice(0, MAX_FILES_PER_SCAN);

  let inserted = 0;
  for (const f of batch) {
    try {
      const text = readFileSync(f.p, "utf8");
      const { score, markers } = aiLikeness(text);
      run(
        "INSERT INTO aigc_events (kind, subject, ai_score, detail) VALUES (?,?,?,?)",
        "file", f.rel, score,
        JSON.stringify({ excerpt: text.slice(0, 120), markers: markers.slice(0, 4), bytes: text.length }),
      );
      inserted += 1;
      // 只在成功入库后推进该文件的水位，失败的文件下一轮会重试
      watermark(`file:${f.rel}`, f.iso);
    } catch {}
  }
  return inserted;
}

export function runAigcScan() {
  const n1 = scanMessages();
  const n2 = scanFiles();
  return n1 + n2;
}

// ---- 聚合视图 ----
export function aigcOverview() {
  const totals = get(`
    SELECT COUNT(*) AS events,
           SUM(CASE WHEN kind IN ('user','file') THEN 1 ELSE 0 END) AS checked,
           AVG(CASE WHEN kind IN ('user','file') THEN ai_score END) AS ai_rate,
           SUM(CASE WHEN kind = 'assistant' AND claims > 0 THEN 1 ELSE 0 END) AS with_claims,
           SUM(CASE WHEN kind = 'assistant' THEN ungrounded ELSE 0 END) AS ungrounded_total,
           SUM(CASE WHEN kind = 'assistant' THEN claims ELSE 0 END) AS claims_total,
           SUM(CASE WHEN kind = 'assistant' AND claims >= 2 AND ungrounded * 2 >= claims THEN 1 ELSE 0 END) AS need_review
    FROM aigc_events`) ?? {};
  // 口径统一：totals.aiRate 只对 user/file 求均值，趋势与分员工也必须用同一分母，
  // 否则趋势线把 assistant（ai_score 恒为 1.0）也算进去，必然系统性高于总览值，
  // 页面上会出现"总览 32%、趋势 61%"这种自相矛盾的读数。
  const trend = all(`
    SELECT substr(created_at, 1, 13) AS hour, COUNT(*) AS n,
           ROUND(AVG(CASE WHEN kind IN ('user','file') THEN ai_score END), 3) AS ai,
           ROUND(AVG(CASE WHEN claims > 0 THEN ungrounded * 1.0 / claims END), 3) AS hall
    FROM aigc_events GROUP BY hour ORDER BY hour DESC LIMIT 24`);
  const bySubject = all(`
    SELECT subject,
           COUNT(*) AS monitored,
           SUM(CASE WHEN kind IN ('user','file') THEN 1 ELSE 0 END) AS checked,
           ROUND(AVG(CASE WHEN kind IN ('user','file') THEN ai_score END), 3) AS ai_rate,
           SUM(CASE WHEN kind = 'assistant' THEN claims ELSE 0 END) AS claims,
           SUM(CASE WHEN kind = 'assistant' THEN ungrounded ELSE 0 END) AS ungrounded
    FROM aigc_events GROUP BY subject ORDER BY monitored DESC LIMIT 12`);
  const alerts = all(`
    SELECT kind, subject, claims, ungrounded, detail, created_at
    FROM aigc_events
    WHERE kind = 'assistant' AND claims >= 2 AND ungrounded * 2 >= claims
    ORDER BY id DESC LIMIT 10`);
  return {
    totals: {
      events: totals.events ?? 0,
      checked: totals.checked ?? 0,
      aiRate: totals.ai_rate ?? null,
      hallucinationRate: totals.claims_total > 0 ? Math.round((totals.ungrounded_total / totals.claims_total) * 1000) / 10 : null,
      needReview: totals.need_review ?? 0,
    },
    trend: trend.reverse(),
    bySubject,
    alerts: alerts.map((a) => {
      // 修复：detail 是写入侧 JSON.stringify 的产物，任何一行脏数据（历史版本/手工改库/写一半崩溃）
      // 都会让 JSON.parse 抛错并冒泡成 /api/aigc/overview 的 500 —— 整个监测页直接白屏。
      let detail = {};
      try {
        detail = JSON.parse(a.detail ?? "{}") ?? {};
      } catch {
        detail = { raw: String(a.detail ?? "").slice(0, 200) };
      }
      return { ...a, detail };
    }),
    method: {
      aiLikeness: "中文统计特征启发式：模板短语密度(40%) + 句长均匀度(25%) + 结构化密度(20%) + 口语标记缺失(15%)",
      hallucination: "数值溯源：AI 结论中的金额/百分比/数量主张，须在同会话工具返回或用户输入中找到（含 ±3% 容差），找不到计为无依据主张",
    },
  };
}
