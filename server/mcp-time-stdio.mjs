#!/usr/bin/env node
// 零依赖的时间/时区 MCP server（stdio，JSON-RPC 2.0）。
// 目录条目 id="time"：node {{APP}}/server/mcp-time-stdio.mjs
// 提供：get_current_time（当前时间/日期/星期/时区）、convert_timezone（时区换算）、days_between（日期间隔）
const protocolVersion = "2024-11-05";

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
// tools/call 的结果须包 content；而 initialize/tools/list/ping 的 result 必须是裸对象
// （此前统一走 content 包装，SDK 客户端校验 initialize 响应失败 → 目录安装 time 恒失败）
function result(id, payload) {
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] } });
}
function rawResult(id, obj) {
  send({ jsonrpc: "2.0", id, result: obj });
}
function toolError(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}

const TOOLS = [
  {
    name: "get_current_time",
    description: "获取当前本地时间：完整时间戳、日期、星期、时区与 Unix 秒",
    inputSchema: { type: "object", properties: { timezone: { type: "string", description: "可选 IANA 时区，如 Asia/Shanghai" } } },
  },
  {
    name: "convert_timezone",
    description: "把一个时间点从一个时区换算到另一个时区",
    inputSchema: {
      type: "object",
      properties: {
        time: { type: "string", description: "ISO 时间，如 2026-09-11T10:00:00" },
        fromZone: { type: "string", description: "源 IANA 时区，如 UTC" },
        toZone: { type: "string", description: "目标 IANA 时区，如 Asia/Shanghai" },
      },
      required: ["time", "toZone"],
    },
  },
  {
    name: "days_between",
    description: "计算两个日期之间相差的天数（date2 - date1）",
    inputSchema: {
      type: "object",
      properties: { date1: { type: "string" }, date2: { type: "string" } },
      required: ["date1", "date2"],
    },
  },
];

// 修复：原实现用 `Intl.format(date)` 的**整串**再 slice 出 date/time/weekday。
// zh-CN 的输出形如 "2026/09/13 17:36:19 星期日"，于是：
//   date = "2026/09/13"（非 ISO），time = "17:36:19 星期日"（把星期混进时间），
//   weekday 的正则 /^[\d/]+\s*/ 只吃掉开头的日期，结果 weekday 也是 "17:36:19 星期日"。
// 改为按 formatToParts 精确取字段，三个值互不污染且 date 恒为 ISO 形式。
function zoneParts(date, zone) {
  const dtf = new Intl.DateTimeFormat("zh-CN", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "long", hour12: false,
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  if (p.year == null || p.hour == null) throw new Error(`未知时区: ${zone}`);
  const hh = String(Number(p.hour) % 24).padStart(2, "0");
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${hh}:${p.minute}:${p.second}`,
    weekday: p.weekday ?? "",
  };
}

function fmtInZone(date, zone) {
  try {
    const p = zoneParts(date, zone);
    return `${p.date} ${p.time} ${p.weekday}`.trim();
  } catch {
    return null;
  }
}

function callTool(name, args) {
  if (name === "get_current_time") {
    const now = new Date();
    const zone = args?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    let parts;
    try {
      parts = zoneParts(now, zone);
    } catch {
      throw new Error(`未知时区: ${zone}`);
    }
    return {
      timestamp: now.toISOString(),
      date: parts.date,
      time: parts.time,
      weekday: parts.weekday,
      timezone: zone,
      unixSeconds: Math.floor(now.getTime() / 1000),
      formatted: `${parts.date} ${parts.time} ${parts.weekday}`.trim(),
    };
  }
  if (name === "convert_timezone") {
    const raw = String(args?.time ?? "");
    const from = args?.fromZone ?? "UTC";
    const to = args?.toZone ?? "Asia/Shanghai";
    // 无时区标注的时间按 from 时区解释
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
    const date = m != null
      ? zonedNaiveToUtc(from, { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] ?? 0) })
      : new Date(raw);
    if (Number.isNaN(date.getTime())) throw new Error(`无法解析时间: ${raw}`);
    return {
      input: raw, fromZone: from, toZone: to,
      converted: fmtInZone(date, to), unixSeconds: Math.floor(date.getTime() / 1000),
      iso: date.toISOString(),
    };
  }
  if (name === "days_between") {
    const d1 = new Date(String(args?.date1 ?? ""));
    const d2 = new Date(String(args?.date2 ?? ""));
    if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) throw new Error("日期格式无法解析");
    const days = Math.round((d2.getTime() - d1.getTime()) / 86400000);
    return { days, date1: args?.date1, date2: args?.date2 };
  }
  throw new Error(`未知工具: ${name}`);
}

/** zone 在给定时刻相对 UTC 的偏移（分钟）。必须是"该时刻"的偏移，否则夏令时区间会算错。 */
function offsetMinutes(zone, at) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(at).map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  // 秒级对齐：formatToParts 丢掉了毫秒，若直接相减会引入 <1s 的抖动
  const alignedMs = Math.floor(at.getTime() / 1000) * 1000;
  return Math.round((asUTC - alignedMs) / 60000);
}

function offsetOf(zone, at = new Date()) {
  const offsetMin = offsetMinutes(zone, at);
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/**
 * 把"某时区的墙上时间"转成真实 UTC 时刻。
 * 修复：原实现用 `offsetOf(from)`（即**当前**偏移）去解释任意日期的时间 —— 对
 * America/New_York 这类夏令时地区，用 9 月的偏移去解析 1 月的输入会整整错 1 小时。
 * 这里用迭代求该时刻的真实偏移（首次猜测 → 用猜测出的时刻重新求偏移 → 收敛，最多 3 轮）。
 */
function zonedNaiveToUtc(zone, { y, mo, d, h, mi, s }) {
  const base = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = base;
  for (let i = 0; i < 3; i += 1) {
    const off = offsetMinutes(zone, new Date(guess));
    const next = base - off * 60000;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line === "") continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    if (method === "initialize") {
      rawResult(id, { protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "vfletch-time", version: "1.0.1" } });
    } else if (method === "notifications/initialized" || method === "notifications/cancelled") {
      // 通知无需响应
    } else if (method === "tools/list") {
      rawResult(id, { tools: TOOLS });
    } else if (method === "tools/call") {
      // 修复：原实现把 {content:[…]} 又交给 result()（result 内部还会再包一层 content），
      // 于是客户端拿到的 text 是 `{"content":[{"type":"text","text":"…"}]}` —— 多套了一层壳，
      // 模型读到的是转义后的 JSON 字符串而不是工具结果本身。直接传 payload。
      try { result(id, callTool(params.name, params.arguments ?? {})); }
      catch (e) { toolError(id, String(e?.message ?? e)); }
    } else if (method === "ping") {
      rawResult(id, {});
    }
  }
});
process.stdin.resume();
