// 用量统计：每次模型请求落一条记录，前端图表按天/按供应商聚合。
// 存储在 CONFIG_DIR/usage.json（桌面版 = userData 可写区）。
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "./config.mjs";
import { warn, atomicWriteFile } from "./util.mjs";

const SCOPE = "usage";
const DATA_FILE = path.join(CONFIG_DIR, "usage.json");
const MAX_RECORDS = 5000;

function readAll() {
  if (!existsSync(DATA_FILE)) return [];
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, "utf8"));
    return Array.isArray(raw) ? raw : [];
  } catch (error) {
    warn(SCOPE, "usage.json 解析失败，已重置", { error: String(error?.message ?? error) });
    return [];
  }
}

// usage 为 null 时按字符数粗估（中文 ~1.5 char/token）
export function estimateTokens(chars) {
  return Math.max(1, Math.round(chars / 1.8));
}

export function recordUsage({ provider, model, usage, promptChars = 0, completionChars = 0 }) {
  const promptTokens = usage?.prompt_tokens ?? estimateTokens(promptChars);
  const completionTokens = usage?.completion_tokens ?? estimateTokens(completionChars);
  const record = {
    ts: new Date().toISOString(),
    provider: String(provider ?? "unknown"),
    model: String(model ?? "unknown"),
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: usage == null,
  };
  const all = readAll();
  all.push(record);
  if (all.length > MAX_RECORDS) all.splice(0, all.length - MAX_RECORDS);
  try {
    atomicWriteFile(DATA_FILE, JSON.stringify(all, null, 1));
  } catch (error) {
    warn(SCOPE, "用量写入失败", { error: String(error?.message ?? error) });
  }
  return record;
}

export function usageSummary() {
  const all = readAll();
  const byDay = new Map();
  const byProvider = new Map();
  let totals = { records: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  for (const r of all) {
    const day = String(r.ts).slice(0, 10);
    const dayEntry = byDay.get(day) ?? { day, calls: 0, totalTokens: 0 };
    dayEntry.calls += 1;
    dayEntry.totalTokens += r.totalTokens ?? 0;
    byDay.set(day, dayEntry);

    const pEntry = byProvider.get(r.provider) ?? { provider: r.provider, model: r.model, calls: 0, totalTokens: 0 };
    pEntry.calls += 1;
    pEntry.totalTokens += r.totalTokens ?? 0;
    byProvider.set(r.provider, pEntry);

    totals.records += 1;
    totals.promptTokens += r.promptTokens ?? 0;
    totals.completionTokens += r.completionTokens ?? 0;
    totals.totalTokens += r.totalTokens ?? 0;
  }

  const days = [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-30);
  const providers = [...byProvider.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  return { totals, days, providers, dataFile: DATA_FILE };
}
