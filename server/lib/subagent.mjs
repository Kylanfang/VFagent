// 子代理运行器：主代理通过 delegate_agent 派发专职子任务
// 设计要点（对齐 LangGraph Supervisor / Claude Code Task 工具的实践）：
//   1. 独立上下文：子代理只拿到 role 提示词 + 任务 + 传入的背景资料，不继承主对话历史
//   2. 禁止递归：子代理工具集里不含 delegate_agent，也无法再派子代理
//   3. 工具白名单：默认无工具，需要时由主代理显式声明（只开放只读类工具）
//   4. 只返回最终结论：子代理输出不直接展示给用户，由主代理汇总
import { createModelClient } from "./model.mjs";
import { activeProvider } from "./config.mjs";
import { warn } from "./util.mjs";

const SCOPE = "subagent";

export const SUBAGENT_ROLES = {
  researcher: {
    label: "资料检索",
    prompt:
      "你是资料检索专员。基于给定的背景材料与可用工具，找出与任务直接相关的信息，剔除噪声。" +
      "输出：要点列表（每条一句话）+ 信息来源（工具名或材料出处）。不要写建议，不要复述任务。",
  },
  analyst: {
    label: "数据测算",
    prompt:
      "你是财务/数据分析专员。基于给定数据做测算与对比，数字必须来自给定数据或工具返回，禁止编造。" +
      "输出：测算过程（关键公式或口径）+ 结果表（Markdown 表格）+ 结论一句话。",
  },
  writer: {
    label: "文档撰写",
    prompt:
      "你是办公文档撰写专员。把给定要点整理成可直接使用的正式文本。" +
      "输出结构：结论先行 → 分节说明（三级标题）→ 关键数据表格 → 风险提示与建议动作。语言精练、不寒暄。",
  },
  reviewer: {
    label: "结果复核",
    prompt:
      "你是复核专员。检查给定结果是否存在：事实错误、数字口径不一致、逻辑跳跃、遗漏关键信息、越权或不可逆动作未提示。" +
      "输出：问题清单（按严重程度排序，无问题也要明说“未发现问题”）+ 修改建议。只做审查，不要重写全文。",
  },
  general: {
    label: "通用执行",
    prompt: "你是通用执行专员。独立完成被委派的任务，输出最终结论，不要复述任务，不要询问澄清问题。",
  },
};

// 子代理允许使用的工具（只读类；不含 delegate_agent，杜绝递归）
const ALLOWED_TOOLS = new Set([
  "web_search",
  "web_fetch",
  "audit_overview",
  "audit_module",
  "audit_tasks",
  "audit_risk_alerts",
  "audit_compliance",
  "audit_heatmap",
]);

let builtinCache = null;
async function builtinTools() {
  if (builtinCache == null) {
    // 动态 import 避免与 builtin.mjs 形成模块初始化环
    const mod = await import("./builtin.mjs");
    builtinCache = new Map(mod.ALL_TOOL_DEFS.map((t) => [t.name, t]));
  }
  return builtinCache;
}

function toOpenAiTools(defs) {
  return defs.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema ?? { type: "object", properties: {} } },
  }));
}

/**
 * @param {object} opts
 * @param {string} opts.role        researcher | analyst | writer | reviewer | general
 * @param {string} opts.task        任务描述（必须自包含，子代理看不到主对话）
 * @param {string} [opts.context]   背景资料
 * @param {string[]} [opts.tools]   工具白名单（仅在 ALLOWED_TOOLS 内生效）
 * @param {number} [opts.maxRounds] 工具轮次上限
 */
export async function runSubAgent({
  role = "general",
  task,
  context = "",
  tools = [],
  maxRounds = 3,
  temperature,
  maxOutputTokens,
  signal,
}) {
  if (typeof task !== "string" || task.trim() === "") {
    throw new Error("delegate_agent: task 不能为空");
  }
  const roleDef = SUBAGENT_ROLES[role] ?? SUBAGENT_ROLES.general;
  const { provider, defaults } = activeProvider();

  const systemParts = [
    roleDef.prompt,
    "约束：你是被委派的子代理，不得委派或召唤其他代理；不向用户提问；只输出最终结论。",
  ];
  if (context && String(context).trim() !== "") {
    systemParts.push(`背景资料：\n${String(context).slice(0, 12000)}`);
  }

  const messages = [
    { role: "system", content: systemParts.join("\n\n") },
    { role: "user", content: String(task).slice(0, 12000) },
  ];

  const registry = await builtinTools();
  const wanted = (Array.isArray(tools) ? tools : [])
    .map((n) => String(n))
    .filter((n) => ALLOWED_TOOLS.has(n));
  const toolDefs = wanted.map((n) => registry.get(n)).filter(Boolean);
  const useTools = provider.supportsTools !== false && toolDefs.length > 0;

  const client = await createModelClient(provider);
  const rounds = Math.max(1, Math.min(Number(maxRounds) || 3, 5));
  let finalText = "";

  for (let round = 0; round <= rounds; round += 1) {
    let text = "";
    const calls = [];
    for await (const event of client.stream({
      messages,
      tools: useTools ? toOpenAiTools(toolDefs) : undefined,
      temperature: temperature ?? defaults.temperature,
      maxOutputTokens: maxOutputTokens ?? defaults.maxOutputTokens,
      signal,
    })) {
      if (event.type === "delta") text += event.text;
      else if (event.type === "tool_call") {
        calls.push({ id: event.id ?? `sub_${round}_${calls.length}`, name: event.name, arguments: event.arguments });
      }
    }

    if (calls.length === 0 || round === rounds) {
      finalText = text;
      break;
    }

    messages.push({
      role: "assistant",
      content: text,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      })),
    });

    for (const call of calls) {
      const def = registry.get(call.name);
      let out;
      try {
        if (def == null) throw new Error(`子代理不可使用该工具: ${call.name}`);
        // 执行期强制校验白名单（CodeX TOOL-01）：模型层过滤只影响展示，
        // 真正的授权在 dispatch 时复查——本轮未授权的工具一律拒绝执行。
        if (!wanted.includes(call.name)) {
          throw new Error(`工具未获本轮授权（白名单: ${wanted.length > 0 ? wanted.join(", ") : "空"}），已拒绝执行: ${call.name}`);
        }
        const value = await def.handler(call.arguments ?? {});
        out = typeof value === "string" ? value : JSON.stringify(value);
      } catch (error) {
        warn(SCOPE, "子代理工具失败", { name: call.name, error: String(error?.message ?? error) });
        out = `工具调用失败: ${String(error?.message ?? error)}`;
      }
      messages.push({
        role: useTools ? "tool" : "user",
        ...(useTools ? { tool_call_id: call.id } : {}),
        content: (out ?? "").slice(0, 8000),
      });
    }
  }

  return { role, label: roleDef.label, text: finalText, tools: wanted };
}
