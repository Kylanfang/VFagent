// V-Fletch 上下文窗口管理：按用户可选的窗口大小裁剪历史
// 策略：system 永远保留；从最新消息向前按“成组单元”装入 92% 预算（8% 留给回复）；
//       一个 assistant(含 tool_calls) 与其全部 tool 结果必须成组保留，杜绝孤立 tool 消息；
//       超出部分整组丢弃，并在窗口头部插入一条省略说明。
// token 估算：中文场景 ~1.5 字符/token（与 usage.mjs 的估算口径一致取偏保守值）。

const CHARS_PER_TOKEN = 1.5;
export const DEFAULT_CONTEXT_WINDOW = 300_000;
export const MIN_CONTEXT_WINDOW = 8_000;   // 尊重更小的显式设置（如供应商实际上限）
export const MAX_CONTEXT_WINDOW = 1_000_000;
export const WINDOW_OPTIONS = [300_000, 500_000, 800_000, 1_000_000];

export function clampContextWindow(raw) {
  // 缺省/非法 → 默认 300k；显式给定的小值（如供应商真实上限 128k/32k/8192）按原值收缩，不再强行放大
  if (raw == null || raw === "") return DEFAULT_CONTEXT_WINDOW;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_CONTEXT_WINDOW;
  return Math.min(MAX_CONTEXT_WINDOW, Math.max(MIN_CONTEXT_WINDOW, Math.round(n)));
}

export function estimateTokens(value) {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.max(1, Math.round(s.length / CHARS_PER_TOKEN));
}

function messageTokens(message) {
  let t = estimateTokens(message?.content ?? "") + 8; // 角色/结构开销
  if (Array.isArray(message?.tool_calls)) t += estimateTokens(message.tool_calls);
  return t;
}

/**
 * 把消息序列切成不可拆分的组：
 *   - assistant(带 tool_calls) + 其后连续的 tool 结果 = 一组
 *   - 其余消息各自成组
 * 裁剪只按整组进行，保证任何保留的 tool 结果都有对应的 assistant.tool_calls。
 */
function buildGroups(messages) {
  const groups = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i];
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const group = [m];
      i += 1;
      while (i < messages.length && messages[i]?.role === "tool") {
        group.push(messages[i]);
        i += 1;
      }
      groups.push(group);
    } else {
      groups.push([m]);
      i += 1;
    }
  }
  return groups;
}

/** 按 token 预算截断单条消息正文（仅动 content，保留 role/tool_calls 等结构字段） */
function truncateMessageToTokens(message, tokenBudget) {
  const content = message?.content;
  if (typeof content !== "string") return message;
  const maxChars = Math.max(200, Math.floor(tokenBudget * CHARS_PER_TOKEN));
  if (content.length <= maxChars) return message;
  return { ...message, content: `${content.slice(0, maxChars)}\n…(本条因超出所选上下文窗口已截断)` };
}

/**
 * 裁剪 history（history[0] 必须是 system）到窗口预算内。
 * 返回 { history, dropped, usedTokens, windowTokens }
 */
export function trimHistoryToWindow(history, windowTokens) {
  const budget = clampContextWindow(windowTokens);
  const keepBudget = Math.floor(budget * 0.92);
  const groups = buildGroups(history.slice(1));
  const keptGroups = [];
  let used = 0;
  for (let g = groups.length - 1; g >= 0; g -= 1) {
    const t = groups[g].reduce((sum, m) => sum + messageTokens(m), 0);
    if (used + t > keepBudget) {
      // 修复：原实现在这里直接 break，若**最新一组**自身就超过预算（用户贴了一条超长文本、
      // 或上一轮的工具结果极大），keptGroups 会保持为空 —— 连本回合最新的用户提问都被裁掉，
      // 模型收到只有 system 的空历史，于是开始凭空编造/答非所问。
      // 现在：最新一组无论如何都保留，超出预算时按比例截断其正文。
      if (keptGroups.length === 0) {
        const room = Math.max(400, keepBudget - used);
        const per = Math.max(200, Math.floor(room / Math.max(1, groups[g].length)));
        const shrunk = groups[g].map((m) => truncateMessageToTokens(m, per));
        used += shrunk.reduce((sum, m) => sum + messageTokens(m), 0);
        keptGroups.unshift(shrunk);
      }
      break;
    }
    used += t;
    keptGroups.unshift(groups[g]);
  }
  const kept = keptGroups.flat();
  const dropped = history.length - 1 - kept.length;
  if (dropped <= 0) {
    return { history, dropped: 0, usedTokens: used, windowTokens: budget };
  }
  const notice = {
    role: "user",
    content: `(系统提示：更早的 ${dropped} 条消息因超出所选上下文窗口（${budget} tokens，当前已用约 ${used}）而省略。如需早期内容，请向用户确认关键信息，不要凭空补全。)`,
  };
  return { history: [history[0], notice, ...kept], dropped, usedTokens: used, windowTokens: budget };
}
