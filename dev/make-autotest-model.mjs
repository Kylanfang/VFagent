// 生成"自动化测试专用"的模型配置（.autotest/model.json），保证每次回归的模型环境一致。
//
// 背景（2026-09-13 晚巡检发现）：`.autotest/model.json` 从没人重置过 —— 历史回归里那些
// 「往 /api/settings/provider 写脏 provider」的用例把 ~60 条 `w_jiagong_*`/`w_yigong_*`/`pwn`
// （baseUrl 甚至是 http://127.0.0.1:1）留在了测试配置里，且 `active` 被切到了**上游已下线**的
// `deepseek-v4`。结果是 t-models / t-deep 长期报失败，被误判成"上游无可用渠道"的环境问题。
// 实测：同一台机器上测试网关（config/model.json 里的 VF 那台）**完全可用**（300ms 返回）。
//
// 做法：以 `config/model.json` 里那台测试网关（VF）为模板取 baseUrl + apiKey，
// 生成一组确定性的测试 provider；active 固定为一个可用模型。密钥不新增副本，仍只有 config/model.json 一份来源。
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfg = JSON.parse(readFileSync(path.join(ROOT, "config", "model.json"), "utf8"));
const providers = cfg.providers ?? {};

// 测试网关模板：取 baseUrl 指向测试网关（gateway.example.com）的任一 provider
const campusEntry = Object.values(providers).find((p) => /gateway\.example\.com/.test(String(p.baseUrl ?? "")));
if (campusEntry == null) {
  console.error("找不到测试网关 provider（config/model.json 里 baseUrl 指向测试网关 gateway.example.com）——跳过测试模型配置生成");
  process.exit(0);
}
const CAMPUS = { baseUrl: campusEntry.baseUrl, apiKey: campusEntry.apiKey };

const campus = (label, model, notes) => ({
  label, protocol: "openai-compatible", model, baseUrl: CAMPUS.baseUrl, apiKey: CAMPUS.apiKey,
  supportsTools: true, supportsStream: true, contextWindow: null, notes,
});

const out = {
  $comment: "自动化测试专用（由 dev/make-autotest-model.mjs 生成，勿手工编辑）：active 必须是当前可用的模型，否则 t-models/t-deep 会出现假失败。",
  active: "GLM-4.6",
  defaults: cfg.defaults ?? { temperature: 0.3, maxOutputTokens: 4096, maxToolRounds: 40 },
  providers: {
    "GLM-4.6": campus("GLM-4.6", "GLM-4.6-W8A8", "智谱 GLM-4.6（测试网关）· 回归默认 active"),
    "GLM-4.5": campus("GLM-4.5", "GLM-4.5", "智谱 GLM-4.5（测试网关）"),
    "VF": campus("VF", "Qwen3.5-122B-A10B", "Qwen3.5-122B（测试网关）"),
    "DS-V4-Flash": campus("DeepSeek-V4-Flash", "DeepSeek-V4-Flash-0731-W8A8", "DeepSeek V4 Flash（测试网关）"),
    "Qwen-Think": campus("Qwen3 思维", "Qwen3-Next-80B-A3B-Thinking", "思维模型（网关把 CoT 混在正文，无标签）"),
  },
};
// 原样带上 config 里的非测试网关供应商（奇缘网关的 deepseek-v4 条目）。
// 用途：① 让 t-models 覆盖"第二个独立网关"；② 保留"上游模型改名/下线 → 跳过而非失败"这条分支的样本。
// 2026-09-14：config 里该条目的 model 已修正为 deepseek-v4.1（实测 200）。若上游再次改名，
// t-models 会按 upstreamModelGone() 打印"跳过"，不会被误报成产品缺陷。
if (providers["deepseek-v4"] != null) out.providers["deepseek-v4"] = providers["deepseek-v4"];

const dst = path.join(ROOT, ".autotest", "model.json");
writeFileSync(dst, JSON.stringify(out, null, 2), "utf8");
console.log(`autotest model.json: active=${out.active} providers=${Object.keys(out.providers).join(", ")}`);
