/**
 * 自定义模型适配器模板。
 *
 * 只有当 config/model.json 里 provider.protocol === "custom" 且 adapter === "custom" 时才会走到这里。
 * 如果你的网关本身是 OpenAI 兼容的（/v1/chat/completions + SSE），不要用它，
 * 直接用 protocol: "openai-compatible" 填 baseUrl / apiKey / model 即可。
 *
 * 需要实现的就是 chatStream()：一个 async generator，产出以下事件：
 *   { type: "delta", text: string }
 *   { type: "tool_call", id: string, name: string, arguments: object }
 *   { type: "done", finishReason: string, usage: object|null }
 *
 * request 结构：{ messages, tools, temperature, maxOutputTokens, signal }
 * messages 是 OpenAI 格式：[{ role: "system"|"user"|"assistant"|"tool", content, tool_calls?, tool_call_id? }]
 */
export async function* chatStream({ provider, request }) {
  const { messages, signal } = request;

  // ---- 1. 把 OpenAI 消息格式映射成目标网关需要的格式 ----
  const payload = {
    // 多数非标准网关用 prompt / input / query 之类的字段，按文档替换
    model: provider.model,
    input: messages.map((message) => ({
      role: message.role,
      content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    })),
  };

  // ---- 2. 鉴权：非标准网关常见做法不是 Bearer，而是自定义头或表单字段 ----
  const headers = {
    "content-type": "application/json",
    ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    ...(provider.headers ?? {}),
  };

  const response = await fetch(provider.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`自定义网关返回 HTTP ${response.status}: ${String(detail).replace(/\s+/g, " ").slice(0, 300)}`);
  }

  // ---- 3. 把网关响应翻译成统一事件 ----
  // 非流式：
  const data = await response.json();
  const text = data?.output?.text ?? data?.result ?? data?.data?.content ?? data?.choices?.[0]?.message?.content ?? "";
  if (typeof text === "string" && text.length > 0) {
    yield { type: "delta", text };
  }

  // 若网关支持工具调用，在这里产出 tool_call 事件；否则保持文本降级
  // yield { type: "tool_call", id: "call_x", name: "xxx", arguments: {} };

  yield { type: "done", finishReason: "stop", usage: data?.usage ?? null };

  // ---- 4. 流式版本（若网关支持 SSE），把上面的非流式分支替换掉 ----
  // const decoder = new TextDecoder();
  // for await (const chunk of response.body) {
  //   const line = decoder.decode(chunk, { stream: true });
  //   ...解析后 yield { type: "delta", text }
  // }
}
