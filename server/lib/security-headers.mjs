// 统一安全响应头（服务端与桌面壳共用）
// - HTML：CSP 以 'self' 为主；页面内联 <script> 自动按 sha256 哈希放行（无需 'unsafe-inline'），
//   AI 输出中即便混入 <script>/on*= 也无法执行，是 XSS 的最后一道保险
// - API JSON：禁止嗅探、禁止被 iframe 嵌入
import { createHash } from "node:crypto";

const INLINE_SCRIPT_RE = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);
export function normalizeNewlines(text) {
  return String(text).split(CR + LF).join(LF).split(CR).join(LF);
}

export function cspForHtml(html) {
  const hashes = [];
  let m;
  INLINE_SCRIPT_RE.lastIndex = 0;
  while ((m = INLINE_SCRIPT_RE.exec(String(html ?? ""))) !== null) {
    if (m[1].trim() === "") continue;
    // 浏览器按 HTML 解析后的脚本文本计算哈希：CR/CRLF 已归一为 LF，服务端必须做同样归一，否则 CRLF 文件的哈希永远不匹配
    hashes.push(`'sha256-${createHash("sha256").update(normalizeNewlines(m[1]), "utf8").digest("base64")}'`);
  }
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' data: blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const COMMON_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

export const API_HEADERS = {
  ...COMMON_HEADERS,
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "cache-control": "no-store",
};

export function htmlHeaders(html, extra = {}) {
  return {
    "content-type": "text/html; charset=utf-8",
    ...COMMON_HEADERS,
    "content-security-policy": cspForHtml(html),
    ...extra,
  };
}
