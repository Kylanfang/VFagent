import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function moduleDir() {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return process.cwd(); // 单文件构建产物：以工作目录兜底（发行环境由 VFLETCH_ROOT 显式指定）
  }
}
export const ROOT = process.env.VFLETCH_ROOT
  ? path.resolve(process.env.VFLETCH_ROOT)
  : path.resolve(moduleDir(), "..", "..");
const BUILTIN_CONFIG = path.join(ROOT, "config");
export const CONFIG_DIR = process.env.VFLETCH_CONFIG_DIR
  ? path.resolve(process.env.VFLETCH_CONFIG_DIR)
  : BUILTIN_CONFIG;
export const WEB_DIST = process.env.VFLETCH_WEB_DIST
  ? path.resolve(process.env.VFLETCH_WEB_DIST)
  : path.join(ROOT, "web", "dist");

export function resolveSecret(raw) {
  if (typeof raw !== "string") return "";
  const value = raw.trim();
  if (value.startsWith("env:")) {
    const name = value.slice(4).trim();
    return process.env[name] ?? "";
  }
  return value;
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`配置文件解析失败 ${file}: ${error.message}`);
  }
}

export function loadModelConfig() {
  const raw = readJson(path.join(CONFIG_DIR, "model.json"), null);
  if (raw == null) throw new Error("缺少 config/model.json");
  const providers = {};
  for (const [id, provider] of Object.entries(raw.providers ?? {})) {
    providers[id] = {
      id,
      ...provider,
      apiKey: resolveSecret(provider.apiKey),
      headers: Object.fromEntries(
        Object.entries(provider.headers ?? {}).map(([key, value]) => [key, resolveSecret(value)]),
      ),
    };
  }
  return { active: raw.active, defaults: raw.defaults ?? {}, providers, imageProvider: raw.imageProvider ?? null };
}

export function loadMcpConfig() {
  const raw = readJson(path.join(CONFIG_DIR, "mcp.json"), null);
  if (raw == null) throw new Error("缺少 config/mcp.json");
  const servers = (raw.servers ?? []).map((server) => ({
    ...server,
    enabled: server.enabled === true,
    env: Object.fromEntries(
      Object.entries(server.env ?? {}).map(([key, value]) => [key, resolveSecret(value)]),
    ),
    headers: Object.fromEntries(
      Object.entries(server.headers ?? {}).map(([key, value]) => [key, resolveSecret(value)]),
    ),
  }));
  return { limits: raw.limits ?? {}, servers };
}

export function activeProvider() {
  const config = loadModelConfig();
  const provider = config.providers[config.active];
  if (provider == null) {
    throw new Error(`config/model.json 中找不到激活的供应商: ${config.active}`);
  }
  return { provider, defaults: config.defaults };
}
