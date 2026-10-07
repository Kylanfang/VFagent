import { createModelClient, textFallbackToolDirective, extractTextToolCall } from "./model.mjs";
import { warn, shortId } from "./util.mjs";
import { memoryDigest, beginMemoryTurn } from "./memory.mjs";
import { trimHistoryToWindow } from "./context.mjs";

// 工具结果送入模型上下文的截断上限（全文仍完整落库 SQLite 审计）
const TOOL_RESULT_CONTEXT_LIMIT = 6000;
function truncateForContext(text) {
  const s = String(text ?? "");
  if (s.length <= TOOL_RESULT_CONTEXT_LIMIT) return s;
  return `${s.slice(0, TOOL_RESULT_CONTEXT_LIMIT)}\n…(工具输出过长，已截断至 ${TOOL_RESULT_CONTEXT_LIMIT} 字符；完整内容已留痕监管档案)`;
}
// 429 不重试：上游是分钟级配额窗口且"失败次数也计入配额"，秒级退避必然再撞 429 并加剧雪崩——快速失败让用户稍后再试
const RETRYABLE_RE = /HTTP 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|network|socket hang up/i;
const MAX_RETRIES = 2;

// 模型流看门狗：60s 无任何数据（网关假死/长连接挂起）→ 中止并抛出可读错误，杜绝"输出卡死"
const STREAM_IDLE_TIMEOUT_MS = 60_000;
async function* streamWithWatchdog(client, request, signal) {
  // 修复：AbortSignal 上并没有 .abort() 方法，原实现的看门狗回调
  //   `request?.signal?.abort?.(...)` 因为 ?. 的静默短路而**永远是空操作** ——
  // 网关建立连接后不再吐数据（假死/被中间设备黑洞）时，流既不会超时也不会中止，
  // 整个回合无限挂起，前端只能一直转圈。改为派生一个内部 AbortController，
  // 把"外部取消"与"看门狗超时"两条路径合并到同一个 signal 上传给模型客户端。
  const controller = new AbortController();
  const forwardAbort = () => {
    try { controller.abort(new Error("用户已终止当前回合")); } catch {}
  };
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener?.("abort", forwardAbort, { once: true });

  let timer = null;
  let timedOut = false;
  const reset = () => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      try { controller.abort(new Error("模型流 60 秒无数据（看门狗中止）")); } catch {}
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  try {
    reset();
    for await (const event of client.stream({ ...request, signal: controller.signal })) {
      reset();
      yield event;
    }
  } catch (error) {
    if (timedOut) {
      throw new Error(`模型流 ${STREAM_IDLE_TIMEOUT_MS / 1000} 秒无数据（看门狗中止）：端点可能已假死，请重试或更换模型端点`);
    }
    throw error;
  } finally {
    if (timer != null) clearTimeout(timer);
    signal?.removeEventListener?.("abort", forwardAbort);
  }
}

const SCOPE = "chat";

// 身份：统一自称 V-Fletch 办公体，不提及任何第三方模型厂商/竞品架构名
const IDENTITY = [
  "【身份】你是 V-Fletch 办公体（V-Fletch Office Agent），面向财务与办公场景的桌面智能体。",
  "当被问到\u201c你是什么模型 / 基于什么技术 / 是不是某某模型 / 谁家的大模型\u201d时，统一回答：",
  "\u201c我是 V-Fletch 办公体，能力由当前接入的模型驱动。\u201d 可补充说明当前接入的模型名称（若用户已在设置中配置）。",
  "严禁提及或暗示任何第三方模型厂商、竞品公司名或其架构代号（例如 Claude、GPT、Gemini、DeepSeek、Qwen、Llama 等），",
  "也不要说\u201c我基于某某模型\u201d。若用户追问底层实现，就说\u201c底层模型可替换，由接入的模型决定\u201d，不展开厂商细节。",
].join("\n");

// 防假装完成 + 防循环（从顶级 Agent 实践提炼：Claude Code / OpenHands / SWE-agent 的共同反模式修复）
const ANTI_LOOP = [
  "【执行铁律——违反任何一条都算失败】",
  "1. 工具结果必须展示：每次工具调用返回结果后，必须在你的回复正文中完整呈现结果（表格/列表/数据），",
  "   绝不允许只说\u201c已生成/已完成\u201d而不展示内容。用户看不到工具返回——只有你输出的文字才是用户能看到的。",
  "2. 禁止重复调用：如果同一个工具已成功调用过且拿到了结果，不要再次调用。直接用已有结果构建回复。",
  "3. 一次到位：获得所需数据后，立刻在当前回复中格式化输出完整结果（Markdown 表格/图表/代码），",
  "   不要\u201c先确认目录\u2192再生成\u2192再读取\u2192再汇总\u201d这种四步绕路。有数据就输出，一步完成。",
  "4. 诚实报告：工具失败时明确说\u201c执行失败，原因是 XXX\u201d，不要假装成功或说\u201c数据已生成\u201d。",
  "5. 页面即交付：用户说\u201c在本页面生成/展示\u201d时，意思是在你的回复文本中直接输出结果，",
  "   不需要落盘文件。你的回复本身就是交付物。",
  "6. 不要自我设限：你拥有完整的工具执行能力（代码运行/文件读写/网络检索/审计数据），",
  "   不要说\u201c我无法做到\u201d或\u201c我只是前台助手\u201d——你就是 V-Fletch 办公体，有全部办公能力。",
].join("\n");

// 输出结构：结论先行 + 分点 + 表格 + 可视化（面向财务人员）
const OUTPUT_STYLE = [
  "【输出结构】（面向财务/审计人员，参考专业办公助手的排版）",
  "1. 结论先行：开头用 1–2 句给出核心结论或判断，不要寒暄。",
  "2. 分节说明：用三级标题（### ）分段，标题即要点；每段只讲一件事。",
  "3. 关键数据用表格：涉及多条目对比、明细、期初期末、同比环比时，用 Markdown 表格呈现。",
  "4. 涉及趋势/构成/对比/排名/风险分布时，必须在回答中嵌入图表代码块（见下），图表与文字互补而非重复。",
  "5. 风险与建议：末尾用“风险提示 / 建议动作”列出可执行的下一步，条目化。",
  "6. 金额统一带单位（万元/元/%），百分比保留 1–2 位小数；不要编造数字，数据缺失就明说。",
  "7. 可视化一律用代码块在本页直接渲染，禁止用 ASCII 字符画充当图表。",
  "图表代码块（单独一段，不要包在其他代码块里）：",
  "```chart",
  '{"type":"bar","title":"各部门费用对比","unit":"万元","labels":["财务部","采购部"],"datasets":[{"label":"本期","data":[120,80]}]}',
  "```",
  "type 可选 bar（柱）/ line（折线，可多组）/ pie（饼）/ heatmap（热力图）。",
  "heatmap 契约：labels 为列（维度），datasets 每组为一行（部门/主体），可选 scale:[0,100] 定色阶，示例：",
  "```chart",
  '{"type":"heatmap","title":"全公司风险维度热力图","unit":"分","scale":[0,100],"labels":["财务","IT","运营","合规"],"datasets":[{"label":"财务部","data":[85,60,65,60]},{"label":"技术部","data":[55,75,50,58]}]}',
  "```",
  "chart 表达不了的复杂图形（架构图/流程图/自定义热力图/示意图）用 ```svg 围栏输出纯 SVG 语法，",
  "页面会直接渲染成图（viewBox 自适应宽度，不要写 script/事件属性）：",
  "```svg",
  '<svg viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="200" fill="#f7f9fb"/><text x="20" y="40" font-size="16">示例</text></svg>',
  "```",
  "位图生成工具（image_generate）用于艺术类/示意类图片（封面/插画/海报/照片感画面），系统会自动选择可用生图通道，用户要求“画/生成一张图”时直接调用；",
  "调用成功后必须把返回的 path 用 ![描述](path) 写进回复正文；万一失败也不要降级成 ASCII 字符画，改用上面的 chart 或 svg 代码块交付并如实说明原因。",
].join("\n");

// 任务规划与多智能体协作（todo_write + delegate_agent）
const AGENT_BRAIN = [
  "【工作方式】",
  "A. 任务规划：遇到含 3 步以上的复杂请求，先用 todo_write 工具（注册名可能形如 agent__todo_write）写出任务清单",
  "   （每步一句话、可执行），再逐步执行；每完成一步立即更新状态（pending/in_progress/completed）。简单问题不要建清单。",
  "B. 委派子代理：可并行或相互独立的子任务（资料检索、数据测算、文档撰写、结果复核）用 delegate_agent 工具派给专职子代理，",
  "   委派时必须写清：目标、可用信息、期望输出格式、边界（不要做什么）。子代理结果不可见给用户，你必须汇总后再回答。",
  "C. 不要递归委派：子代理内部不会再派子代理，需要拆分就在本层拆。",
  "D. 工具优先：能查到真实数据就先查，再基于数据回答；查不到就如实说明。",
].join("\n");

// 记忆使用规范（隐私策略 v2：不记本机信息；检索需用户授权；默认不自动注入）
const MEMORY_USE = [
  "【记忆与隐私】",
  "- 保存：仅当用户主动透露长期事实（称谓、公司、项目、对接人、偏好）或与你确认约定/结论时才用 memory_save。",
  "  严禁保存与本机/系统环境相关的信息（文件路径、盘符、主机名、用户目录、硬件配置、操作系统、环境变量、IP 等），此类保存会被系统直接拒绝。",
  "- 检索：未经用户许可不得检索记忆库。只有当用户消息明确提及“之前/上次/还记得/记忆”等历史指涉时，才调用 memory_search / memory_recall；",
  "  否则应先询问用户是否需要参考历史记忆。",
  "- 系统不会每轮自动注入记忆摘要；需要历史背景时以用户授权的检索结果为准。",
  "- 记忆是跨会话的。保存时 key 用命名空间，如 user/称谓、项目/xx/对接人。",
].join("\n");

// 回答纪律：独立结论、敢于否定用户、置信度标注、不编造、不谄媚
const ANSWER_DISCIPLINE = [
  "【回答纪律】",
  "- 先核前提：用户的前提、数字或估计有误时立即指出；禁止任何铺垫式恭维（不说\u201c问得好/您说得对/很有意思\u201d）。",
  "- 独立结论：不照搬用户给出的数字与判断，先自行推演；与用户观点冲突时，除非对方给出新证据或更优论据，否则坚持结论并重申理由，不为意见相左道歉。",
  "- 标注置信度：关键判断附带置信度（高/中/低/未知）；不知道就直说\u201c不知道\u201d，严禁编造事实、数据、引用、人名、日期与例子。",
  "- 直陈负面：坏消息、负面结论、反驳意见直接给出，不加免责声明，不进行道德与伦理说教，不提醒\u201c考虑某事很重要\u201d。",
  "- 自我核对：输出前核对事实、数字与例子的一致性；发现自相矛盾立即修正并明说。准确性是唯一标准，用户的认可不是。",
].join("\n");

const DEFAULT_SYSTEM = [
  "你是 V-Fletch，一个面向办公场景的桌面智能体助手。",
  "风格：直接、简洁、不客套。能用工具解决就不要空谈。",
  "调用工具前先确认参数完整；工具失败时如实报告，不要假装成功。",
  "涉及发送、删除、支付、对外发布等不可逆动作，先向用户确认。",
  IDENTITY,
  ANSWER_DISCIPLINE,
  ANTI_LOOP,
  OUTPUT_STYLE,
  AGENT_BRAIN,
  MEMORY_USE,
].join("\n\n");

export function buildSystemPrompt(provider, tools) {
  const parts = [DEFAULT_SYSTEM];
  if (provider.supportsTools === false && tools.length > 0) {
    parts.push(textFallbackToolDirective(tools));
  }
  return parts.join("\n\n");
}

function assistantToolCalls(calls) {
  return {
    role: "assistant",
    content: "",
    tool_calls: calls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
    })),
  };
}

// ---- P0-2 事中拦截（高危工具人工闸门） ----
// 任意代码执行（code__ 服务）在"模型已决定调用、尚未执行"的窗口交给人工裁决：
// 超时/拒绝/无审批通道（委派任务等无人值守场景）一律不执行，模型会收到明确拒绝并可改道。
export const CONFIRM_REQUIRED_RE = /^code__/;
export const CONFIRM_TIMEOUT_MS = Number(process.env.VFLETCH_CONFIRM_TIMEOUT_MS ?? 120_000);
function refusalText(note) {
  return `【事中拦截】代码执行未获人工批准${note ? `（${note}）` : ""}，本次调用已被拒绝。请勿重复调用该工具；请改用无需执行代码的方式完成任务，或向用户说明用途，待用户在对话中批准后再试。`;
}
export async function confirmGate({ call, confirm, signal }) {
  if (!CONFIRM_REQUIRED_RE.test(String(call.name ?? ""))) return { approved: true };
  if (typeof confirm !== "function") return { approved: false, refusal: refusalText("无人值守上下文") };
  let decision;
  try {
    decision = await Promise.race([
      Promise.resolve(confirm({ id: call.id, tool: call.name, arguments: call.arguments })),
      new Promise((resolve) => {
        if (signal?.aborted) return resolve({ approved: false, note: "回合已终止" });
        signal?.addEventListener("abort", () => resolve({ approved: false, note: "回合已终止" }), { once: true });
      }),
    ]);
  } catch (error) {
    return { approved: false, refusal: refusalText(`审批通道异常：${String(error?.message ?? error).slice(0, 120)}`) };
  }
  if (decision != null && typeof decision === "object" && decision.approved === true) return { approved: true };
  const note = decision?.note ?? null;
  return { approved: false, refusal: refusalText(typeof note === "string" && note !== "" ? note : "人工拒绝") };
}

/**
 * 执行一轮会话：模型 → 工具 → 模型，直到没有工具调用或达到轮次上限。
 * 引擎：默认 LangGraph StateGraph 编排（chat-graph.mjs）；VFLETCH_AGENT_ENGINE=legacy
 * 或 langgraph 依赖不可用时，回退到下方内置回路。两套实现共用同一事件协议与返回契约。
 */
export async function runTurn(options) {
  const engine = process.env.VFLETCH_AGENT_ENGINE ?? "langgraph";
  if (engine === "legacy") return runTurnLegacy(options);
  try {
    const { runTurnGraph } = await import("./chat-graph.mjs");
    return await runTurnGraph(options);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      warn(SCOPE, "LangGraph 依赖缺失，回退 legacy 回路", { error: String(error?.message ?? error) });
      return runTurnLegacy(options);
    }
    throw error;
  }
}

async function runTurnLegacy({ messages, provider, defaults, mcp, contextWindow, identity, onEvent, confirm, signal }) {
  const client = await createModelClient(provider);
  // 修复：原实现 `provider.supportsTools === false ? [] : mcp.toOpenAiTools()` 会让 openAiTools 恒为空，
  // 于是下面"文本降级路径"的判据 `provider.supportsTools === false && openAiTools.length > 0` 永远为假
  // —— 不支持 function calling 的模型永远拿不到 tools 提示，文本工具协议成了死代码。
  const allTools = mcp.toOpenAiTools();
  const openAiTools = provider.supportsTools === false ? [] : allTools;
  const useTools = provider.supportsTools !== false && openAiTools.length > 0;

  // 记忆访问授权初始化：按本轮用户消息判定（未提及历史 → 检索类工具将拒绝执行）
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  beginMemoryTurn(typeof lastUser?.content === "string" ? lastUser.content : "");

  const history = [
    {
      role: "system",
      // 文本降级协议需要看到完整工具清单（openAiTools 在降级时是空的，必须传 allTools）
      content: identity
        ? `${buildSystemPrompt(provider, provider.supportsTools === false ? allTools : openAiTools)}

【身份设定】${identity}`
        : buildSystemPrompt(provider, provider.supportsTools === false ? allTools : openAiTools),
    },
    ...messages,
  ];

  // 记忆摘要注入（默认关闭；开启方式：model.json defaults.memoryAutoInject = true）
  if (defaults.memoryAutoInject === true) {
    const memConnected = (mcp.servers ?? []).some((s) => s.id === "memory" && s.status === "connected");
    if (memConnected) {
      const digest = memoryDigest(6, 140);
      if (digest !== "") {
        history[0] = { role: "system", content: `${history[0].content}\n\n${digest}` };
      }
    }
  }

  // 上下文窗口裁剪（300k–1M 用户可选）：超出预算的早期消息省略并插入说明
  const trimmed = trimHistoryToWindow(history, contextWindow);
  if (trimmed.dropped > 0) {
    history.length = 0;
    history.push(...trimmed.history);
    onEvent({ type: "context_trimmed", dropped: trimmed.dropped, usedTokens: trimmed.usedTokens, windowTokens: trimmed.windowTokens });
  }

  const maxRounds = defaults.maxToolRounds ?? 40;
  // 同轮工具去重缓存（见工具执行处）：key=工具名+参数，值=成功结果文本
  const turnCallCache = new Map();
  let finishReason = "stop";

  for (let round = 0; round < maxRounds; round += 1) {
    // 每轮重新裁剪：工具结果会持续追加进 history，只在入口裁一次的话长任务仍会在中途冲破窗口
    if (round > 0) {
      const re = trimHistoryToWindow(history, contextWindow);
      if (re.dropped > 0) {
        history.length = 0;
        history.push(...re.history);
        onEvent({ type: "context_trimmed", dropped: re.dropped, usedTokens: re.usedTokens, windowTokens: re.windowTokens });
      }
    }
    let text = "";
    const calls = [];
    let attempt = 0;
    let finishReasonThisRound = "stop";
    let usageThisRound = null;

    for (;;) {
      let produced = false;
      try {
        for await (const event of streamWithWatchdog(client, {
          messages: history,
          tools: useTools ? openAiTools : undefined,
          temperature: defaults.temperature,
          maxOutputTokens: defaults.maxOutputTokens,
          signal,
        })) {
          produced = true;
          if (event.type === "delta") {
            text += event.text;
            onEvent({ type: "delta", text: event.text });
          } else if (event.type === "reasoning") {
            // 思考过程单独转发，不混入 history/回复正文（由前端折叠展示）
            onEvent({ type: "reasoning", text: event.text });
          } else if (event.type === "tool_call") {
            calls.push({ id: event.id ?? `call_${shortId()}`, name: event.name, arguments: event.arguments });
          } else if (event.type === "done") {
            finishReasonThisRound = event.finishReason ?? "stop";
            if (event.usage != null) usageThisRound = event.usage;
          }
        }
        break;
      } catch (error) {
        if (signal?.aborted) throw error;
        const retriable = RETRYABLE_RE.test(String(error?.message ?? error));
        if (!retriable || produced || attempt >= MAX_RETRIES) throw error;
        attempt += 1;
        // 修复：重试提示原先用 delta 事件发送，而 delta 的文本会被累加进 `text` 并作为
        // assistant 消息写回 history/落库 —— 一段纯运维提示被永久固化成了模型"说过的话"。
        // 改为独立的 notice 事件，仅作 UI 提示，不进入上下文与留痕正文。
        onEvent({ type: "notice", message: `模型端点瞬态失败（${String(error?.message ?? error).slice(0, 80)}），${attempt}s 后自动重试 ${attempt}/${MAX_RETRIES}…` });
        await new Promise((r) => setTimeout(r, 1100 * attempt));
      }
    }
    finishReason = finishReasonThisRound;
    if (usageThisRound != null) onEvent({ type: "usage", usage: usageThisRound });

    // 文本降级路径：模型不支持 function calling，从输出里抠 tool block
    if (calls.length === 0 && provider.supportsTools === false && allTools.length > 0) {
      const parsed = extractTextToolCall(text);
      if (parsed != null) {
        calls.push({ id: `call_${shortId()}`, name: parsed.name, arguments: parsed.arguments });
      }
    }

    if (calls.length === 0) {
      history.push({ role: "assistant", content: text });
      return { messages: history.filter((message) => message.role !== "system"), finishReason, rounds: round + 1 };
    }

    for (const call of calls) {
      onEvent({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
    }

    // DeepSeek reasoner / 部分 GLM 网关拒绝空 assistant content：带工具调用时用 null（OpenAI 规范）
    history.push({ role: "assistant", content: text !== "" ? text : (calls.length > 0 ? null : ""), ...(calls.length > 0 ? { tool_calls: assistantToolCalls(calls).tool_calls } : {}) });

    for (const call of calls) {
      if (signal?.aborted) throw new Error("用户已终止当前回合");
      let output;
      // 同轮去重：相同工具+相同参数重复调用直接复用结果（部分模型会打转，提示词防不住）
      const cacheKey = `${call.name}:${JSON.stringify(call.arguments ?? {})}`;
      if (turnCallCache.has(cacheKey)) {
        output = { text: `${turnCallCache.get(cacheKey)}\n（本回合内已有完全相同的调用，以上为复用结果，请勿重复调用）`, isError: false, deduped: true };
      } else {
        const gate = await confirmGate({ call, confirm, signal });
        if (!gate.approved) {
          output = { text: gate.refusal, isError: true };
      } else {
        try {
          output = await Promise.race([
            mcp.callTool(call.name, call.arguments),
            new Promise((_, rej) => {
              if (signal?.aborted) rej(new Error("用户已终止"));
              signal?.addEventListener("abort", () => rej(new Error("用户已终止")), { once: true });
            }),
          ]);
        } catch (error) {
          output = { text: `工具调用失败: ${String(error?.message ?? error)}`, isError: true };
          warn(SCOPE, "工具执行失败", { name: call.name, error: output.text });
        }
        }
      }
      // 只缓存成功结果：失败调用（含瞬态错误）允许模型同轮重试
      if (!output.isError && !output.deduped) turnCallCache.set(cacheKey, output.text);
      onEvent({ type: "tool_result", id: call.id, name: call.name, text: output.text, isError: output.isError });
      const contextText = truncateForContext(output.text);
      history.push({
        role: useTools ? "tool" : "user",
        ...(useTools ? { tool_call_id: call.id } : {}),
        content: useTools ? contextText : `工具 ${call.name} 的返回：\n${contextText}`,
      });
    }
  }

  // 修复：这行提示原以 delta 发送，会作为模型输出的一部分被写回历史与留痕；
  // 而 finishReason="length" 又同时被上游用作"轮次打满"的判据 —— 但 OpenAI 兼容端点
  // 在**输出 token 上限**截断时同样返回 finish_reason="length"，两者被混为一谈，
  // 于是一次正常的长回答截断也会误触发「长时间执行」风险事件。
  // 真正表达"轮次打满"的语义改由 roundsReachedLimit 显式承载。
  onEvent({ type: "notice", message: "已达到最大工具轮次，提前结束（可用结果已保留）" });
  return { messages: history.filter((message) => message.role !== "system"), finishReason: "length", roundsReachedLimit: true, rounds: maxRounds };
}
