// LangGraph Studio 可视化导出（静态图）：与 server/lib/chat-graph.mjs 的生产回路同构。
// 拓扑：START → agent ⇄ tools → END（条件边：有工具调用且未达轮次预算则继续）
// 生产回路的模型客户端/MCP 工具在运行时闭包注入，无法直接被 Studio 加载；
// 本文件用环境变量构造等价拓扑供 Studio 画布展示与手动回放测试：
//   VF_STUDIO_MODEL_URL（默认 http://127.0.0.1:11434/v1）
//   VF_STUDIO_MODEL_KEY（默认空）   VF_STUDIO_MODEL_ID（默认 qwen2.5）
import { StateGraph, Annotation, START, END } from "@langchain/langgraph";

const AgentTurnState = Annotation.Root({
  messages: Annotation({ reducer: (a, b) => b ?? a, default: () => [] }),
  rounds: Annotation({ reducer: (a, b) => b ?? a, default: () => 0 }),
  hasToolCalls: Annotation({ reducer: (a, b) => b ?? a, default: () => false }),
});

const MAX_ROUNDS = 8;

async function callStudioModel(messages) {
  const base = String(process.env.VF_STUDIO_MODEL_URL ?? "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
  const model = process.env.VF_STUDIO_MODEL_ID ?? "qwen2.5";
  const key = process.env.VF_STUDIO_MODEL_KEY ?? "";
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!res.ok) throw new Error(`Studio 模型端点 HTTP ${res.status}`);
  const payload = await res.json();
  const msg = payload?.choices?.[0]?.message ?? {};
  return { content: msg.content ?? "", tool_calls: msg.tool_calls ?? [] };
}

async function agentNode(state) {
  const reply = await callStudioModel(state.messages);
  return {
    messages: [...state.messages, { role: "assistant", content: reply.content ?? "" }],
    hasToolCalls: reply.tool_calls.length > 0,
    rounds: state.rounds + 1,
  };
}

async function toolsNode(state) {
  // Studio 演示用占位工具执行：生产环境为 MCP 工具回路（见 chat-graph.mjs toolsNode）
  const out = [...state.messages];
  for (let i = 0; i < 2; i += 1) {
    out.push({ role: "user", content: `(Studio 演示工具结果 #${i + 1}；生产环境此处执行 MCP 工具)` });
  }
  return { messages: out };
}

function routeAfterAgent(state) {
  if (state.hasToolCalls && state.rounds < MAX_ROUNDS) return "tools";
  return END;
}

export const graph = new StateGraph(AgentTurnState)
  .addNode("agent", agentNode)
  .addNode("tools", toolsNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", routeAfterAgent, { tools: "tools", [END]: END })
  .addEdge("tools", "agent")
  .compile();
