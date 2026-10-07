// 内置（in-process）MCP server：审计风控 + 联网 / 生成 / 代码 / 智能体协作
// 数据源为随包分发的示例数据 server/audit/audit-data.json（提取自独立的 Audit 示例系统）。
// UI（/api/audit/overview）与 agent 工具（audit__*）读同一份数据。
import { readFileSync, existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { CONFIG_DIR, activeProvider, loadModelConfig } from "./config.mjs";
import { memorySave, memoryRecall, memorySearch, memoryForget } from "./memory.mjs";
import { atomicWriteFile } from "./util.mjs";

const execFileAsync = promisify(execFile);

// ---- SSRF 防护（修复 SEC-03）----
// 原实现只校验 ^https?://，未拦截内网/回环/链路本地/云元数据地址，
// 且 redirect:"follow" 可被公网 302 跳转绕过。云主机上元数据地址
// （如 169.254.169.254、100.100.100.200）可达，可获取实例信息与临时凭据。
const PRIVATE_IP_RE = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,   // 云元数据段（含 100.100.100.200）
];
const BLOCKED_HOSTNAMES = /^(localhost|.*\.localhost|.*\.internal|metadata\.google\.internal)$/i;

/**
 * 判断一个 IP 字面量是否属于内网/保留地址（SSRF 防线）。
 * 修复：原实现只对 IPv4 字面量套 PRIVATE_IP_RE，IPv6 分支只挡 ::1 / fc00::/7 / fe80::/10。
 * 于是 IPv4-mapped IPv6（[::ffff:127.0.0.1]、[::ffff:169.254.169.254]）既不是 IPv4 字面量、
 * 又不匹配那三条 IPv6 规则，被当成"可用的公网字面量"直接放行，DNS 二次校验也被跳过 ——
 * 云元数据与环回服务由此可达。这里先把地址规范化（拆出 ::ffff: 映射、展开 8 段 hextet）再判定。
 */
const PRIVATE_IPV6_RE = [
  /^::$/,                      // 未指定地址
  /^::1$/,                     // 环回
  /^f[cd][0-9a-f]{2}:/,        // fc00::/7 唯一本地地址
  /^fe[89ab][0-9a-f]:/,        // fe80::/10 链路本地
];

function ipv6Hextets(addr) {
  // 返回 8 段 16 位整数；解析失败返回 null
  let head = addr;
  let tail = "";
  const dbl = addr.indexOf("::");
  if (dbl >= 0) {
    head = addr.slice(0, dbl);
    tail = addr.slice(dbl + 2);
  }
  const parse = (s) => (s === "" ? [] : s.split(":").filter((x) => x !== ""));
  const toVals = (parts) => {
    const vals = [];
    for (const part of parts) {
      if (part.includes(".")) {
        const v4 = part.split(".").map(Number);
        if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
        vals.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
        vals.push(parseInt(part, 16));
      }
    }
    return vals;
  };
  const left = toVals(parse(head));
  const right = toVals(parse(tail));
  if (left == null || right == null) return null;
  if (dbl < 0) return left.length === 8 ? left : null;
  const fill = 8 - left.length - right.length;
  if (fill < 1) return null;
  const merged = [...left, ...new Array(fill).fill(0), ...right];
  return merged.length === 8 ? merged : null;
}

export function isBlockedAddress(addrRaw) {
  const addr = String(addrRaw ?? "").replace(/^\[|\]$/g, "").toLowerCase();
  if (addr === "") return true;
  if (net.isIP(addr) === 4) return PRIVATE_IP_RE.some((r) => r.test(addr));
  if (net.isIP(addr) !== 6) return false;
  if (PRIVATE_IPV6_RE.some((r) => r.test(addr))) return true;
  const h = ipv6Hextets(addr);
  if (h == null) return true; // 解析不了的一律拒绝
  // IPv4-mapped (::ffff:a.b.c.d) 与 IPv4-compatible (::a.b.c.d)：按内层 IPv4 判定
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0) {
    const v4 = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
    if (h[5] === 0xffff || h[5] === 0) return PRIVATE_IP_RE.some((r) => r.test(v4)) || isBlockedAddress(v4);
  }
  // NAT64 64:ff9b::/96
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) {
    return isBlockedAddress(`${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`);
  }
  return false;
}

function assertPublicHost(hostRaw) {
  const host = String(hostRaw ?? "").replace(/^\[|\]$/g, "");
  if (host === "") throw new Error("URL 缺少主机名");
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(`禁止访问内网地址: ${host}`);
    return;
  }
  if (BLOCKED_HOSTNAMES.test(host)) throw new Error(`禁止访问内网地址: ${host}`);
}

/** 校验 URL 并解析 DNS，确保实际连接目标不是内网地址 */
async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { throw new Error("URL 格式不合法"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("仅支持 http:// 或 https://");
  assertPublicHost(u.hostname);
  if (!net.isIP(u.hostname.replace(/^\[|\]$/g, ""))) {
    let addrs;
    try { addrs = await lookup(u.hostname, { all: true }); } catch { throw new Error(`域名解析失败: ${u.hostname}`); }
    for (const a of addrs) assertPublicHost(a.address);
  }
  return u;
}

/** 手工跟随重定向（最多 3 跳），每跳都重新校验目标地址 */
async function safeFetch(rawUrl, init) {
  let current = await assertPublicUrl(rawUrl);
  for (let hop = 0; hop < 4; hop += 1) {
    const res = await fetch(current.toString(), { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop === 3) throw new Error("重定向次数过多");
      current = await assertPublicUrl(new URL(res.headers.get("location"), current).toString());
      continue;
    }
    return res;
  }
  throw new Error("重定向次数过多");
}

const SERVER_DIR = (() => {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd(); // 单文件构建产物：源文件定位不可用时以工作目录兜底
  }
})();
// 审计库放在可写配置目录（运行期在线编辑落盘于此）；缺失时从源文件引导一份
const SOURCE_DATA_FILE = path.resolve(SERVER_DIR, "..", "audit", "audit-data.json");
const DATA_FILE = path.join(CONFIG_DIR, "audit-data.json");
try {
  if (!existsSync(DATA_FILE) && existsSync(SOURCE_DATA_FILE)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(DATA_FILE, readFileSync(SOURCE_DATA_FILE));
  }
} catch {}

export function loadAuditData() {
  try {
    return JSON.parse(readFileSync(DATA_FILE, "utf8"));
  } catch (error) {
    if (existsSync(SOURCE_DATA_FILE)) return JSON.parse(readFileSync(SOURCE_DATA_FILE, "utf8"));
    throw new Error(`审计数据不可用: ${String(error?.message ?? error)}`);
  }
}

/** 在线编辑审计库（管理员）：对指定实体做增/改/删并落盘。
 *  loadAuditData 每次从磁盘读取，故 UI 与 agent 工具 audit__* 即时可见。 */
export function saveAuditRecord({ key, action = "update", index, patch, record, recordId }) {
  const EDITABLE_KEYS = new Set([
    ...Object.values(AUDIT_MODULES).flatMap((m) => m.keys),
  ]);
  if (typeof key !== "string" || !EDITABLE_KEYS.has(key)) {
    throw new Error(`不可编辑的实体：${key}`);
  }
  const data = loadAuditData();
  const target = data[key];
  if (Array.isArray(target)) {
    if (action === "add") {
      if (record == null || typeof record !== "object") throw new Error("新增记录格式错误");
      target.push(record);
    } else {
      // 修复（审批期间行号漂移）：把修改申请排入审批队列后，队列中的其它增删会让原
      // `index` 指向另一条记录 —— 主控点"批准"时改/删的其实是别人那一行（越权篡改留痕）。
      // 因此优先用入队时记下的稳定记录 id 在**批准时刻**重新定位；定位不到就明确报错，
      // 绝不静默回退到可能已经错位的行号。
      let i;
      if (recordId != null && String(recordId) !== "") {
        const want = String(recordId);
        i = target.findIndex((r) => r != null && typeof r === "object" && String(r.id ?? "") === want);
        if (i < 0) throw new Error(`记录已不存在或已被改动（id=${want}），本次申请作废，请重新提交`);
      } else {
        i = Number(index);
      }
      if (!Number.isInteger(i) || i < 0 || i >= target.length) throw new Error(`行号越界：${index}`);
      if (action === "delete") target.splice(i, 1);
      else if (action === "update") Object.assign(target[i], patch ?? {});
      else throw new Error(`未知操作：${action}`);
    }
  } else if (typeof target === "object" && target != null) {
    if (action !== "update") throw new Error("该实体仅支持整体字段修改");
    Object.assign(target, patch ?? {});
  } else {
    throw new Error(`实体不存在：${key}`);
  }
  // 修复：原来是整文件 writeFileSync，进程在写一半时崩溃/被杀会留下截断的 JSON，
  // 审计库直接损坏（loadAuditData 只能回退到只读的源文件，此后所有在线修改静默丢失）。
  atomicWriteFile(DATA_FILE, JSON.stringify(data, null, 2));
  return { ok: true, key, action };
}

/** 模块 → 实体键映射（前端审计页与 audit_module 工具共用同一分组） */
export const AUDIT_MODULES = {
  dashboard: {
    label: "仪表盘",
    keys: ["dashboardStats", "riskDistribution", "riskTrend", "departmentRisk", "highRiskAlerts"],
  },
  tasks: {
    label: "审计任务与底稿",
    keys: ["auditTasks", "workPapers", "workPaperTemplates", "evidences"],
  },
  compliance: {
    label: "合规法规库",
    keys: ["complianceRules", "complianceCheckResults", "complianceGaps"],
  },
  hr: {
    label: "人力合规审计",
    keys: ["employees", "recruitmentAudits", "workMonitors", "personnelChanges", "departureAudits", "personnelArchives"],
  },
  ai: {
    label: "AI 审计",
    keys: [
      "aiModels",
      "riskHeatmapData",
      "multimodalTasks",
      "fraudClues",
      "riskTrendComparisons",
      "riskMigrations",
      "riskQuantifications",
      "textAnalysisResults",
      "ocrResults",
      "voiceTranscriptionResults",
      "crossSystemAnalyses",
    ],
  },
  data: {
    label: "数据治理与权限",
    keys: ["accounts", "permissionMappings", "accountRequests", "accountChanges", "departureAccounts", "reconResult", "anomalyRecords"],
  },
  closure: {
    label: "风险闭环",
    keys: ["workflowTickets"],
  },
  system: {
    label: "系统与运营",
    keys: ["modelConfigs", "ruleConfigs", "systemLogs"],
  },
};

function pick(moduleId) {
  const d = loadAuditData();
  // 修复：AUDIT_MODULES 是普通对象字面量，原型链上的 "__proto__"/"constructor"/"toString" 等
  // 也会命中 `!= null`，随后 mod.keys 为 undefined → TypeError 被当成工具内部错误抛出。
  const mod = Object.hasOwn(AUDIT_MODULES, moduleId) ? AUDIT_MODULES[moduleId] : null;
  if (mod == null || !Array.isArray(mod.keys)) {
    return {
      error: `未知模块 ${moduleId}`,
      availableModules: Object.entries(AUDIT_MODULES).map(([id, m]) => ({ id, label: m.label })),
    };
  }
  const out = { module: moduleId, label: mod.label };
  for (const key of mod.keys) out[key] = d[key];
  return out;
}

// ---------------------------------------------------------------------------
// 联网 / 生成 / 本地代码 / 智能体协作 的底层实现
// ---------------------------------------------------------------------------

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDdg(href) {
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    return target ? decodeURIComponent(target) : href;
  } catch {
    return href;
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/**
 * 带字节上限的响应体读取。
 * 修复：AbortSignal.timeout 只约束**时间**不约束**字节**，原实现直接 res.text() 会把整个响应体
 * 缓冲进内存（stripHtml 还会再做近 10 次全量 replace，峰值 3-5 倍）。一个超大页面即可打爆进程。
 * 这里边读边计数，达到上限即停止并主动 cancel。
 */
async function readCappedText(res, maxBytes = 2 * 1024 * 1024) {
  if (res?.body == null) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < maxBytes) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value == null) continue;
      chunks.push(Buffer.from(value));
      size += value.length;
    }
  } catch {
    /* 读取中断：返回已拿到的前缀 */
  } finally {
    try { await reader.cancel(); } catch {}
  }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString("utf8");
}

/** Bing 解析（国内可达，作为首选引擎） */
async function bingSearch(query, limit) {
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&ensearch=0`;
  const res = await fetch(url, { headers: { "user-agent": UA, "accept-language": "zh-CN,zh;q=0.9" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`搜索服务返回 HTTP ${res.status}`);
  const html = await readCappedText(res, 1024 * 1024);
  const out = [];
  const blocks = html.split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    if (out.length >= limit) break;
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const snip = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    out.push({
      title: stripHtml(link[2]),
      url: link[1],
      snippet: snip ? stripHtml(snip[1]).slice(0, 300) : "",
    });
  }
  return out;
}

/** DuckDuckGo HTML 端点（无需 API Key；境外环境更稳，作为回退引擎） */
async function ddgSearch(query, limit) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "user-agent": UA },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`搜索服务返回 HTTP ${res.status}`);
  const html = await readCappedText(res, 1024 * 1024);
  const out = [];
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = linkRe.exec(html)) !== null && out.length < limit) {
    out.push({ title: stripHtml(m[2]), url: decodeDdg(m[1]) });
  }
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0;
  let s;
  while ((s = snipRe.exec(html)) !== null && i < out.length) {
    out[i].snippet = stripHtml(s[1]).slice(0, 300);
    i += 1;
  }
  return out;
}

/** 多引擎回退：Bing（国内可达）→ DuckDuckGo */
async function searchWeb(query, limit) {
  const engines = [
    { name: "bing", run: () => bingSearch(query, limit) },
    { name: "duckduckgo", run: () => ddgSearch(query, limit) },
  ];
  const errors = [];
  for (const engine of engines) {
    try {
      const results = await engine.run();
      if (results.length > 0) return { engine: engine.name, results };
      errors.push(`${engine.name}: 无结果`);
    } catch (error) {
      errors.push(`${engine.name}: ${String(error?.message ?? error)}`);
    }
  }
  throw new Error(`全部搜索引擎均失败 → ${errors.join(" | ")}`);
}

function generatedDir() {
  const dir = path.join(CONFIG_DIR, "generated");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** model.json 顶层 imageProvider：{ baseUrl, model, apiKey?, headers? } —— 独立于聊天供应商的生图接入 */
function loadImageProvider() {
  try {
    const cfg = loadModelConfig();
    const p = cfg?.imageProvider;
    if (p && typeof p.baseUrl === "string" && typeof p.model === "string") {
      const apiKey = typeof p.apiKey === "string" ? p.apiKey : undefined;
      return { ...p, apiKey, imageModel: p.model };
    }
  } catch {}
  return null;
}

/** 生成图片 —— 候选链自动降级（2026-09-10 实装，零配置可用）：
 *  1) model.json 顶层 imageProvider（kind=relay 走主控 /relay/image；否则 OpenAI 兼容 /images/generations）
 *  2) 自动探测：已配置的 OpenAI 兼容供应商里若有生图模型（qwen-image / gpt-image / dall-e / flux / seedream / kolors …），直接用
 *     （探测 /models 一次，结果缓存 10 分钟；供应商也可在 model.json 里显式写 imageModel）
 *  3) pollinations.ai 免费公共生图（无需密钥）
 *  任一环节成功即返回；全部失败时把每一环的原因一起抛出，模型据此如实告知用户。 */
const IMAGE_MODEL_RE = /^(qwen-image(?!-edit)|gpt-image|dall-e|flux|seedream|kolors|cogview|stable-diffusion|sd3|sdxl|imagen|hunyuan-image|wanx|z-image)/i;
const imageModelCache = new Map(); // providerId -> { model|null, at }
async function detectImageModel(provider) {
  if (typeof provider?.imageModel === "string" && provider.imageModel.trim() !== "") return provider.imageModel.trim();
  if (IMAGE_MODEL_RE.test(String(provider?.model ?? ""))) return provider.model;
  const cached = imageModelCache.get(provider.id);
  if (cached != null && Date.now() - cached.at < 10 * 60 * 1000) return cached.model;
  let model = null;
  try {
    const res = await fetch(String(provider.baseUrl).replace(/\/+$/, "") + "/models", {
      headers: { ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}), ...(provider.headers ?? {}) },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const payload = await res.json().catch(() => null);
      const ids = (payload?.data ?? []).map((m) => String(m?.id ?? "")).filter(Boolean);
      model = ids.find((id) => IMAGE_MODEL_RE.test(id)) ?? null;
    }
  } catch {}
  imageModelCache.set(provider.id, { model, at: Date.now() });
  return model;
}

function parseSize(size, fallback = 1024) {
  const [w, h] = String(size ?? `${fallback}x${fallback}`).split("x").map((v) => Math.min(1536, Math.max(256, Number(v) || fallback)));
  return [w, h];
}

async function saveImageFiles(items, tag) {
  const dir = generatedDir();
  const files = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    let buffer;
    let ext = "png";
    if (item.b64_json) buffer = Buffer.from(item.b64_json, "base64");
    else if (item.url) {
      // 修复：item.url 来自（第三方）生图供应商的响应，原实现直接 fetch：
      // 既没有内网地址校验（供应商可返回 http://127.0.0.1:... 让服务端代打内网），
      // 也没有大小上限（一个超大响应即可打爆内存）。改为复用 safeFetch + 8MB 上限。
      if (!/^https?:\/\//i.test(String(item.url))) throw new Error("图片地址协议不受支持");
      const img = await safeFetch(String(item.url), { signal: AbortSignal.timeout(60000) });
      if (!img.ok) throw new Error(`图片下载失败 HTTP ${img.status}`);
      const declared = Number(img.headers.get("content-length") ?? 0);
      if (declared > 8 * 1024 * 1024) throw new Error("图片超过 8MB 上限");
      const buf = Buffer.from(await img.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) throw new Error("图片超过 8MB 上限");
      buffer = buf;
      const ct = img.headers.get("content-type") ?? "";
      if (/jpe?g/i.test(ct) || /\.jpe?g(\?|$)/i.test(item.url)) ext = "jpg";
      else if (/webp/i.test(ct)) ext = "webp";
    } else continue;
    if (buffer.length < 200) throw new Error("返回的图片数据为空");
    const name = `img_${Date.now().toString(36)}_${tag}${i}.${ext}`;
    writeFileSync(path.join(dir, name), buffer);
    files.push({ path: `/generated/${name}`, revisedPrompt: item.revised_prompt ?? null });
  }
  if (files.length === 0) throw new Error("生图接口未返回图片");
  return files;
}

async function openAiImages(target, model, { prompt, size, count }) {
  const body = { model, prompt, n: Math.max(1, Math.min(Number(count) || 1, 4)) };
  if (size) body.size = size;
  const res = await fetch(String(target.baseUrl).replace(/\/+$/, "") + "/images/generations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(target.apiKey ? { authorization: `Bearer ${target.apiKey}` } : {}),
      ...(target.headers ?? {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(res.status === 404 ? `${target.baseUrl} 无 /images/generations 端点` : `HTTP ${res.status}: ${detail}`);
  }
  const payload = await res.json();
  return { model, size: size ?? "1024x1024", files: await saveImageFiles(payload?.data ?? [], "a") };
}

async function pollinationsImages({ prompt, size, count }) {
  const n = Math.max(1, Math.min(Number(count) || 1, 4));
  const [w, h] = parseSize(size, 1024);
  const items = [];
  for (let i = 0; i < n; i += 1) {
    const seed = Math.floor(Math.random() * 1e9);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(String(prompt).slice(0, 600))}?width=${w}&height=${h}&nologo=true&seed=${seed}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`pollinations HTTP ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!/^image\//i.test(ct)) throw new Error(`pollinations 返回非图片（${ct}）`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 200) throw new Error("pollinations 返回空图片");
    const ext = /jpe?g/i.test(ct) ? "jpg" : /webp/i.test(ct) ? "webp" : "png";
    const name = `img_${Date.now().toString(36)}_p${i}.${ext}`;
    writeFileSync(path.join(generatedDir(), name), buffer);
    items.push({ path: `/generated/${name}`, revisedPrompt: null });
  }
  return { model: "pollinations", size: `${w}x${h}`, files: items };
}

async function relayImages(imgProvider, { prompt, size, count }) {
  const n = Math.max(1, Math.min(Number(count) || 1, 4));
  const [w, h] = parseSize(size, 512);
  const files = [];
  for (let i = 0; i < n; i += 1) {
    const url = `${imgProvider.baseUrl.replace(/\/+$/, "")}/relay/image?k=${encodeURIComponent(imgProvider.apiKey ?? imgProvider.key ?? "")}&prompt=${encodeURIComponent(prompt)}&w=${w}&h=${h}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 120);
      throw new Error(res.status === 404 ? "生图中继未启用" : `生图中继失败 HTTP ${res.status}: ${detail}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200 || !/^image\//i.test(res.headers.get("content-type") ?? "")) throw new Error("中继返回的不是有效图片（0 字节或非图片）");
    const name = `img_${Date.now().toString(36)}_r${i}.jpg`;
    writeFileSync(path.join(generatedDir(), name), buf);
    files.push({ path: `/generated/${name}`, revisedPrompt: null });
  }
  return { model: "relay", size: `${w}x${h}`, files };
}

export async function generateImage({ prompt, size, count }) {
  const cfg = loadModelConfig();
  const imgProvider = cfg?.imageProvider;
  const attempts = [];
  const errors = [];
  if (imgProvider?.kind === "relay" && typeof imgProvider.baseUrl === "string") {
    attempts.push({ label: "relay", run: () => relayImages(imgProvider, { prompt, size, count }) });
  } else if (imgProvider && typeof imgProvider.baseUrl === "string" && typeof imgProvider.model === "string") {
    attempts.push({ label: `imageProvider(${imgProvider.model})`, run: () => openAiImages(imgProvider, imgProvider.model, { prompt, size, count }) });
  }
  // 自动探测：当前激活供应商优先，其余按配置顺序
  const providers = Object.values(cfg?.providers ?? {}).filter((p) => (p.protocol ?? "openai-compatible") === "openai-compatible" && typeof p.baseUrl === "string" && p.baseUrl !== "");
  const activeId = cfg?.active;
  providers.sort((a, b) => (a.id === activeId ? -1 : b.id === activeId ? 1 : 0));
  for (const p of providers) {
    attempts.push({
      label: `${p.id}`,
      run: async () => {
        const model = await detectImageModel(p);
        if (model == null) throw new Error("该供应商无生图模型");
        return openAiImages(p, model, { prompt, size, count });
      },
    });
  }
  attempts.push({ label: "pollinations", run: () => pollinationsImages({ prompt, size, count }) });
  for (const a of attempts) {
    try {
      const result = await a.run();
      return { ...result, via: a.label };
    } catch (error) {
      errors.push(`${a.label}: ${String(error?.message ?? error).slice(0, 160)}`);
    }
  }
  throw new Error(`生图失败（已尝试 ${attempts.length} 条通道）：${errors.join(" | ")}`);
}

/** python 解释器候选表（跨平台）。
 *  修复（2026-09-13）：原候选表以开发机私有路径（`<USERPROFILE>\.workbuddy\...`）打头，
 *  且**完全没有 POSIX 候选** —— 未装 python 的 Linux 上 `code_run(language:"python")` 必然失败。
 *  实测症状：让 AI"调用 code_run 算个数"，批准审批后拿到
 *  「内置工具执行失败: 未找到可用的 python，请确认已安装 Python 并加入 PATH」，
 *  即"AI 写代码"这一条在无 python 的机器上等于是死的。现在按平台给候选，并支持 VFLETCH_PYTHON 显式指定。 */
function pythonCandidates() {
  const env = String(process.env.VFLETCH_PYTHON ?? "").trim();
  const list = env === "" ? [] : [env];
  if (process.platform === "win32") {
    list.push(
      "<USERPROFILE>\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe",
      "<USERPROFILE>\\.workbuddy\\binaries\\python\\versions\\3.13.12\\python.exe",
      "python", "python3", "py",
    );
  } else {
    list.push("python3", "python", "/usr/bin/python3", "/usr/local/bin/python3", "/usr/bin/python");
  }
  return list;
}

/** 返回可用的 python 可执行文件；一个都没有时返回 null（由调用方给出"可改道"的提示，不再直接抛死错误） */
function findPython() {
  for (const c of pythonCandidates()) {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore", windowsHide: true });
      return c;
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null;
}

/** 在临时目录执行 node / python 片段，带超时与输出截断 */
async function runCode({ language, code, timeoutMs }) {
  const lang = String(language ?? "node").toLowerCase();
  const timeout = Math.min(Math.max(Number(timeoutMs) || 20000, 1000), 120000);
  if (typeof code !== "string" || code.trim() === "") throw new Error("code 不能为空");
  // 运行时先解析完再建临时目录：缺运行时属于"环境缺件"，不该留下空目录
  let ext;
  let cmd;
  let args;
  if (lang === "node" || lang === "js" || lang === "javascript") {
    ext = "run.mjs";
    cmd = process.execPath; // 服务本身跑在 node 上，node 运行时必然存在
    args = [];
  } else if (lang === "python" || lang === "py") {
    const py = findPython();
    if (py == null) {
      // 与"事中拦截"同一个设计思路：把失败原因说清楚并**给出可用替代**，让模型当场改道，
      // 而不是丢一句它无法处理的环境错误（实测模型收到原错误后只会道歉、给不出结果）。
      throw new Error(
        '本机没有可用的 python 运行时，但 node 一定可用。请把这段代码改写为 JavaScript（等价逻辑），然后以 language:"node" 重新调用本工具。'
        + "（管理员也可以在服务器上安装 python3，或用环境变量 VFLETCH_PYTHON 指向解释器）",
      );
    }
    ext = "run.py";
    cmd = py;
    args = [];
  } else {
    throw new Error(`暂不支持的语言: ${language}（目前支持 node / python）`);
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), "vfletch-code-"));
  const file = path.join(dir, ext);
  writeFileSync(file, code, "utf8");
  try {
    const { stdout, stderr } = await execFileAsync(cmd, [...args, file], {
      timeout,
      cwd: dir,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    return {
      language: lang,
      exitCode: 0,
      stdout: String(stdout ?? "").slice(0, 8000),
      stderr: String(stderr ?? "").slice(0, 2000),
    };
  } catch (error) {
    // Windows 下超时强杀的 error.code 不是 ETIMEDOUT（通常是退出码 1），需按 killed/signal 综合判定，
    // 并显式标注超时——否则模型只看到空输出，会误判成"代码正常执行但没结果"
    const timedOut = error?.killed === true || error?.signal != null || error?.code === "ETIMEDOUT";
    return {
      language: lang,
      exitCode: timedOut ? "timeout" : (error?.code ?? 1),
      timedOut,
      isError: timedOut,
      stdout: String(error?.stdout ?? "").slice(0, 8000),
      stderr: timedOut
        ? `执行超时（>${Math.round(timeout / 1000)}s），进程已被强制终止；如有部分输出见 stdout。请优化算法或分段执行。`
        : String(error?.stderr ?? error?.message ?? "").slice(0, 2000),
    };
  } finally {
    // 临时目录无论成败都清掉（长期运行的临时目录否则会堆积 vfletch-code-*）；Windows 句柄未释放时删不掉就交给系统清理
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch {}
  }
}

const TOOL_DEFS = [
  {
    name: "audit_overview",
    description: "审计风控总览：风险总数、待整改工单、账号健康度、交易异常率、风险类型分布与近 30 天趋势",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const d = loadAuditData();
      return {
        stats: d.dashboardStats,
        riskDistribution: d.riskDistribution,
        riskTrend: d.riskTrend,
        departmentRisk: d.departmentRisk,
      };
    },
  },
  {
    name: "audit_module",
    description:
      "按模块查询审计系统全部数据。模块：dashboard/tasks(任务与底稿)/compliance(合规法规)/hr(人力合规)/ai(AI审计与热力图)/data(数据治理)/closure(风险闭环)/system(系统与运营)",
    inputSchema: {
      type: "object",
      properties: {
        module: { type: "string", description: "模块 id，如 tasks / hr / ai / compliance" },
      },
      required: ["module"],
    },
    handler: (args) => pick(args?.module),
  },
  {
    name: "audit_tasks",
    description: "审计任务列表（含进度、负责人、截止时间与审计发现 findings），可按状态过滤：planning/sampling/fieldwork/reporting/closed",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", description: "可选，按任务状态过滤" },
      },
    },
    handler: (args) => {
      const d = loadAuditData();
      const list = (d.auditTasks ?? []).filter((t) => !args?.status || t.status === args.status);
      return { count: list.length, tasks: list };
    },
  },
  {
    name: "audit_risk_alerts",
    description: "高风险告警清单（越权访问、交易异常、账号风险等），可按部门过滤",
    inputSchema: {
      type: "object",
      properties: {
        department: { type: "string", description: "可选，按部门过滤，如 财务部" },
      },
    },
    handler: (args) => {
      const d = loadAuditData();
      const list = (d.highRiskAlerts ?? []).filter((a) => !args?.department || a.department === args.department);
      return { count: list.length, alerts: list };
    },
  },
  {
    name: "audit_compliance",
    description: "合规差距与检查结果：合规规则、最近检查结果（符合/不符合）、未关闭的合规差距",
    inputSchema: { type: "object", properties: {} },
    handler: () => {
      const d = loadAuditData();
      return {
        rules: d.complianceRules,
        checkResults: d.complianceCheckResults,
        openGaps: d.complianceGaps,
      };
    },
  },
  {
    name: "audit_heatmap",
    description: "部门×风险维度的风险热力图（分数、等级、趋势、AI 置信度）",
    inputSchema: { type: "object", properties: {} },
    handler: () => loadAuditData().riskHeatmapData,
  },
];

// ---- 联网检索 ----
const WEB_TOOLS = [
  {
    name: "web_search",
    description: "联网搜索，返回标题/链接/摘要。适合查最新政策、行情、法规、公开资料。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
        limit: { type: "number", description: "返回条数，默认 5，最大 10" },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const limit = Math.max(1, Math.min(Number(args?.limit) || 5, 10));
      const { engine, results } = await searchWeb(String(args?.query ?? ""), limit);
      return { query: args?.query, engine, count: results.length, results };
    },
  },
  {
    name: "web_fetch",
    description: "抓取指定网页的正文（自动剥离脚本/样式/标签），用于读取搜索结果的详细内容。",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "完整 URL，需含 http(s)://" },
        maxChars: { type: "number", description: "正文截断长度，默认 6000" },
      },
      required: ["url"],
    },
    handler: async (args) => {
      const url = String(args?.url ?? "");
      if (!/^https?:\/\//i.test(url)) throw new Error("url 必须以 http:// 或 https:// 开头");
      const maxChars = Math.max(500, Math.min(Number(args?.maxChars) || 6000, 30000));
      // 修复 SEC-03：先校验目标非内网，再手工跟随重定向（每跳重新校验）
      const res = await safeFetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) V-Fletch/1.0" },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`页面返回 HTTP ${res.status}`);
      const text = stripHtml(await readCappedText(res, 2 * 1024 * 1024));
      return { url, length: text.length, text: text.slice(0, maxChars) };
    },
  },
];

// ---- 图像生成 ----
const MEDIA_TOOLS = [
  {
    name: "image_generate",
    description:
      "生成位图（封面/插画/海报/照片感画面/示意图）。系统会自动选择可用的生图通道（已配置的生图模型或公共生图服务），无需用户额外配置。结果落盘后必须在回答中用 Markdown 图片语法原样引用返回的 path（如 ![封面](/generated/xxx.png)），用户才能看到图。注意：数据可视化图表（柱/线/饼/热力图）不要用本工具，直接在回复中输出 chart/svg 代码块。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "画面描述，越具体越好" },
        size: { type: "string", description: "尺寸，如 1024x1024 / 1536x1024，留空用默认" },
        count: { type: "number", description: "生成张数，默认 1，最大 4" },
      },
      required: ["prompt"],
    },
    handler: async (args) => generateImage(args ?? {}),
  },
];

// ---- 本地代码执行 ----
const CODE_TOOLS = [
  {
    name: "code_run",
    description:
      "在临时目录执行一段 node 或 python 代码（带超时与输出截断），返回 stdout/stderr。适合做数值计算、数据清洗、格式转换、生成图表数据。"
      + "注意：node 运行时在任何部署上都可用；python 需要服务器已安装，若本工具回报没有 python，请把逻辑改写为 JavaScript 并以 language=\"node\" 重试。",
    inputSchema: {
      type: "object",
      properties: {
        language: { type: "string", description: "node（始终可用）或 python（需服务器已安装）" },
        code: { type: "string", description: "要执行的完整代码" },
        timeoutMs: { type: "number", description: "超时毫秒，默认 20000，上限 120000" },
      },
      required: ["language", "code"],
    },
    handler: async (args) => runCode(args ?? {}),
  },
];

// ---- 智能体协作：任务清单 + 子代理委派 ----
const AGENT_TOOLS = [
  {
    name: "todo_write",
    description:
      "写入或更新任务清单（会实时展示给用户）。含 3 步以上的复杂任务必须先建清单再执行，每完成一步立即更新状态。",
    inputSchema: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "任务数组，每项 {id, text, status}",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "任务编号，如 1 / 2" },
              text: { type: "string", description: "任务描述，一句话、可执行" },
              status: { type: "string", description: "pending | in_progress | completed" },
            },
            required: ["id", "text", "status"],
          },
        },
      },
      required: ["tasks"],
    },
    handler: (args) => {
      const tasks = Array.isArray(args?.tasks) ? args.tasks : [];
      const done = tasks.filter((t) => t.status === "completed").length;
      return { ok: true, count: tasks.length, completed: done, tasks };
    },
  },
  {
    name: "delegate_agent",
    description:
      "把一个自包含的子任务派给专职子代理（独立上下文，子代理不能再派子代理）。适合资料检索、数据测算、文档撰写、结果复核。",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "researcher 检索 | analyst 测算 | writer 撰写 | reviewer 复核 | general 通用" },
        task: { type: "string", description: "任务描述，必须自包含：目标 + 期望输出格式 + 边界" },
        context: { type: "string", description: "传给子代理的背景资料（数据、原文、已得结论）" },
        tools: {
          type: "array",
          items: { type: "string" },
          description: "可选，允许子代理使用的只读工具：web_search / web_fetch / audit_* ",
        },
        maxRounds: { type: "number", description: "子代理工具轮次上限，默认 3" },
      },
      required: ["role", "task"],
    },
    handler: async (args) => {
      // 延迟 import，避免 builtin.mjs ↔ subagent.mjs 的初始化环
      const { runSubAgent, SUBAGENT_ROLES } = await import("./subagent.mjs");
      const role = String(args?.role ?? "general");
      if (!SUBAGENT_ROLES[role]) {
        throw new Error(`未知角色: ${role}（可选 ${Object.keys(SUBAGENT_ROLES).join(" / ")}）`);
      }
      const result = await runSubAgent({
        role,
        task: args?.task,
        context: args?.context,
        tools: args?.tools,
        maxRounds: args?.maxRounds,
      });
      return {
        role,
        label: result.label,
        toolsUsed: result.tools,
        output: result.text,
      };
    },
  },
];

// ---- 记忆库 ----
const MEMORY_TOOLS = [
  {
    name: "memory_save",
    description:
      "把需要跨会话记住的关键信息写入记忆库。仅限用户主动透露的长期事实（称谓、公司、项目、对接人、偏好）、确认的约定与结论、关键参数。禁止记录与本机/系统环境相关的信息（路径、主机名、硬件、操作系统、环境变量、IP 等），此类保存会被拒绝。key 用命名空间分段，如 user/称谓、项目/xx/对接人。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "命名空间 key，如 user/称谓" },
        content: { type: "string", description: "要记住的内容（≤2000 字）" },
        tags: { type: "array", items: { type: "string" }, description: "可选标签，便于检索" },
      },
      required: ["key", "content"],
    },
    handler: (args) => memorySave(args?.key, args?.content, args?.tags),
  },
  {
    name: "memory_recall",
    description: "读取记忆（需授权：仅当本轮用户消息提及“之前/上次/还记得/记忆”等历史指涉时可用，否则会被拒绝）。key 精确匹配；key 以 / 结尾或留空则按前缀列出多条。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "如 user/称谓 或项目/ 或留空列全部" },
        limit: { type: "number", description: "返回条数上限，默认 20" },
      },
    },
    handler: (args) => memoryRecall(args?.key, args?.limit),
  },
  {
    name: "memory_search",
    description: "按关键词全文检索记忆（需授权：仅当本轮用户消息提及历史/记忆时可用）。匹配 key/content/tags 的子串，返回最相关的若干条。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词" },
        limit: { type: "number", description: "返回条数上限，默认 5" },
      },
      required: ["query"],
    },
    handler: (args) => memorySearch(args?.query, args?.limit),
  },
  {
    name: "memory_forget",
    description: "删除记忆。key 精确匹配删除一条；以 / 结尾删除整个命名空间下的所有条目。",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "要删除的 key 或命名空间前缀" },
      },
      required: ["key"],
    },
    handler: (args) => memoryForget(args?.key),
  },
];

// ---- MCP 管理：聊天时自动安装/卸载/查看 MCP server ----
// 打破 builtin ↔ mcp-manager 循环依赖：由 main.mjs 注入 ref
let mcpAdminRef = null;
export function bindMcpAdmin(ref) {
  mcpAdminRef = ref;
}

const MCP_ADMIN_TOOLS = [
  {
    name: "mcp_install",
    description:
      "安装或更新一个 MCP server（写回 config/mcp.json 并立即重连）。用户说“装一个 X MCP / 接入 X 数据源”时调用。stdio 传 command+args，http 传 url。密钥用 'env:VAR_NAME' 引用环境变量，不要明文落盘。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "唯一 id（小写字母数字下划线），如 github / finance" },
        name: { type: "string", description: "显示名，如 GitHub" },
        transport: { type: "string", description: "stdio（本地命令）或 http（远程端点）" },
        command: { type: "string", description: "stdio 用：启动命令，Windows 用 npx.cmd 或 node 绝对路径" },
        args: { type: "array", items: { type: "string" }, description: "stdio 用：命令参数数组" },
        url: { type: "string", description: "http 用：端点 URL，如 https://api.githubcopilot.com/mcp/" },
        headers: { type: "object", description: "http 用：请求头，密钥用 'env:VAR_NAME'" },
        env: { type: "object", description: "stdio 用：环境变量，密钥用 'env:VAR_NAME'" },
        enabled: { type: "boolean", description: "是否立即启用，默认 true" },
      },
      required: ["id", "transport"],
    },
    handler: async (args) => {
      if (mcpAdminRef == null) throw new Error("MCP 管理器未就绪");
      return mcpAdminRef.install(args);
    },
  },
  {
    name: "mcp_uninstall",
    description: "卸载一个 MCP server（从 config/mcp.json 移除并重连）。用户说“卸掉/移除 X MCP”时调用。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "要卸载的 server id" },
      },
      required: ["id"],
    },
    handler: async (args) => {
      if (mcpAdminRef == null) throw new Error("MCP 管理器未就绪");
      return mcpAdminRef.uninstall(args?.id);
    },
  },
  {
    name: "mcp_list",
    description: "列出当前所有 MCP server 及连接状态、工具数量。用户问“现在装了哪些 MCP / 有哪些工具”时调用。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      if (mcpAdminRef == null) throw new Error("MCP 管理器未就绪");
      return mcpAdminRef.list();
    },
  },
];

// ---- AI 秘书只读工具：主控可让模型"随意拿服务器数据"，但绝不能改动数据与代码 ----
// 隔离手段：① 独立的 readOnly SQLite 连接（写操作在驱动层直接报错）② 只允许 SELECT/WITH/EXPLAIN 单语句
// ③ 文件只读且限制在应用根 / 工作区 / 配置目录内，禁止越界；④ 工具集只在主控×AI 秘书会话暴露（main.mjs 沙盒）
let secretaryDb = null;
async function secretaryReadOnlyDb() {
  if (secretaryDb != null) return secretaryDb;
  const { DatabaseSync } = await import("node:sqlite");
  const { DB_FILE } = await import("./db.mjs");
  secretaryDb = new DatabaseSync(DB_FILE, { readOnly: true });
  secretaryDb.exec("PRAGMA busy_timeout = 3000;");
  return secretaryDb;
}
function secretaryRoots() {
  return [process.env.VFLETCH_ROOT ?? process.cwd(), process.env.VFLETCH_WORKSPACE ?? process.cwd(), CONFIG_DIR]
    .map((p) => realpathOr(p));
}
/** realpath，失败时退回 path.resolve（文件/目录尚不存在） */
function realpathOr(p) {
  const abs = path.resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    return abs;
  }
}
function secretaryResolve(p) {
  const target = path.resolve(String(p ?? ""));
  // 修复：原来只做 path.resolve + 字符串前缀比较，目录联接/符号链接（mklink /J 在 Windows 无需管理员）
  // 可以指向允许根之外的任意位置而仍然通过前缀检查。改为对真实路径（realpath）做包含判定。
  const real = realpathOr(target);
  const roots = secretaryRoots();
  if (!roots.some((root) => real === root || real.startsWith(root + path.sep))) {
    throw new Error(`路径越界（只允许应用根/工作区/配置目录）: ${target}`);
  }
  // 数据库文件（含 -wal/-shm/-journal 及任何备份副本）一律不给读，避免绕过 db_query 的列级脱敏
  if (/(^|[\\/])vfletch\.db([.\-][^\\/]*)?$/i.test(real)) throw new Error("数据库文件请用 db_query 查询");
  return target;
}
// 凭据类列一律脱敏后再交给模型：db_query 结果是会进入模型上下文（并可能被外发）的
const REDACTED_COLUMNS = new Set(["password_hash", "token", "api_key", "apikey", "secret", "password", "relay_key", "report_key"]);function redactRowSecrets(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = REDACTED_COLUMNS.has(String(key).toLowerCase()) && value != null ? "[已脱敏]" : value;
    }
    return out;
  });
}

/** 解析 JSON 数组字段；脏数据退化为 []，不让整个工具调用失败 */
function safeJsonArray(raw) {
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const SECRETARY_TOOLS = [
  {
    name: "db_query",
    description: "对系统 SQLite 全库执行只读 SQL（仅 SELECT/WITH/EXPLAIN，单条语句，最多返回 200 行）。可先用 db_schema 看表结构。任何写操作会被只读连接直接拒绝；口令/令牌等凭据列自动脱敏。",
    inputSchema: {
      type: "object",
      properties: { sql: { type: "string", description: "只读 SQL" }, limit: { type: "number", description: "最大行数，默认 100，上限 200" } },
      required: ["sql"],
    },
    handler: async (args) => {
      const sql = String(args?.sql ?? "").trim().replace(/;\s*$/, "");
      if (sql === "") throw new Error("sql 不能为空");
      if (sql.includes(";")) throw new Error("只允许单条语句");
      if (!/^(SELECT|WITH|EXPLAIN|PRAGMA\s+table_info|PRAGMA\s+table_list)\b/i.test(sql)) throw new Error("只允许 SELECT / WITH / EXPLAIN 只读语句");
      if (/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|VACUUM|REINDEX)\b/i.test(sql)) throw new Error("检测到写操作关键字，已拒绝");
      // 无界递归 CTE 在 SQLite 里不会终止（也没有 statement timeout 可用）：直接拒绝
      if (/\bWITH\s+RECURSIVE\b/i.test(sql) && !/\bLIMIT\b/i.test(sql)) throw new Error("递归 CTE 必须自带 LIMIT，否则可能无界执行");
      const limit = Math.min(200, Math.max(1, Number(args?.limit) || 100));
      const db = await secretaryReadOnlyDb();
      const t0 = Date.now();
      // 修复：原实现 `.all().slice(0, limit)` 是"先物化全部结果再截断"——node:sqlite 是同步 API，
      // 一条自连接（SELECT * FROM messages, messages m2）会在 SQLite 内堆到整库行数平方，
      // 直接耗尽 V8 堆把**整个服务进程**打挂（实测 OOM）。改为把行数上限下推进 SQL，
      // SQLite 增量产出到 limit 行即停，不再物化全集。
      let rows;
      if (/^(SELECT|WITH)\b/i.test(sql)) {
        rows = db.prepare(`SELECT * FROM (${sql}) LIMIT ?`).all(limit);
      } else {
        rows = db.prepare(sql).all().slice(0, limit);
      }
      return { rows: rows.length, limit, elapsedMs: Date.now() - t0, data: redactRowSecrets(rows) };
    },
  },
  {
    name: "db_schema",
    description: "列出系统数据库全部表及其列定义（只读）。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const db = await secretaryReadOnlyDb();
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
      return tables.map((t) => ({
        table: t.name,
        columns: db.prepare(`PRAGMA table_info("${String(t.name).replaceAll('"', '""')}")`).all().map((c) => `${c.name} ${c.type}${c.pk ? " PK" : ""}`),
      }));
    },
  },
  {
    name: "system_status",
    description: "系统运行状态：进程/内存/版本/在线用户/会话与用量统计/MCP 状态/已配置模型（只读）。",
    inputSchema: { type: "object", properties: {} },
    handler: async () => {
      const db = await secretaryReadOnlyDb();
      const q = (sql) => { try { return db.prepare(sql).get(); } catch (e) { return { error: String(e?.message ?? e) }; } };
      const onlineSince = new Date(Date.now() - 3 * 60 * 1000).toISOString();
      const mem = process.memoryUsage();
      return {
        process: { pid: process.pid, node: process.version, electron: process.versions.electron ?? null, uptimeSec: Math.round(process.uptime()), rssMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576), platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length },
        paths: { configDir: CONFIG_DIR, workspace: process.env.VFLETCH_WORKSPACE ?? process.cwd(), appRoot: process.env.VFLETCH_ROOT ?? process.cwd() },
        users: { total: q("SELECT COUNT(*) AS n FROM users")?.n, active: q("SELECT COUNT(*) AS n FROM users WHERE status='active'")?.n, onlineNow: q(`SELECT COUNT(DISTINCT user_id) AS n FROM auth_sessions WHERE last_seen >= '${onlineSince}'`)?.n, sessions: q("SELECT COUNT(*) AS n FROM auth_sessions")?.n },
        activity: { conversations: q("SELECT COUNT(*) AS n FROM conversations")?.n, messages: q("SELECT COUNT(*) AS n FROM messages")?.n, openRisks: q("SELECT COUNT(*) AS n FROM risk_events WHERE status='open'")?.n, tasks: q("SELECT COUNT(*) AS n FROM tasks")?.n, kbDocs: q("SELECT COUNT(*) AS n FROM kb_docs WHERE status='active'")?.n },
        usage: q("SELECT COUNT(*) AS calls, COALESCE(SUM(prompt_tokens),0) AS promptTokens, COALESCE(SUM(completion_tokens),0) AS completionTokens FROM usage_log"),
        mcp: mcpAdminRef?.list?.()?.servers?.map((s) => ({ id: s.id, status: s.status, tools: s.tools?.length ?? 0, error: s.error ?? null })) ?? null,
        models: Object.values(loadModelConfig().providers ?? {}).map((p) => ({ id: p.id, label: p.label, model: p.model, baseUrl: p.baseUrl, hasKey: (p.apiKey ?? "") !== "" })),
      };
    },
  },
  {
    name: "read_file",
    description: "只读读取应用根/工作区/配置目录内的文本文件（最多 64KB）。用于查看日志、配置、上传的文件。",
    inputSchema: { type: "object", properties: { path: { type: "string" }, maxBytes: { type: "number" } }, required: ["path"] },
    handler: async (args) => {
      const target = secretaryResolve(args?.path);
      if (!existsSync(target)) throw new Error(`文件不存在: ${target}`);
      const { statSync, openSync, readSync, closeSync } = await import("node:fs");
      const st = statSync(target);
      if (!st.isFile()) throw new Error("不是文件");
      const cap = Math.min(65536, Math.max(256, Number(args?.maxBytes) || 65536));
      // 修复：原实现 readFileSync(target) 先把**整个文件**读进内存，再 subarray 截断到 64KB。
      // 工作区里的 GB 级附件/日志会直接把进程读爆。改为只读文件头部 cap 字节。
      const want = Math.min(cap, st.size);
      const buf = Buffer.alloc(want);
      const fd = openSync(target, "r");
      let read = 0;
      try {
        read = readSync(fd, buf, 0, want, 0);
      } finally {
        closeSync(fd);
      }
      return { path: target, size: st.size, truncated: st.size > cap, content: buf.subarray(0, read).toString("utf8") };
    },
  },
  {
    name: "list_dir",
    description: "列出应用根/工作区/配置目录内某目录的内容（只读）。",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    handler: async (args) => {
      const target = secretaryResolve(args?.path);
      const { readdirSync, statSync } = await import("node:fs");
      if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`目录不存在: ${target}`);
      return readdirSync(target).slice(0, 300).map((name) => {
        try {
          const st = statSync(path.join(target, name));
          return { name, type: st.isDirectory() ? "dir" : "file", size: st.size, mtime: st.mtime.toISOString() };
        } catch {
          return { name };
        }
      });
    },
  },
];

// ---- MCP 发现与提案（目录检索 + 人工审批安装）----
// search：任何会话可用（只读目录检索）；propose：任何会话可提交提案；
// 真正的安装只在主控批准提案后发生（main.mjs 审批路由 → mcp.installServer）。
// agent 因此获得"按任务主动寻找合适插件"的泛化能力，同时安装闸门始终握在人手里。
const MCP_DISCOVERY_TOOLS = [
  {
    name: "mcp_search",
    description:
      "检索 MCP 目录：按任务需要搜索可安装的 MCP server（文件/数据库/办公文档/浏览器/搜索/金融/GitHub 等）。接到任务但发现缺工具时，先用本工具查找合适的能力，再把候选提交安装提案。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "任务需要的能力描述，如 编辑 excel 表格 / 读写数据库 / 操作浏览器" },
        category: { type: "string", description: "可选：限定类别（文件/研发/办公/数据/网络/金融/协作/工具）" },
      },
      required: ["query"],
    },
    handler: async (args) => {
      const { searchCatalog } = await import("./mcp-catalog.mjs");
      const { all: dbAll } = await import("./db.mjs");
      let installedIds = [];
      try {
        installedIds = dbAll("SELECT id FROM mcp_servers_state WHERE 1").map((r) => r.id);
      } catch {}
      // 已安装列表以 mcp_admin 快照为准（此处用 mcp.json 名单近似）
      let configured = [];
      try {
        const cfg = JSON.parse((await import("node:fs")).readFileSync((await import("./config.mjs")).CONFIG_DIR + "/mcp.json", "utf8"));
        configured = (cfg.servers ?? []).filter((s) => s.enabled !== false).map((s) => s.id);
      } catch {}
      const exclude = [...new Set([...installedIds, ...configured])];
      const hits = searchCatalog(args?.query, { category: args?.category, excludeIds: exclude });
      return {
        query: args?.query ?? "",
        matches: hits,
        hint: hits.length > 0
          ? "如需安装某项，调用 mcp_propose 提交安装提案（需主控审批后生效）。"
          : "目录中没有匹配项；可直接描述需求，或让主控在 MCP 页手动添加。",
      };
    },
  },
  {
    name: "mcp_propose",
    description:
      "把一个目录中的 MCP server 提交为安装提案（需主控审批后才真正安装）。先 mcp_search 找到候选，再用其 id 提交，并附上任务理由。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "目录条目 id（来自 mcp_search 结果）" },
        reason: { type: "string", description: "安装理由：当前任务为什么需要它" },
      },
      required: ["id", "reason"],
    },
    handler: async (args) => {
      const { getCatalogEntry } = await import("./mcp-catalog.mjs");
      const entry = getCatalogEntry(args?.id);
      if (entry == null) throw new Error(`目录中不存在该条目: ${args?.id}`);
      // 已安装/已配置的同能力 server：直接告知，不产生重复提案
      let configuredIds = [];
      try {
        const cfg = JSON.parse((await import("node:fs")).readFileSync((await import("./config.mjs")).CONFIG_DIR + "/mcp.json", "utf8"));
        configuredIds = (cfg.servers ?? []).filter((s) => s.enabled !== false).map((s) => s.id);
      } catch {}
      if (configuredIds.includes(entry.id)) {
        return { ok: true, status: "already_installed", message: `该能力已安装（${entry.name}），无需重复提交提案，可直接使用。` };
      }
      const { run: dbRun, get: dbGet } = await import("./db.mjs");
      // 调用者身份（run-context 由 /api/mcp/call 注入；聊天路径由 handleChat 注入）
      const who = (await import("./run-context.mjs")).getContext() ?? {};
      const dup = dbGet("SELECT id, status FROM mcp_proposals WHERE catalog_id = ? AND status = 'pending'", entry.id);
      if (dup != null) return { ok: true, proposalId: dup.id, status: "pending", message: "同名提案已在审批队列中，无需重复提交" };
      const id = `prop_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      // 存储完整安装定义（含 id/name/env 映射），批准后可直接 installServer。
      // 需密钥的条目（envKeys 非空）标记 draft：批准后先落盘为停用草稿，主控补齐密钥再启用，
      // 否则批准瞬间因缺密钥连接失败、回滚，这类条目永远装不上。
      const definition = { id: entry.id, name: entry.name, enabled: true, ...entry.spec, env: Object.fromEntries((entry.envKeys ?? []).map((k) => [k, `env:${k}`])) };
      if ((entry.envKeys ?? []).length > 0) definition.draft = true;
      dbRun(
        "INSERT INTO mcp_proposals (id, catalog_id, spec, reason, requested_by, role) VALUES (?,?,?,?,?,?)",
        id, entry.id, JSON.stringify(definition), String(args?.reason ?? "").slice(0, 300), who.username ?? who.userId ?? "unknown", who.role ?? null,
      );
      return {
        ok: true, proposalId: id, catalogId: entry.id, name: entry.name,
        status: "pending",
        message: `安装提案已提交：${entry.name}（需主控在「MCP 页 → 待审批提案」批准后生效）。批准前不会安装。`,
      };
    },
  },
];

export const BUILTIN_SERVERS = {
  kb: {
    id: "kb",
    name: "企业知识库",
    transport: "builtin",
    description: "企业共享知识库检索（内置，全员共享）",
    tools: [
      {
        name: "kb_search",
        description:
          "检索企业共享知识库（全员共享的制度/规范/项目资料）。用户问及公司内部知识、制度、流程，或回答需要企业内部依据时调用；知识库为空时如实告知。",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "检索关键词" },
          },
          required: ["query"],
        },
        handler: async (args) => {
          const { all: kbAll } = await import("./db.mjs");
          const q = String(args?.query ?? "").trim().slice(0, 200);
          const total = kbAll("SELECT COUNT(*) AS c FROM kb_docs WHERE status = 'active'")[0]?.c ?? 0;
          if (total === 0) return { hits: 0, message: "知识库当前为空（正在筹备中）", total: 0 };
          // 分词 OR 匹配 + 命中度排序：模型传入的查询往往长短语，整短语 LIKE 会漏
          // CJK 无空格长查询召回增强：>6 字的词追加 2 字滑窗碎片（"差旅住宿标准是多少钱一晚"→"差旅/住宿/标准"…）
          let tokens = q.split(/[\s,，。;；、/\\]+/).map((t) => t.trim()).filter((t) => t.length >= 2);
          const shingles = [];
          for (const t of tokens) {
            if (/^[\u4e00-\u9fa5]{7,}$/.test(t)) {
              for (let i = 0; i + 2 <= t.length; i += 2) shingles.push(t.slice(i, i + 2));
              shingles.push(t.slice(-2));
            }
          }
          // 修复：q 原本无长度上限，长 CJK 查询经 2 字滑窗会展开成上千个 token，
          // 拼出几百 KB 的 SQL（每个 token 2 个绑定参数），SQLite 直接报
          // "Expression tree is too large" / "LIKE or GLOB pattern too complex"。
          // 查询截到 200 字符、token 数封顶 24，并转义 LIKE 通配符。
          tokens = [...new Set([...tokens, ...shingles])].slice(0, 24);
          const like = (t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
          const docs = tokens.length > 0
            ? kbAll(
                `SELECT id, title, content, tags, updated_at FROM kb_docs
                 WHERE status = 'active' AND (${tokens.map(() => "(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')").join(" OR ")})
                 ORDER BY updated_at DESC LIMIT 20`,
                ...tokens.flatMap((t) => [like(t), like(t)]),
              )
            : kbAll("SELECT id, title, content, tags, updated_at FROM kb_docs WHERE status = 'active' ORDER BY updated_at DESC LIMIT 20");
          const scored = docs
            .map((r) => {
              const hay = `${r.title} ${r.content} ${r.tags ?? ""}`;
              const hits = tokens.filter((t) => hay.includes(t)).length;
              return { score: hits, ...r };
            })
            .sort((x, y) => y.score - x.score)
            .slice(0, 8);
          if (scored.length === 0) return { hits: 0, total, message: `知识库共 ${total} 篇，但没有匹配「${q}」的内容` };
          return {
            hits: scored.length,
            total,
            // 结构化引用（Ragas retrieved_contexts 口径 + 前端"引用来源"展示）
            sources: scored.map((r) => ({ docId: r.id, title: r.title, excerpt: String(r.content).slice(0, 200), score: r.score })),
            docs: scored.map((r) => ({ docId: r.id, title: r.title, excerpt: String(r.content).slice(0, 300), tags: safeJsonArray(r.tags), updatedAt: r.updated_at })),
          };
        },
      },
    ],
  },
  aigc: {
    id: "aigc",
    name: "AI 生成监测",
    transport: "builtin",
    description: "AI 生成率与幻觉率实时监测（内置）",
    tools: [
      {
        name: "aigc_report",
        description:
          "查询 AI 生成内容监测报告：总体 AI 生成率、幻觉率（无依据数值主张占比）、24 小时趋势、各 AI 员工分布、待复核告警。用户问\u201cAI 生成率/幻觉率/内容可信度\u201d时调用。",
        inputSchema: { type: "object", properties: {} },
        handler: async () => {
          const { aigcOverview } = await import("./aigc-monitor.mjs");
          return aigcOverview();
        },
      },
    ],
  },
  audit: {
    id: "audit",
    name: "审计风控",
    transport: "builtin",
    description: "科创企业人力财务风控审计数据（内置，无外部依赖）",
    tools: TOOL_DEFS,
  },
  web: {
    id: "web",
    name: "联网检索",
    transport: "builtin",
    description: "网页搜索与正文抓取（内置，无需 API Key）",
    tools: WEB_TOOLS,
  },
  media: {
    id: "media",
    name: "图像生成",
    transport: "builtin",
    description: "调用已接入模型的图像生成接口（内置）",
    tools: MEDIA_TOOLS,
  },
  code: {
    id: "code",
    name: "本地代码",
    transport: "builtin",
    description: "在临时目录执行 node / python 片段（带超时与输出上限；注意：不是安全沙箱，以服务进程身份运行，具备同等文件/网络权限）",
    tools: CODE_TOOLS,
  },
  agent: {
    id: "agent",
    name: "智能体协作",
    transport: "builtin",
    description: "任务清单与子代理委派（内置，多智能体协作）",
    tools: AGENT_TOOLS,
  },
  memory: {
    id: "memory",
    name: "记忆库（内置）",
    transport: "builtin",
    description: "跨会话关键信息持久化：记忆保存/读取/检索/删除（内置，无外部依赖）",
    tools: MEMORY_TOOLS,
  },
  mcp_admin: {
    id: "mcp_admin",
    name: "MCP 管理（内置）",
    transport: "builtin",
    description: "查看已接入的 MCP server（只读）；安装/卸载走 MCP 页与提案审批，不对模型开放",
    tools: MCP_ADMIN_TOOLS,
  },
  mcp_discovery: {
    id: "mcp_discovery",
    name: "MCP 发现与提案（内置）",
    transport: "builtin",
    description: "目录化检索可安装的 MCP server，并提交安装提案（审批制）",
    tools: MCP_DISCOVERY_TOOLS,
  },
  secretary: {
    id: "secretary",
    name: "AI 秘书 · 系统只读（内置）",
    transport: "builtin",
    description: "主控专属 AI 秘书的系统只读工具：全库只读查询 / 系统状态 / 工作区文件读取（只读连接，物理上不可写）",
    tools: SECRETARY_TOOLS,
  },
};

/** 全部内置工具（子代理工具白名单与注册表基于它） */
export const ALL_TOOL_DEFS = [
  ...TOOL_DEFS,
  ...WEB_TOOLS,
  ...MEDIA_TOOLS,
  ...CODE_TOOLS,
  ...AGENT_TOOLS,
  ...MEMORY_TOOLS,
];
