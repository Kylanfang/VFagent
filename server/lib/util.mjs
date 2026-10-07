import { API_HEADERS } from "./security-headers.mjs";
import { writeFileSync, renameSync, unlinkSync } from "node:fs";

const TS = () => new Date().toISOString().slice(11, 23);

/** 同步小睡（本函数是同步 API，异常路径上短暂等待用；正常路径完全不触发） */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* 退化忙等，仅在 Atomics 不可用时 */ }
  }
}

/**
 * 原子写文本文件：temp+rename，进程崩溃/断电不会留下半截 JSON（配置与用量文件都按此落盘）。
 *
 * 修复（2026-09-13）：Windows 上 `renameSync` 会因**目标文件被短暂占用**（杀毒实时扫描、
 * 搜索索引、另一进程持有句柄）抛 `EPERM/EBUSY/EACCES`。实测证据：全量回归连跑时
 * `t-unit-guards` 被 `EPERM: ... rename 'mcp.json.tmp' -> 'mcp.json'` 直接打断（进程崩溃、无汇总）；
 * 在真实场景里等价于"保存设置偶发 500"。现在：① 这类可重试错误做有限次重试（3 次 × 30ms）；
 * ② 仍失败则退回**直接覆盖写**（退化的只是"断电不留半截文件"这一点原子性，内容本身完整）。
 * 其它错误（如 ENOSPC/EACCES 永久失败）不吞：最后一次错误照常抛出。
 */
export function atomicWriteFile(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data, "utf8");
  let lastErr = null;
  for (let i = 0; i < 4; i += 1) {
    try {
      renameSync(tmp, file);
      return;
    } catch (err) {
      lastErr = err;
      const retryable = err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES";
      if (!retryable || i === 3) break;
      sleepSync(30);
    }
  }
  try {
    writeFileSync(file, data, "utf8");
    try { unlinkSync(tmp); } catch { /* 临时文件清不掉不影响正确性 */ }
  } catch {
    throw lastErr ?? new Error(`写入失败: ${file}`);
  }
}

/** 单行化：日志字段里的换行/控制字符会伪造出额外的日志行（日志注入/伪造），统一压平 */
function oneLine(value, max = 2000) {
  return String(value ?? "").replace(/[\r\n\u2028\u2029\u0000-\u0008\u000B\u000C\u000E-\u001F]+/g, " ").slice(0, max);
}

export function log(scope, message, extra) {
  const suffix = extra === undefined ? "" : ` ${oneLine(JSON.stringify(extra))}`;
  console.log(`[${TS()}] [${scope}] ${oneLine(message)}${suffix}`);
}

export function warn(scope, message, extra) {
  const suffix = extra === undefined ? "" : ` ${oneLine(JSON.stringify(extra))}`;
  console.warn(`[${TS()}] [${scope}] WARN ${oneLine(message)}${suffix}`);
}

export function sseHeaders(res) {
  // 修复：SSE 响应原先只写了 4 个流式相关头，绕过了统一的安全响应头（json() 走 API_HEADERS）。
  // 结果是 `/api/chat` 这一条主要通道的响应缺少 CSP/X-Content-Type-Options 等防线。
  res.writeHead(200, {
    ...API_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

export function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * 请求体未被读完时必须关闭连接的标记。
 * 场景：请求体超过上限时我们立刻回 4xx，但 socket 里还剩着没读完的字节。Node 会把这些
 * 残留字节当成"同一条长连接上下一个请求"的开头，形成请求错帧 —— 客户端随后的请求会
 * 永久挂起（无响应、无错误，只能等超时）。实测：一发 6MB 请求后，同连接的第 2 个请求
 * 100% 挂死。带上 Connection: close 并在响应写完后关闭套接字即可根除。
 */
const CLOSE_AFTER = Symbol.for("vfletch.closeAfter");

function markCloseAfter(req) {
  // 标记在请求对象上：json() 通过 res.req 反查（res.req 是 Node 文档化属性，恒存在；
  // 反方向的 req.res 并未被保证，实测取不到，会导致本修复静默失效）
  if (req != null) req[CLOSE_AFTER] = true;
}

const isCloseAfter = (res) => res?.[CLOSE_AFTER] === true || res?.req?.[CLOSE_AFTER] === true;

export function json(res, status, payload) {
  const body = JSON.stringify(payload);
  const closeAfter = isCloseAfter(res);
  res.writeHead(status, {
    ...API_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...(closeAfter ? { connection: "close" } : {}),
  });
  if (closeAfter) {
    // 双保险：既告诉客户端不要复用，也在响应写完后主动关掉这条 TCP 连接。
    // 只做前者的话，只顾着复用的客户端仍会把下一个请求发进来并永久挂起。
    res.once("finish", () => { try { res.socket?.destroySoon?.(); } catch {} });
  }
  res.end(body);
}

export async function readJsonBody(req, limitBytes = 4 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      markCloseAfter(req);
      throw new Error("请求体过大");
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function shortId() {
  return Math.random().toString(36).slice(2, 10);
}

/** 读取原始二进制请求体（带大小上限），用于文件上传 */
export async function readRawBody(req, limitBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      markCloseAfter(req);
      throw new Error(`文件超过上限（${Math.round(limitBytes / 1024 / 1024)}MB）`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
