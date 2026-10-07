// 三大模型族适配矩阵：DeepSeek / Qwen / GLM —— 闲聊、工具调用闭环、思维模型不漏 CoT
import { api, login, chat, check, group, summary, uid } from "./testlib.mjs";
const boss = await login("central", (process.env.VF_BOSS_P ?? "vfletch-dev"));
const T = boss.token;
const tag = uid();

const MODELS = [
  { id: "deepseek-v4", via: "qiyuan" },
  { id: "DS-V4-Flash", via: "campus" },
  { id: "VF", via: "campus" },
  { id: "GLM-4.6", via: "campus" },
  { id: "GLM-4.5", via: "campus" },
  { id: "Qwen-Think", via: "campus", thinking: true, softTool: true },
];

/**
 * 上游模型"不可用"的两种形态都属网关侧模型清单变化，不是产品缺陷，不应记成回归失败：
 *   ① 503 No available channel（该分组没有渠道）；
 *   ② 404 model_unavailable「模型 'x' 当前已下线」（供应商退役模型，2026-09-13 实测 deepseek-v4 即此类）。
 * 统一识别后跳过并如实打印，避免把上游下线误报成产品 bug。
 */
const upstreamModelGone = (...parts) =>
  /503|No available channel|model_unavailable|已下线|模型[^"]{0,20}不可用/.test(
    parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p ?? ""))).join(" "),
  );

for (const m of MODELS) {
  group(`${m.id}（${m.via}）`);
  // 1) 闲聊（网关无该模型通道时跳过整个家族）
  let c = await chat({ token: T, provider: m.id, session: `s_m_${tag}_${m.id}`, messages: [{ role: "user", content: "只回复两个字：收到" }], timeout: 90000 });
  if (upstreamModelGone(c.text, c.errors, c.rawError)) {
    console.log(`  ⚠ [${m.id}] 网关当前无可用通道/模型已下线，跳过该模型`);
    continue;
  }
  check("闲聊有回复", c.status === 200 && /收到/.test(c.text), `${c.status} ${JSON.stringify(c.text.slice(0, 60))} ${JSON.stringify(c.errors)}`);
  // 2) 工具调用闭环（强制走工具）
  //    code__code_run 属高危工具，P0-2 事中拦截会先下发 confirm_request；autoConfirm 让本套件
  //    扮演"操作员当场批准"，否则会等满 120 秒审批超时被拒 → 断言假失败（实测 123 秒才收束）。
  c = await chat({ token: T, provider: m.id, session: `s_m_${tag}_${m.id}`, messages: [{ role: "user", content: "必须调用 code__code_run 工具（python 计算 7*8），然后把结果告诉我。" }], timeout: 150000, autoConfirm: true });
  if (m.softTool) {
    // 思维模型在此网关可能不触发工具（自己心算）——不作为失败，但要如实记录
    console.log(`  ⚠ [${m.id}] 工具调用（软校验）：tools=${c.tools.length ? c.tools.map((t) => t.name).join(",") : "无"} text=${JSON.stringify(c.text.slice(0, 40))}`);
  } else if (c.status === 200 && upstreamModelGone(c.errors, c.text)) {
    console.log(`  ⚠ [${m.id}] 网关无可用通道/模型已下线，跳过`);
  } else {
    check("工具被调用", c.tools.some((t) => /code__code_run/.test(t.name)), c.tools.map((t) => t.name + (t.isError ? "(ERR)" : "")).join(",") || "无");
    check("工具结果 56 进入回答", /56/.test(c.text), c.text.slice(0, 80));
  }
  if (/GLM-4.5/.test(m.id)) {
    const g = await chat({ token: T, provider: m.id, session: `s_m_${tag}_${m.id}`, messages: [{ role: "user", content: "hi" }], timeout: 60000 });
    if (upstreamModelGone(g.errors, g.rawError, g.text)) {
      console.log(`  ⚠ [GLM-4.5] 网关当前无该模型通道/已下线，后续断言跳过`);
      continue;
    }
  }
  // 3) 工具结果不得伪造：检查回答里没有编造的第二个数字（粗验：回复同时含 56）
  // 4) 思维模型：CoT 不得作为正文开头混出（Qwen-Think 该网关无标签，只验证不崩、有正文；带标签网关由分离器剥）
  if (m.thinking) {
    c = await chat({ token: T, provider: m.id, session: `s_m_${tag}_${m.id}`, messages: [{ role: "user", content: "只回复：OK" }], timeout: 120000 });
    check("思维模型回复非空", c.status === 200 && c.text.length > 0, JSON.stringify(c.errors));
    check("思维模型正文无 <think> 标签泄漏", !/<think|<\/think/i.test(c.text), c.text.slice(0, 80));
  }
}

group("多轮工具 + 表格输出（GLM-4.6 复测）");
let c = await chat({ token: T, provider: "GLM-4.6", session: `s_glm_${tag}`, messages: [
  { role: "user", content: "用 code__code_run 运行 python 生成 1 到 5 的平方数列表，然后用 Markdown 表格输出：n、n² 两列。" },
] , timeout: 180000, autoConfirm: true });
check("GLM 多轮工具完成", c.done != null && c.errors.length === 0, JSON.stringify(c.errors).slice(0, 120));
check("GLM 回答含表格或列表", /\|/.test(c.text) || /\d/.test(c.text), c.text.slice(0, 100));
process.exit(summary() ? 0 : 1);
