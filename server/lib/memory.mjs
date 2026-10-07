// V-Fletch 记忆库（内置）：把 agent 需要跨会话记住的关键信息持久化到 JSON 文件。
//
// 存储结构（CONFIG_DIR/memory.json）：
// {
//   "version": 1,
//   "entries": {
//     "<key>": { "key", "content", "tags": [], "updatedAt": ISO, "accessCount": 0 }
//   }
// }
// key 约定用命名空间斜杠分段，例如 "user/称谓"、"项目/茂才咨询/对接人"、"偏好/输出格式"。
//
// 隐私策略（v2）：
//  1. 不记录任何与本机/系统环境相关的信息（路径、盘符、主机名、用户目录、硬件配置、
//     操作系统、环境变量、IP 等）——memory_save 直接拒绝并说明原因；
//  2. 不再每轮自动注入记忆摘要（如需开启：model.json defaults.memoryAutoInject = true）；
//  3. 检索（recall/search/forget）需用户授权：仅当本轮用户消息明确提及“之前/上次/还记得/
//     记忆”等历史指涉时才放行；否则工具返回未授权提示，模型应先征得用户同意。
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config.mjs";
import { atomicWriteFile } from "./util.mjs";

const FILE = path.join(CONFIG_DIR, "memory.json");
const MAX_ENTRIES = 500;
const MAX_CONTENT = 2000;

// ---- 本机/系统环境内容识别（保存即拒绝） ----
const MACHINE_PATTERNS = [
  /[a-z]:[\\/][^\s"']{2,}/i,            // Windows 路径 C:\Users\...
  /\\\\[a-z0-9_-]+\\[^\s"']+/i,          // UNC 路径
  /\/(home|Users|root|var|etc|opt)\//i,  // Unix 系统路径
  /%[a-z_]+%/i,                          // 环境变量 %APPDATA%
  /\b(APPDATA|LOCALAPPDATA|USERPROFILE|TEMP|TMP|PATH|HOME)\b\s*=/i,
  /\b(192\.168|10\.\d+|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+\b/, // 内网 IP
  /\b([0-9a-f]{2}:){5}[0-9a-f]{2}\b/i,   // MAC 地址
  /\b(win1[01]|windows\s*\d+|macos|ventura|sonoma|ubuntu|debian|centos)\b/i,
  /\b(cpu|gpu|显卡|处理器|内存条|硬盘|固态|主板|主机名|计算机名|系统盘|环境变量|盘符)\b/i,
  /\b(本机|这台电脑|该电脑|系统目录|用户目录|桌面路径|安装目录|工作目录)\b/i,
  /\b(desktop-[a-z0-9]+|microsoftaccount\\|legion)\b/i,
];
const MACHINE_KEY_RE = /^(系统|本机|设备|主机|电脑|环境|路径|env|machine|host|device)\b|^(系统|本机|设备|主机|电脑|环境|路径)\//i;

export function isMachineRelated(key, content) {
  const k = String(key ?? "");
  const c = String(content ?? "");
  if (MACHINE_KEY_RE.test(k)) return true;
  return MACHINE_PATTERNS.some((re) => re.test(k) || re.test(c));
}

// ---- 检索授权：本轮用户消息是否明确指涉历史/记忆 ----
const CONSENT_RE = /(之前|上次|上回|以前|此前|早先|曾经|还记得|记得|说过|提过|历史|记忆|上次说|之前聊)/;
const FORGET_RE = /(忘记|删掉|删除|清除|不要记|别记|抹掉)/;

// 授权状态存于请求级 AsyncLocalStorage 上下文（server/lib/run-context.mjs）：
// 并发轮次各自持有独立授权，不再互相覆盖；无上下文的调用（如 /api/mcp/call 手动测试）一律视为未授权。
import { contextValue, getContext } from "./run-context.mjs";

function freshConsent(text) {
  return { recall: CONSENT_RE.test(text), forget: FORGET_RE.test(text), userText: text };
}

/** 每轮对话开始时由 chat 回路调用：根据用户消息判定本轮记忆访问授权（写入当前请求上下文） */
export function beginMemoryTurn(userText) {
  const text = String(userText ?? "");
  const store = getContext();
  const consent = freshConsent(text);
  if (store != null) store.memoryConsent = consent;
  return consent;
}

export function memoryTurnConsent() {
  const consent = contextValue("memoryConsent");
  return consent != null ? { ...consent } : { recall: false, forget: false, userText: "" };
}

let cache = null;

function load() {
  if (cache != null) return cache;
  let data = null;
  if (existsSync(FILE)) {
    try {
      data = JSON.parse(readFileSync(FILE, "utf8"));
    } catch {
      data = null;
    }
  }
  // entries 挂在 null 原型上：即使持久化文件被写入 __proto__ 等键也不会污染 Object.prototype
  const entries = Object.assign(Object.create(null), data?.version === 1 ? data.entries ?? {} : {});
  cache = { version: 1, entries };
  return cache;
}

function persist() {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    atomicWriteFile(FILE, JSON.stringify(cache, null, 2));
  } catch (error) {
    throw new Error(`记忆库写入失败: ${String(error?.message ?? error)}`);
  }
}

function evictIfNeeded() {
  const entries = Object.values(cache.entries);
  if (entries.length <= MAX_ENTRIES) return;
  const sorted = entries.sort(
    (a, b) => a.accessCount - b.accessCount || (a.updatedAt > b.updatedAt ? -1 : 1),
  );
  for (const entry of sorted.slice(0, entries.length - MAX_ENTRIES)) {
    delete cache.entries[entry.key];
  }
}

export function memorySave(key, content, tags) {
  const k = String(key ?? "").trim();
  const c = String(content ?? "").trim();
  if (k === "") throw new Error("memory_save: key 不能为空（建议形如 user/称谓、项目/xx/结论）");
  if (c === "") throw new Error("memory_save: content 不能为空");
  // 修复审计 A6（原型污染）：key 来自模型/用户，__proto__/constructor/prototype
  // 作为对象键直赋会污染 Object.prototype，影响后续所有对象行为。
  if (/^(?:__proto__|constructor|prototype)$/i.test(k)) {
    throw new Error("memory_save: key 不能使用保留标识符");
  }
  if (isMachineRelated(k, c)) {
    throw new Error(
      "memory_save 已拒绝：记忆库不记录与本机/系统环境相关的信息（路径、盘符、主机名、用户目录、硬件、操作系统、环境变量、IP 等）。只保存用户主动透露的长期事实、约定与业务参数。",
    );
  }
  const data = load();
  const now = new Date().toISOString();
  const prev = data.entries[k];
  data.entries[k] = {
    key: k,
    content: c.slice(0, MAX_CONTENT),
    tags: Array.isArray(tags) ? tags.slice(0, 10).map(String) : [],
    updatedAt: now,
    accessCount: (prev?.accessCount ?? 0) + 1,
  };
  evictIfNeeded();
  persist();
  return { ok: true, key: k, updatedAt: now };
}

/** key 为空 → 全部（限 limit）；否则精确匹配；末尾带 / → 前缀检索。需本轮用户提及历史（授权） */
export function memoryRecall(key, limit = 20) {
  if (!memoryTurnConsent().recall) throw new Error(memoryDenyMessage("memory_recall"));
  const data = load();
  const k = String(key ?? "").trim();
  const entries = Object.values(data.entries);
  let list = entries;
  if (k !== "") {
    if (data.entries[k] != null) {
      data.entries[k].accessCount += 1;
      persist();
      list = [data.entries[k]];
    } else {
      list = entries.filter((e) => e.key.startsWith(k.endsWith("/") ? k : `${k}/`) || e.key === k);
    }
  }
  return list
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)))
    .map((e) => ({ key: e.key, content: e.content, tags: e.tags, updatedAt: e.updatedAt }));
}

/** 关键词检索：key/content/tags 子串匹配。需本轮用户提及历史（授权） */
export function memorySearch(query, limit = 5) {
  if (!memoryTurnConsent().recall) throw new Error(memoryDenyMessage("memory_search"));
  const q = String(query ?? "").trim().toLowerCase();
  if (q === "") return memoryRecall("", 5);
  const data = load();
  const list = Object.values(data.entries)
    .filter((e) => {
      const hay = `${e.key} ${e.content} ${(e.tags ?? []).join(" ")}`.toLowerCase();
      return hay.includes(q);
    })
    .sort((a, b) => b.accessCount - a.accessCount || b.updatedAt.localeCompare(a.updatedAt));
  const picked = list.slice(0, Math.max(1, Math.min(Number(limit) || 5, 20)));
  for (const e of picked) {
    if (data.entries[e.key]) {
      data.entries[e.key].accessCount += 1;
    }
  }
  if (picked.length > 0) persist();
  return picked.map((e) => ({ key: e.key, content: e.content, tags: e.tags, updatedAt: e.updatedAt }));
}

export function memoryForget(key) {
  const consentNow = memoryTurnConsent();
  if (!consentNow.recall && !consentNow.forget) {
    throw new Error("memory_forget 未获授权：删除记忆需用户明确提出（如“忘记这条记忆”或提及历史后要求删除）。请先向用户确认。");
  }
  const data = load();
  const k = String(key ?? "").trim();
  let removed = 0;
  if (k === "") throw new Error("memory_forget: key 不能为空");
  if (data.entries[k] != null) {
    delete data.entries[k];
    removed = 1;
  } else {
    const prefix = k.endsWith("/") ? k : `${k}/`;
    for (const existing of Object.keys(data.entries)) {
      if (existing.startsWith(prefix)) {
        delete data.entries[existing];
        removed += 1;
      }
    }
  }
  if (removed > 0) persist();
  return { ok: true, removed };
}

function memoryDenyMessage(tool) {
  return `${tool} 未获用户授权：本轮用户消息未提及“之前/上次/还记得/记忆”等历史指涉。隐私策略要求未经用户明确许可不得检索其记忆库。请先询问用户是否需要调用历史记忆，用户同意后再重试（或请用户在消息中提及相关历史）。`;
}

/** 自检清理：删除已存在的本机/系统相关条目，返回被清除的 key 列表 */
export function memoryPurgeMachineRelated() {
  const data = load();
  const removed = [];
  for (const [key, entry] of Object.entries(data.entries)) {
    if (isMachineRelated(key, entry.content ?? "")) {
      delete data.entries[key];
      removed.push(key);
    }
  }
  if (removed.length > 0) persist();
  return removed;
}

/** 会话摘要（默认不再自动注入；仅当 defaults.memoryAutoInject === true 时由回路注入） */
export function memoryDigest(n = 6, maxChars = 140) {
  const data = load();
  const now = Date.now();
  const entries = Object.values(data.entries)
    .map((e) => {
      const ageDays = (now - new Date(e.updatedAt).getTime()) / 86400000;
      return { ...e, score: e.accessCount * 2 + Math.max(0, 30 - ageDays) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
  if (entries.length === 0) return "";
  const body = entries
    .map((e) => {
      const content = e.content.length > maxChars ? `${e.content.slice(0, maxChars)}…` : e.content;
      return `- ${e.key}: ${content}`;
    })
    .join("\n");
  return `【长期记忆】（每次对话自动带入，供参考，不必复述）\n${body}`;
}
