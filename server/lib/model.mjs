import path from "node:path";
import { ROOT } from "./config.mjs";
import { warn } from "./util.mjs";

const SCOPE = "model";

function joinUrl(baseUrl, suffix) {
  const base = String(baseUrl ?? "").replace(/\/+$/, "");
  if (base === "") throw new Error("模型 baseUrl 为空");
  return `${base}${suffix}`;
}

function describeHttpError(status, body) {
  const text = String(body ?? "").replace(/\s+/g, " ").slice(0, 300);
  let hint = "";
  if (status === 400 && /context|token|length|maximum|too (long|large|many)/i.test(text)) {
    hint = "（提示：输入可能超出该模型的真实上下文上限；请在输入框左侧调低上下文窗口档位，或新开对话）";
  }
  if (status === 429) hint = "（提示：上游模型限流——每分钟请求数已达上限且失败请求也计入配额；本次未自动重试以免加剧限流，请稍候几秒再发送或降低并发）";
  return `模型端点返回 HTTP ${status}${text ? `: ${text}` : ""}${hint}`;
}

/**
 * 解析 OpenAI 兼容的 SSE 流。对不严格实现做容错：
 * 允许 \r\n、允许 `data:` 后无空格、忽略非 JSON 的注释行与心跳。
 */
export async function* parseSse(response, signal) {
  const decoder = new TextDecoder();
  let buffer = "";
  // 修复：原实现在 signal 已中止时直接 `return`，调用方会把它当成"流正常结束"，
  // 继续 flush 缓冲并 yield `{type:"done", finishReason:"stop"}` —— 于是**被用户取消
  // 或被看门狗中止的回合被记为成功完成**：前端显示正常收束、用量与轮次照常落库，
  // 留痕里出现一条"回答完整"但其实被截断的记录。改为抛出可识别的中止错误。
  const abortError = () => {
    const err = new Error("模型流已中止");
    err.name = "AbortError";
    err.aborted = true;
    return err;
  };
  for await (const chunk of response.body) {
    if (signal?.aborted) throw abortError();
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "").trim();
      buffer = buffer.slice(index + 1);
      if (line === "" || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        yield JSON.parse(payload);
      } catch {
        // 忽略无法解析的片段，交由调用方判断是否整体失败
      }
    }
  }
  // 上游在流中途关掉连接：属于异常结束，同样不能当成"正常完成"
  if (signal?.aborted) throw abortError();
}

function normalizeToolCalls(delta) {
  const out = [];
  for (const call of delta?.tool_calls ?? []) {
    out.push({
      index: call.index ?? 0,
      id: call.id ?? null,
      name: call.function?.name ?? null,
      argumentsDelta: call.function?.arguments ?? "",
    });
  }
  return out;
}

async function loadCustomAdapter(name) {
  // 修复审计 A7（路径穿越→代码执行）：name 来自 provider.adapter/provider.id（可经设置请求写入），
  // 无白名单时 "../evil" 形态的名字可加载 adapters 目录外的任意 .mjs。
  if (!/^[a-z0-9_-]{1,32}$/i.test(String(name ?? ""))) {
    throw new Error(`自定义适配器名非法（仅允许 1-32 位字母/数字/下划线/中划线）: ${name}`);
  }
  const file = path.join(ROOT, "server", "adapters", `${name}.mjs`);
  const mod = await import(`file://${file.replace(/\\/g, "/")}`);
  if (typeof mod.chatStream !== "function") {
    throw new Error(`自定义适配器 ${name} 必须导出 chatStream()`);
  }
  return mod;
}

/**
 * 统一模型客户端。
 * OpenAI 兼容模式直接走 /chat/completions；custom 模式委托给 server/adapters/<name>.mjs；
 * VF 内置前台模型（id='vf'）为本地迎宾应答：只做简单问答与引导，不接任何工具与真实能力。
 *
 * 三大模型族适配（provider 级开关，见 model.example.json）：
 * - DeepSeek：reasoning_content 思考流（已支持）；reasoner 系不支持 system 角色 → provider.systemAsUser=true
 * - Qwen：思维模型常把 <think>…</think> 混在 content 里 → 流式分离为 reasoning 事件；
 *   DashScope 系网关可用 provider.extraBody={"enable_thinking":false} 关思考
 * - GLM：智谱 SSE 含 `: keep-alive` 注释行（已容错）；思考开关 extraBody={"thinking":{"type":"disabled"}}
 */

/** reasoner 系模型不接受 system 角色：把 system 并进首条 user 消息 */
function prepareMessages(provider, messages) {
  const arr = Array.isArray(messages) ? messages : [];
  if (provider.systemAsUser !== true) return arr;
  if (arr.length === 0 || arr[0].role !== "system") return arr;
  const [system, ...rest] = arr;
  const out = rest.map((m) => ({ ...m }));
  const firstUser = out.find((m) => m.role === "user");
  if (firstUser != null) {
    firstUser.content = `${system.content}\n\n${firstUser.content ?? ""}`;
  } else {
    out.unshift({ role: "user", content: String(system.content ?? "") });
  }
  return out;
}

/** 非流式整段文本的 <think> 剥离 */
export function splitThink(text) {
  const s = String(text ?? "");
  const m = /<think>([\s\S]*?)(<\/think>|$)/i.exec(s);
  if (m == null) return { text: s.trim(), reasoning: null };
  const reasoning = m[1]?.trim() || null;
  const body = (s.slice(0, m.index) + " " + s.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { text: body, reasoning };
}

/**
 * 流式 <think> 分离器：思考标签可能被切成多个 chunk（"<thi" + "nk>"），
 * 用一个小的尾部缓冲保证标签判定完整。push(chunk) → [{kind:"delta"|"reasoning", text}]；结束时 flush()。
 */
export function createThinkSplitter() {
  const OPEN = "<think>";
  const CLOSE = "</think>";
  let inThink = false;
  let buffer = ""; // 尚无法判定是否为标签起点的尾部字符
  const emit = [];
  const pushText = (text, kind) => {
    if (text !== "") emit.push({ kind, text });
  };
  return {
    push(chunk) {
      emit.length = 0;
      buffer += String(chunk ?? "");
      for (;;) {
        const next = inThink ? CLOSE : OPEN;
        const lower = buffer.toLowerCase();
        const idx = lower.indexOf(next);
        if (idx >= 0) {
          // 找到完整标签：标签前文本按当前状态输出，然后翻转状态
          pushText(buffer.slice(0, idx), inThink ? "reasoning" : "delta");
          buffer = buffer.slice(idx + next.length);
          inThink = !inThink;
          continue;
        }
        // 无完整标签：尾部若悬挂着被截断的标签前缀则保留等待，其余按当前状态输出
        let hold = 0;
        const keep = Math.min(next.length - 1, buffer.length);
        for (let k = keep; k > 0; k -= 1) {
          if (lower.endsWith(next.slice(0, k))) {
            hold = k;
            break;
          }
        }
        pushText(hold > 0 ? buffer.slice(0, buffer.length - hold) : buffer, inThink ? "reasoning" : "delta");
        buffer = hold > 0 ? buffer.slice(buffer.length - hold) : "";
        break;
      }
      return emit.splice(0);
    },
    flush() {
      emit.length = 0;
      // 结束时悬挂的疑似标签按原状态输出（模型忘了闭合标签也要把内容给用户）
      pushText(buffer, inThink ? "reasoning" : "delta");
      buffer = "";
      return emit.splice(0);
    },
  };
}

/**
 * 统一模型客户端。
 * OpenAI 兼容模式直接走 /chat/completions；custom 模式委托给 server/adapters/<name>.mjs；
 * VF 内置前台模型（id='vf'）为本地迎宾应答：只做简单问答与引导，不接任何工具与真实能力。
 */
export async function createModelClient(provider) {
  if (provider.id === "vf" || provider.protocol === "vf") {
    return { kind: "vf-greeter", async *stream(request) { yield* vfGreeterStream(request); } };
  }
  // 失败早且说得清：供应商定义缺 baseUrl 时，原来只会在真正发请求时抛出 "模型 baseUrl 为空"，
  // 调用方（子代理/派活/提示词优化）拿到这句话根本不知道是**哪个**供应商坏了、该去哪里修。
  // 实测踩到过：测试把 active 指到一条空壳 provider，t-deep 的 delegate_agent 只回一句
  // "内置工具执行失败: 模型 baseUrl 为空"。这里点名供应商并给出可执行的下一步。
  if (String(provider?.baseUrl ?? "") === "" && provider.protocol !== "custom") {
    const who = provider?.label ?? provider?.id ?? "(未命名)";
    throw new Error(`供应商「${who}」未配置 baseUrl，无法调用模型：请到「设置 → 模型接入」补全该供应商，或把激活模型切换到其它可用供应商`);
  }
  if (provider.protocol === "custom") {
    const adapter = await loadCustomAdapter(provider.adapter ?? provider.id);
    return {
      kind: "custom",
      async *stream(request) {
        yield* adapter.chatStream({ provider, request });
      },
    };
  }
  if (provider.protocol !== "openai-compatible") {
    throw new Error(`不支持的 protocol: ${provider.protocol}`);
  }
  return {
    kind: "openai-compatible",
    async *stream(request) {
      const { messages, tools, temperature, maxOutputTokens, signal } = request;
      const useTools = provider.supportsTools !== false && tools != null && tools.length > 0;
      const body = {
        model: provider.model,
        messages: prepareMessages(provider, messages),
        stream: provider.supportsStream !== false,
        temperature: temperature ?? 0.3,
      };
      // 修复：OpenAI 兼容协议在 stream 模式下**默认不下发 usage**，必须显式声明
      // `stream_options.include_usage`，否则最后一个 chunk 不带 usage —— 结果是
      // 流式回合的 token 用量全部为空：`usage_log` 不落行、"按人分账"与成本风控
      // （单轮成本超阈值告警）全部失效。这里默认开启，可用 provider.streamUsage=false 关闭
      // （个别严格网关会对未知字段报 400），也可由 extraBody 自行覆盖。
      if (body.stream && provider.streamUsage !== false && provider.extraBody?.stream_options == null) {
        body.stream_options = { include_usage: true };
      }
      if (maxOutputTokens != null) body.max_tokens = maxOutputTokens;
      if (useTools) {
        body.tools = tools;
        // toolChoice: false → 不发送该字段（部分 Qwen/GLM 网关对 tool_choice 校验过严）
        if (provider.toolChoice !== false) body.tool_choice = provider.toolChoice ?? "auto";
      }
      // 厂商私有参数透传：如 GLM 的 {"thinking":{"type":"disabled"}}、Qwen/DashScope 的 {"enable_thinking":false}
      if (provider.extraBody != null && typeof provider.extraBody === "object") Object.assign(body, provider.extraBody);

      const response = await fetch(joinUrl(provider.baseUrl, "/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
          ...(provider.headers ?? {}),
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        throw new Error(describeHttpError(response.status, await response.text().catch(() => "")));
      }

      if (provider.supportsStream === false || !response.body) {
        const payload = await response.json();
        const choice = payload?.choices?.[0] ?? payload?.data?.choices?.[0] ?? {};
        const message = choice.message ?? choice.delta ?? {};
        // 思考过程（DeepSeek 风格 reasoning_content / 部分网关 reasoning）
        const thinking = message.reasoning_content ?? message.reasoning;
        if (typeof thinking === "string" && thinking.length > 0) {
          yield { type: "reasoning", text: thinking };
        }
        // 正文内嵌 <think> 块（Qwen3 等开放式模型常见）→ 剥离为 reasoning
        const content = splitThink(message.content);
        if (content.reasoning) yield { type: "reasoning", text: content.reasoning };
        if (typeof content.text === "string" && content.text.length > 0) {
          yield { type: "delta", text: content.text };
        }
        for (const call of message.tool_calls ?? []) {
          yield {
            type: "tool_call",
            id: call.id ?? `call_${Math.random().toString(36).slice(2, 8)}`,
            name: call.function?.name ?? "",
            arguments: safeParseArgs(call.function?.arguments),
          };
        }
        yield { type: "done", finishReason: choice.finish_reason ?? "stop", usage: payload?.usage ?? null };
        return;
      }

      const pending = new Map();
      const directCalls = []; // 最终整包 tool_calls（部分网关在最后一个 chunk 里一次性给出）
      let sawDirect = false;
      let finishReason = "stop";
      let usage = null;
      const thinkSplitter = createThinkSplitter();

      for await (const payload of parseSse(response, signal)) {
        const root = payload?.data ?? payload;
        const choice = root?.choices?.[0] ?? {};
        if (root?.usage != null) usage = root.usage;
        if (choice.finish_reason != null) finishReason = choice.finish_reason;

        const text = choice.delta?.content ?? choice.message?.content;
        if (typeof text === "string" && text.length > 0) {
          // Qwen3 系思维模型常把 <think>…</think> 混在 content 里 → 流式分离为 reasoning
          const parts = thinkSplitter.push(text);
          for (const part of parts) yield { type: part.kind, text: part.text };
        }

        // 思考过程：reasoning_content（DeepSeek/兼容网关）或 reasoning（部分 OpenAI 兼容实现）
        const think =
          choice.delta?.reasoning_content ?? choice.delta?.reasoning ?? choice.message?.reasoning_content ?? choice.message?.reasoning;
        if (typeof think === "string" && think.length > 0) {
          yield { type: "reasoning", text: think };
        }

        for (const call of normalizeToolCalls(choice.delta ?? choice.message)) {
          // 键：index 优先；无 index（部分 GLM/Qwen 网关）时用 id / 出现次序，避免并行调用互相串参
          const key = call.index ?? call.id ?? `pos_${pending.size}_${call.name ?? ""}`;
          const existing = pending.get(key) ?? { id: call.id, name: call.name, args: "" };
          if (call.id) existing.id = call.id;
          if (call.name) existing.name = call.name;
          existing.args += call.argumentsDelta ?? "";
          pending.set(key, existing);
        }

        if (Array.isArray(choice.message?.tool_calls) && choice.message.tool_calls.length > 0) {
          sawDirect = true;
          directCalls.push(...choice.message.tool_calls);
        }
      }
      const tail = thinkSplitter.flush();
      for (const part of tail) yield { type: part.kind, text: part.text };

      if (pending.size > 0) {
        // 流式增量累积的结果是权威版本；此时忽略整包 tool_calls，防止同一调用被执行两次
        for (const call of pending.values()) {
          yield {
            type: "tool_call",
            id: call.id ?? `call_${Math.random().toString(36).slice(2, 8)}`,
            name: call.name ?? "",
            arguments: safeParseArgs(call.args),
          };
        }
      } else if (sawDirect) {
        const seen = new Set();
        for (const call of directCalls) {
          if (call.id != null && seen.has(call.id)) continue;
          if (call.id != null) seen.add(call.id);
          yield {
            type: "tool_call",
            id: call.id ?? `call_${Math.random().toString(36).slice(2, 8)}`,
            name: call.function?.name ?? "",
            arguments: safeParseArgs(call.function?.arguments),
          };
        }
      }
      yield { type: "done", finishReason, usage };
    },
  };
}

// ---------------------------------------------------------------------------
// VF 内置前台模型：本地迎宾应答（非 AI 员工，不接工具、不产生真实能力）
// 只回答打招呼/身份/使用方式这类简单问题；其余一律提示"接入模型 API 后使用"。
// ---------------------------------------------------------------------------
const VF_NEED_API = [
  "我是 VF 前台助手，只能做简单的接待问答。",
  "你提出的任务需要真实的模型能力：请管理员在「设置 → 模型 API」添加一个模型 API（如 DeepSeek / Qwen / 本地 vLLM），",
  "添加后系统会自动生成对应的 AI 员工，就可以正式办公、委派任务和使用工具了。",
].join("\n");

async function* vfGreeterStream(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = String(lastUser?.content ?? "").trim();
  const q = text.toLowerCase();

  let reply;
  if (text === "") {
    reply = "你好，我是 VF 前台助手。有什么可以帮您？";
  } else if (/^(你好|您好|hi|hello|嗨|在吗)/i.test(q)) {
    reply = "你好！我是 VF 前台助手。可以回答关于本系统怎么用的问题；正式办公任务请先由管理员接入模型 API。";
  } else if (/(你是谁|你叫什么|你能做什么|你会什么|介绍)/.test(q)) {
    reply = "我是 VF 办公体的前台迎宾：负责接待和引导。我能告诉你系统怎么用；真正的办公能力来自接入的模型 API 与 AI 员工。";
  } else if (/(怎么用|如何使用|怎么接入|怎么添加|api|模型|密钥|账号|登录)/i.test(q)) {
    reply = [
      "使用指引：",
      "1. 管理员（管理员账号）在「设置 → 模型 API → 添加模型 API」填入服务商地址、模型 ID 与 API Key；",
      "2. 保存后系统自动生成对应的 AI 员工，即可在对话中选择并委派任务；",
      "3. 成员账号登录后即可使用共享的模型能力；管理员账号在「监管」页查看全部留痕。",
    ].join("\n");
  } else if (/(谢谢|感谢|再见|拜拜|goodbye)/i.test(q)) {
    reply = "不客气！随时找我。接入模型 API 后，AI 员工就能正式为您服务。";
  } else {
    reply = VF_NEED_API;
  }

  // 按行流出，保持流式体验一致
  for (const line of reply.split("\n")) {
    yield { type: "delta", text: line === "" ? "\n" : line };
  }
  yield { type: "done", finishReason: "stop", usage: null };
}

export function safeParseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  let text = String(raw).trim();
  if (text === "") return {};
  try {
    return JSON.parse(text);
  } catch {}
  // 轻量修复（GLM/Qwen 偶发输出尾逗号）：去掉 } ] 前的尾逗号后重试
  try {
    const repaired = text.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(repaired);
  } catch {}
  warn(SCOPE, "工具参数不是合法 JSON，已降级为 { _raw }", { sample: text.slice(0, 120) });
  return { _raw: text };
}

/**
 * 模型不支持 function calling 时的文本降级提示词。
 * 只要求输出一个 fenced JSON，不追求和原生工具调用等价。
 */
export function textFallbackToolDirective(tools) {
  const listing = tools
    .map((tool) => `- ${tool.function.name}: ${tool.function.description ?? "无描述"}`)
    .join("\n");
  return [
    "你具备调用外部工具的能力。需要调用工具时，只输出一个代码块，不要输出其他内容：",
    "```tool",
    '{"name":"<工具名>","arguments":{ ... }}',
    "```",
    "可用工具：",
    listing,
    "不需要工具时正常回答。",
  ].join("\n");
}

export function extractTextToolCall(text) {
  const match = /```tool\s*([\s\S]*?)```/i.exec(String(text ?? ""));
  if (match == null) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    if (typeof parsed?.name !== "string") return null;
    return { name: parsed.name, arguments: parsed.arguments ?? {} };
  } catch {
    return null;
  }
}
