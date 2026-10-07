// V-Fletch 对话编排引擎（LangGraph.js StateGraph 版）
// 与 chat.mjs 的 legacy 回路保持同一契约：
//   输入 { messages, provider, defaults, mcp, onEvent, signal }
//   输出 { messages(不含 system), finishReason: stop|length, rounds }
// 事件协议不变：start 之外的 delta / reasoning / tool_call / tool_result / usage 均由本图节点内发出。
// 引擎选择：VFLETCH_AGENT_ENGINE=legacy 可切回旧实现；langgraph 依赖缺失时自动回退。
import { createModelClient, textFallbackToolDirective, extractTextToolCall } from "./model.mjs";
import { memoryDigest, beginMemoryTurn } from "./memory.mjs";
import { buildSystemPrompt, confirmGate } from "./chat.mjs";
import { trimHistoryToWindow } from "./context.mjs";
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";

const AgentTurnState = Annotation.Root({
  messages: Annotation({ reducer: (a, b) => b ?? a, default: () => [] }),
  rounds: Annotation({ reducer: (a, b) => b ?? a, default: () => 0 }),
  finishReason: Annotation({ reducer: (a, b) => b ?? a, default: () => "stop" }),
  hasToolCalls: Annotation({ reducer: (a, b) => b ?? a, default: () => false }),
});

// 工具结果送入模型上下文的截断上限（全文仍完整落库 SQLite 审计）
const TOOL_RESULT_CONTEXT_LIMIT = 6000;
function truncateForContext(text) {
  const s = String(text ?? "");
  if (s.length <= TOOL_RESULT_CONTEXT_LIMIT) return s;
  return `${s.slice(0, TOOL_RESULT_CONTEXT_LIMIT)}\n…(工具输出过长，已截断至 ${TOOL_RESULT_CONTEXT_LIMIT} 字符；完整内容已留痕监管档案)`;
}

// 可重试的瞬态错误：服务端错误 / 网络抖动（多轮工具=密集请求，网关易触发）。
// 429 不重试：上游是分钟级配额窗口且"失败次数也计入配额"，秒级退避必然再撞 429 并加剧雪崩——快速失败让用户稍后再试
const RETRYABLE_RE = /HTTP 5\d\d|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|network|socket hang up/i;
const MAX_RETRIES = 2;

// 模型流看门狗：60s 无任何数据（网关假死/长连接挂起）→ 中止并抛出可读错误，杜绝"输出卡死"
const STREAM_IDLE_TIMEOUT_MS = 60_000;
async function* streamWithWatchdog(client, request, signal) {
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
      // 修复：AbortSignal 没有 .abort()，原回调因 ?. 静默短路而永远是空操作，
      // 端点假死时整轮无限挂起。改为派生内部 AbortController 合并"外部取消 + 看门狗超时"。
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
    if (timedOut) throw new Error(`模型流 ${STREAM_IDLE_TIMEOUT_MS / 1000} 秒无数据（看门狗中止）：端点可能已假死，请重试或更换模型端点`);
    throw error;
  } finally {
    if (timer != null) clearTimeout(timer);
    signal?.removeEventListener?.("abort", forwardAbort);
  }
}

export async function runTurnGraph({ messages, provider, defaults, mcp, contextWindow, identity, onEvent, confirm, signal }) {
  const client = await createModelClient(provider);
  // 修复：原写法让 openAiTools 在降级时恒为空，`!ctx.useTools && ctx.openAiTools.length > 0`
  // 的文本工具协议分支成了死代码（不支持 function calling 的模型永远拿不到工具）。
  const allTools = mcp.toOpenAiTools();
  const openAiTools = provider.supportsTools === false ? [] : allTools;
  const useTools = provider.supportsTools !== false && openAiTools.length > 0;
  const maxRounds = defaults.maxToolRounds ?? 40;

  // 记忆访问授权初始化：按本轮用户消息判定（未提及历史 → 检索类工具将拒绝执行）
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  beginMemoryTurn(typeof lastUser?.content === "string" ? lastUser.content : "");

  // 上下文装配：system 提示；记忆摘要默认不注入（开启：model.json defaults.memoryAutoInject = true）
  let systemContent = buildSystemPrompt(provider, provider.supportsTools === false ? allTools : openAiTools);
  if (identity) systemContent = `${systemContent}

【身份设定】${identity}`;
  if (defaults.memoryAutoInject === true) {
    const memConnected = (mcp.servers ?? []).some((s) => s.id === "memory" && s.status === "connected");
    if (memConnected) {
      const digest = memoryDigest(6, 140);
      if (digest !== "") systemContent = `${systemContent}\n\n${digest}`;
    }
  }

  const ctx = {
    client,
    openAiTools,
    useTools,
    onEvent,
    confirm,
    signal,
    defaults,
    mcp,
    maxRounds,
  };

  // ---- 节点：agent（调用模型，流出 delta/reasoning，聚合工具调用；瞬态错误自动重试） ----
  async function agentNode(state) {
    let text = "";
    const calls = [];
    let finishReason = "stop";
    let usage = null;
    let attempt = 0;

    for (;;) {
      let produced = false;
      try {
        for await (const event of streamWithWatchdog(ctx.client, {
          messages: state.messages,
          tools: ctx.useTools ? ctx.openAiTools : undefined,
          temperature: ctx.defaults.temperature,
          maxOutputTokens: ctx.defaults.maxOutputTokens,
          signal: ctx.signal,
        })) {
          produced = true;
          if (event.type === "delta") {
            text += event.text;
            ctx.onEvent({ type: "delta", text: event.text });
          } else if (event.type === "reasoning") {
            ctx.onEvent({ type: "reasoning", text: event.text });
          } else if (event.type === "tool_call") {
            calls.push({ id: event.id ?? `call_${state.rounds}_${calls.length}`, name: event.name, arguments: event.arguments });
          } else if (event.type === "done") {
            finishReason = event.finishReason ?? "stop";
            if (event.usage != null) usage = event.usage;
          }
        }
        break;
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        const retriable = RETRYABLE_RE.test(String(error?.message ?? error));
        if (!retriable || produced || attempt >= MAX_RETRIES) throw error;
        attempt += 1;
        // 修复：重试提示原以 delta 发送，会被累加进 text 并作为模型"说过的话"写入历史与留痕
        ctx.onEvent({ type: "notice", message: `模型端点瞬态失败（${String(error?.message ?? error).slice(0, 80)}），${attempt}s 后自动重试 ${attempt}/${MAX_RETRIES}…` });
        await new Promise((r) => setTimeout(r, 1100 * attempt));
      }
    }
    if (usage != null) ctx.onEvent({ type: "usage", usage });

    // 文本降级路径：模型不支持 function calling，从输出里抠 tool block
    if (calls.length === 0 && !ctx.useTools && allTools.length > 0) {
      const parsed = extractTextToolCall(text);
      if (parsed != null) calls.push({ id: `call_${state.rounds}_t`, name: parsed.name, arguments: parsed.arguments });
    }

    const assistant = {
      role: "assistant",
      content: text !== "" ? text : (calls.length > 0 ? null : ""),
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) },
            })),
          }
        : {}),
    };

    produced.push(assistant);
    return {
      messages: [...state.messages, assistant],
      hasToolCalls: calls.length > 0,
      finishReason,
      rounds: state.rounds + 1,
    };
  }

  // ---- 节点：tools（执行 MCP 工具，流出 tool_call/tool_result） ----
  // 同轮去重缓存：部分模型会反复以完全相同的参数调用同一工具（提示词防不住），
  // 第二次起直接复用结果，不再真执行——省轮次、省 token、防打转。
  const turnCallCache = new Map();
  const callCacheKey = (name, args) => `${name}:${JSON.stringify(args ?? {})}`;
  async function toolsNode(state) {
    const last = state.messages[state.messages.length - 1];
    const calls = (last?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function?.name ?? tc.name,
      arguments: safeParseArgs(tc.function?.arguments),
    }));
    const out = [...state.messages];
    for (const call of calls) {
      if (ctx.signal?.aborted) throw new Error("用户已终止当前回合");
      ctx.onEvent({ type: "tool_call", id: call.id, name: call.name, arguments: call.arguments });
      let result;
      const cacheKey = callCacheKey(call.name, call.arguments);
      if (turnCallCache.has(cacheKey)) {
        const cached = turnCallCache.get(cacheKey);
        result = { text: `${cached}\n（本回合内已有完全相同的调用，以上为复用结果，请勿重复调用）`, isError: false, deduped: true };
      } else {
        const gate = await confirmGate({ call, confirm: ctx.confirm, signal: ctx.signal });
        if (!gate.approved) {
          result = { text: gate.refusal, isError: true };
        } else {
          try {
            result = await Promise.race([
              ctx.mcp.callTool(call.name, call.arguments),
              new Promise((_, rej) => {
                if (ctx.signal?.aborted) rej(new Error("用户已终止"));
                ctx.signal?.addEventListener("abort", () => rej(new Error("用户已终止")), { once: true });
              }),
            ]);
          } catch (error) {
            result = { text: `工具调用失败: ${String(error?.message ?? error)}`, isError: true };
          }
        }
      }
      // 只缓存成功结果：失败的调用（含瞬态网络错误）允许模型同轮重试
      if (!result.isError && !result.deduped) turnCallCache.set(cacheKey, result.text);
      ctx.onEvent({ type: "tool_result", id: call.id, name: call.name, text: result.text, isError: result.isError });
      out.push({
        role: ctx.useTools ? "tool" : "user",
        ...(ctx.useTools ? { tool_call_id: call.id } : {}),
        content: ctx.useTools
          ? truncateForContext(result.text)
          : `工具 ${call.name} 的返回：\n${truncateForContext(result.text)}`,
      });
    }
    produced.push(...out);
    return { messages: out };
  }

  // ---- 路由：agent 之后有工具调用且未达轮次上限则继续，否则收束 ----
  function routeAfterAgent(state) {
    if (state.hasToolCalls && state.rounds < ctx.maxRounds) return "tools";
    return END;
  }

  // 侧信道：本回合实际产出的消息（含工具调用与结果）。
  // 修复：GraphRecursionError 时原实现把 final.messages 直接设回**输入历史** effectiveHistory，
  // 于是本轮产出的 assistant 内容与 tool_calls 全部丢失 —— main.mjs 会拿"上一轮的历史回答"
  // 当作本轮结果写进任务 result_summary 与 done 事件，用户看到的是张冠李戴的旧内容。
  const produced = [];

  const graph = new StateGraph(AgentTurnState)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, { tools: "tools", [END]: END })
    .addEdge("tools", "agent")
    .compile();

  const history = [{ role: "system", content: systemContent }, ...messages];

  // 上下文窗口裁剪（300k–1M 用户可选）：超出预算的早期消息省略并插入说明
  const trimmed = trimHistoryToWindow(history, contextWindow);
  const effectiveHistory = trimmed.history;
  if (trimmed.dropped > 0) {
    onEvent({ type: "context_trimmed", dropped: trimmed.dropped, usedTokens: trimmed.usedTokens, windowTokens: trimmed.windowTokens });
  }
  // agent 节点读 state.messages；把裁剪结果作为初始状态传入
  const initialState = { messages: effectiveHistory, rounds: 0, finishReason: "stop", hasToolCalls: false };

  let final;
  let hitLimit = false;
  try {
    final = await graph.invoke(
      initialState,
      // 每轮 agent→tools 两个节点，条件边另计一步；留足余量避免误触递归上限
      { recursionLimit: ctx.maxRounds * 3 + 12, configurable: {} },
    );
  } catch (error) {
    // 仅识别 LangGraph 的递归上限错误。修复：原判据 /recursion|limit/i 过于宽泛，
    // 会把上游的 429「Rate limit exceeded」、模型超时里的 "limit"、甚至 "context length limit"
    // 一起当成"轮次打满"，把真正的失败伪装成"已达最大工具轮次，提前结束"的成功收尾，
    // 用户拿到一段莫名其妙的半截答案却看不到任何错误。
    const name = String(error?.name ?? "");
    const message = String(error?.message ?? error);
    const isRecursion = name === "GraphRecursionError" || /^recursion limit/i.test(message) || /GRAPH_RECURSION/i.test(message);
    if (isRecursion) {
      hitLimit = true;
      ctx.onEvent({ type: "notice", message: "已达到最大工具轮次，提前结束（可用结果已保留）" });
      final = {
        messages: [...effectiveHistory, ...produced],
        rounds: ctx.maxRounds,
        finishReason: "length",
      };
    } else {
      throw error;
    }
  }

  const lastAssistant = [...final.messages].reverse().find((m) => m.role === "assistant");
  const endedWithTools = Boolean(lastAssistant?.tool_calls?.length);
  return {
    messages: final.messages.filter((m) => m.role !== "system"),
    finishReason: hitLimit || (endedWithTools && final.rounds >= ctx.maxRounds) ? "length" : final.finishReason ?? "stop",
    // 显式区分"轮次打满"与"输出被 token 上限截断"（两者 finish_reason 都是 length）
    roundsReachedLimit: hitLimit || (endedWithTools && final.rounds >= ctx.maxRounds),
    rounds: final.rounds,
  };
}

function safeParseArgs(raw) {
  if (raw == null || typeof raw === "object") return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
