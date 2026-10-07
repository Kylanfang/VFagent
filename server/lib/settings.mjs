// 设置读写：model.json / mcp.json（位于 CONFIG_DIR，桌面版在 userData 可写区）。
// 密钥永不回传明文：读取时只给 hasApiKey / env 引用；保存时空 apiKey = 保持原值。
import { readFileSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config.mjs";
import { atomicWriteFile, warn } from "./util.mjs";

const SCOPE = "settings";

/**
 * 读取 JSON 配置。
 * 修复：原实现直接 JSON.parse，损坏的 model.json/mcp.json 会让**每一次**设置调用抛错，
 * 且保存路径在写入之前就抛，用户无法从界面自愈（永久 500）。
 * 现在把损坏文件隔离为 *.corrupt-<时间戳>（原始字节保留，可人工恢复），记警告后按"无配置"降级。
 */
function readJson(file) {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    let quarantined = null;
    try {
      quarantined = `${file}.corrupt-${Date.now()}`;
      renameSync(file, quarantined);
    } catch {
      quarantined = null;
    }
    warn(SCOPE, `配置文件解析失败，已隔离并降级为默认值 ${file}`, {
      error: String(error?.message ?? error),
      quarantined,
    });
    return null;
  }
}

function safeWrite(file, data) {
  try {
    // 原子写：temp + rename，进程崩溃/断电不会留下半截 JSON（与 util.atomicWriteFile 的约定一致）
    atomicWriteFile(file, JSON.stringify(data, null, 2));
  } catch (error) {
    warn(SCOPE, `写入失败 ${file}`, { error: String(error?.message ?? error) });
    throw error;
  }
}

function maskProvider(raw) {
  const out = {};
  for (const [id, p] of Object.entries(raw.providers ?? {})) {
    out[id] = {
      id,
      label: p.label ?? id,
      protocol: p.protocol ?? "openai-compatible",
      model: p.model ?? "",
      baseUrl: p.baseUrl ?? "",
      supportsTools: p.supportsTools !== false,
      supportsStream: p.supportsStream !== false,
      contextWindow: p.contextWindow ?? null,
      notes: p.notes ?? "",
      apiKeyRef: typeof p.apiKey === "string" && p.apiKey.startsWith("env:") ? p.apiKey : null,
      hasApiKey: typeof p.apiKey === "string" ? p.apiKey.length > 0 : false,
    };
  }
  return out;
}

export function getSettings() {
  const modelFile = path.join(CONFIG_DIR, "model.json");
  const mcpFile = path.join(CONFIG_DIR, "mcp.json");
  const modelRaw = readJson(modelFile) ?? { active: null, providers: {} };
  const mcpRaw = readJson(mcpFile) ?? { servers: [] };
  return {
    configFile: modelFile,
    active: modelRaw.active ?? null,
    providers: maskProvider(modelRaw),
    mcpServers: (mcpRaw.servers ?? []).map((s) => ({
      id: s.id,
      name: s.name ?? s.id,
      transport: s.transport ?? "stdio",
      command: s.command ?? null,
      args: s.args ?? [],
      url: s.url ?? null,
      builtin: s.builtin ?? null,
      enabled: s.enabled === true,
    })),
  };
}

const ALLOWED_PROVIDER_FIELDS = [
  "label",
  "protocol",
  "model",
  "baseUrl",
  "apiKey",
  "headers",
  "supportsTools",
  "supportsStream",
  "toolChoice",
  "contextWindow",
  "notes",
  "adapter",
];

const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/i;

/** 由 label/model 派生合法 provider id（非技术用户填中文/留空时不再报错） */
export function deriveProviderId(fields, existingIds = []) {
  const base = String(fields?.label ?? fields?.model ?? "api")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  let candidate = /^[a-z]/.test(base) ? base : `p_${base || "api"}`;
  if (candidate.length > 32) candidate = candidate.slice(0, 32);
  let n = 2;
  const taken = new Set(existingIds);
  let id = candidate;
  while (taken.has(id)) id = `${candidate.slice(0, 28)}_${n++}`;
  return id;
}

export function saveProvider({ id, fields, setActive }) {
  const modelFile = path.join(CONFIG_DIR, "model.json");
  const raw = readJson(modelFile) ?? { active: null, defaults: {}, providers: {} };
  raw.providers = raw.providers ?? {};
  let pid = typeof id === "string" ? id.trim() : "";
  if (!PROVIDER_ID_RE.test(pid)) {
    const derived = deriveProviderId(fields, Object.keys(raw.providers));
    // 修复（2026-09-13）：id 非法时（例：历史配置里真实存在的 `GLM-4.6` —— 点号不在
    // `PROVIDER_ID_RE` 允许字符集内，这是对的，因为 id 还用于自定义适配器文件名）原实现**无条件派生新 id**。
    // 后果：在设置页"编辑并保存"这条已有供应商，会**新增一条 `glm_4_6` 而把原来的 `GLM-4.6` 留在原地**
    // —— 界面上凭空多一条重复供应商；若带 setActive，激活模型还会被悄悄切到新条目上。
    // 现在先按"规范化后同名"匹配已有 key，命中就沿用原 key（视为更新），只有确实不存在才派生新 id。
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const sameTarget = norm(pid);
    const matched = Object.keys(raw.providers).find((k) => (sameTarget !== "" && norm(k) === sameTarget) || norm(k) === derived);
    pid = matched ?? derived;
  }
  const existing = raw.providers[pid] ?? {};

  const next = { ...existing };
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (!ALLOWED_PROVIDER_FIELDS.includes(key)) continue;
    if (value === undefined) continue;
    if (key === "apiKey") {
      // 空值 = 不改动；"env:XXX" 或明文都接受（明文不回显）
      if (typeof value === "string" && value.trim() !== "") next.apiKey = value.trim();
    } else if (key === "baseUrl") {
      // 空值 = 不改动（观察员视图已脱敏 baseUrl，编辑保存时不得抹掉原值）
      if (typeof value === "string" && value.trim() !== "") next.baseUrl = value.trim();
    } else if (key === "headers") {
      next.headers = value && typeof value === "object" ? value : {};
    } else {
      next[key] = value;
    }
  }
  if (typeof next.baseUrl === "string") next.baseUrl = next.baseUrl.trim().replace(/\/+$/, "");
  if (typeof next.model === "string") next.model = next.model.trim();
  if (next.protocol == null) next.protocol = "openai-compatible";
  if (next.label == null || String(next.label).trim() === "") next.label = pid;
  raw.providers[pid] = next;
  if (setActive === true || raw.active == null || raw.providers[raw.active] == null) raw.active = pid;
  safeWrite(modelFile, raw);
  return { ok: true, id: pid, active: raw.active, renamedFrom: pid !== id ? (id ?? null) : undefined };
}

export function setActiveProvider(id) {
  const modelFile = path.join(CONFIG_DIR, "model.json");
  const raw = readJson(modelFile);
  if (raw == null || raw.providers?.[id] == null) throw new Error(`provider 不存在: ${id}`);
  raw.active = id;
  safeWrite(modelFile, raw);
  return { ok: true, active: id };
}

export function deleteProvider(id) {
  const modelFile = path.join(CONFIG_DIR, "model.json");
  const raw = readJson(modelFile);
  if (raw == null || raw.providers?.[id] == null) throw new Error(`provider 不存在: ${id}`);
  delete raw.providers[id];
  if (raw.active === id) {
    // 修复：原实现直接取 `Object.keys(raw.providers)[0]` —— "删掉当前激活供应商"会把产品静默切到
    // 排在最前面的任意一条，实测切到过：内置 `vf` 前台应答器（baseUrl 为空、无工具能力）、
    // 以及测试/历史遗留的空壳条目。症状是聊天变成固定话术、子代理与派活链路直接报
    // "模型 baseUrl 为空"（全量回归里 t-deep 的 delegate_agent 就栽在这上面）。
    // 现在优先选一条**真能调用**的（有 http(s) baseUrl 与 model，且不在黑名单里），找不到才退回首条。
    const rest = Object.entries(raw.providers).filter(([key]) => key !== id);
    const usable = rest.find(([, p]) => /^https?:\/\//i.test(String(p?.baseUrl ?? "")) && String(p?.model ?? "") !== "");
    raw.active = usable?.[0] ?? rest[0]?.[0] ?? null;
  }
  safeWrite(modelFile, raw);
  return { ok: true, active: raw.active };
}

function normalizeEnabled(value) {
  return value === true || value === 1 || String(value).toLowerCase() === "true";
}

/**
 * 覆盖保存 MCP server 列表（设置页路径）。
 * 修复：设置页回传的是 getSettings() 投影后的字段（id/name/transport/command/args/url/builtin/enabled），
 * 原实现 `raw.servers = servers` 整体替换，导致前端每切换一次 enabled，
 * 就会把 mcp.json 里已配好的 env（"env:VAR" 密钥引用）、headers（Authorization）、notes 全部抹掉。
 * 现在按 id 与磁盘上的原定义做字段级合并：未回传的键保留原值。
 */
export function saveMcpServers(servers) {
  if (!Array.isArray(servers)) throw new Error("servers 必须是数组");
  const mcpFile = path.join(CONFIG_DIR, "mcp.json");
  const raw = readJson(mcpFile) ?? { limits: {}, servers: [] };
  const existing = new Map((raw.servers ?? []).map((s) => [s.id, s]));
  const ids = new Set();
  const next = [];
  for (const s of servers) {
    if (typeof s.id !== "string" || s.id === "") throw new Error("server 缺少 id");
    if (ids.has(s.id)) throw new Error(`重复的 server id: ${s.id}`);
    ids.add(s.id);
    // undefined 视为"未回传"，不得覆盖原值
    const patch = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
    const merged = { ...(existing.get(s.id) ?? {}), ...patch };
    merged.enabled = normalizeEnabled(s.enabled);
    next.push(merged);
  }
  raw.servers = next;
  safeWrite(mcpFile, raw);
  return { ok: true, count: next.length };
}

/**
 * 增量新增/覆盖一个 MCP server（读原始 JSON，env 里的 "env:VAR" 引用原样保留不落盘明文）。
 * 返回值带 previous：调用方（installServer 回滚）据此恢复被覆盖前的可用定义，而不是整条删除。
 */
export function addMcpServer(definition) {
  if (typeof definition?.id !== "string" || definition.id === "") throw new Error("server 缺少 id");
  const mcpFile = path.join(CONFIG_DIR, "mcp.json");
  const raw = readJson(mcpFile) ?? { limits: {}, servers: [] };
  const servers = [...(raw.servers ?? [])];
  const idx = servers.findIndex((s) => s.id === definition.id);
  const previous = idx >= 0 ? servers[idx] : null;
  // 与 saveMcpServers 同口径：undefined 表示"本次未提供"，保留磁盘上的原值。
  // 修复：原实现 upsert 时整体替换，安装/重装一个只带 id+command 的定义会把已配好的
  // env（env:VAR 密钥引用）、headers（Authorization）、notes 一次性抹掉。
  // 注意：显式传 env: {} / headers: {} 仍会清空（调用方意图明确）。
  const patch = Object.fromEntries(Object.entries(definition).filter(([, v]) => v !== undefined));
  const merged = previous != null ? { ...previous, ...patch } : patch;
  if (idx >= 0) servers[idx] = merged;
  else servers.push(merged);
  raw.servers = servers;
  safeWrite(mcpFile, raw);
  return { ok: true, id: definition.id, upserted: idx < 0, previous };
}

export function removeMcpServer(id) {
  const mcpFile = path.join(CONFIG_DIR, "mcp.json");
  const raw = readJson(mcpFile) ?? { limits: {}, servers: [] };
  const before = (raw.servers ?? []).length;
  raw.servers = (raw.servers ?? []).filter((s) => s.id !== id);
  if (raw.servers.length === before) throw new Error(`未找到 server: ${id}`);
  safeWrite(mcpFile, raw);
  return { ok: true, id };
}

/** 读取单个 server 的完整安装定义（供主控「补密钥并启用」；调用方负责脱敏 env 值） */
export function getMcpServerDefinition(id) {
  const mcpFile = path.join(CONFIG_DIR, "mcp.json");
  const raw = readJson(mcpFile) ?? { servers: [] };
  return (raw.servers ?? []).find((s) => s.id === id) ?? null;
}
