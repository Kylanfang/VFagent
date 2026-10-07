// <think> 流式分离器单元测试（含跨 chunk 撕裂标签）
import { createThinkSplitter, splitThink, safeParseArgs } from "../server/lib/model.mjs";
import { check, group, summary } from "./testlib.mjs";

group("<think> 分离器");
const feed = (chunks) => {
  const sp = createThinkSplitter();
  const out = [];
  for (const c of chunks) out.push(...sp.push(c));
  out.push(...sp.flush());
  return out;
};
let r = feed(["<think>思考中</think>最终答案"]);
check("单 chunk 完整标签", JSON.stringify(r) === JSON.stringify([{kind:"reasoning",text:"思考中"},{kind:"delta",text:"最终答案"}]), JSON.stringify(r));
r = feed(["你好<thi", "nk>内心", "戏</th", "ink>再见"]);
const rj = r.filter((x) => x.kind === "reasoning").map((x) => x.text).join("");
check("跨 chunk 撕裂标签", r[0].kind === "delta" && r[0].text === "你好" && rj === "内心戏" && r[r.length-1].kind === "delta" && r[r.length-1].text.includes("再见"), JSON.stringify(r));
r = feed(["<THINK>大写</THINK>ok"]);
check("大写标签", r.some((x) => x.kind === "reasoning" && x.text === "大写") && r.some((x) => x.kind === "delta" && x.text === "ok"), JSON.stringify(r));
r = feed(["普通文本无标签"]);
check("无标签全量透传", r.length === 1 && r[0].kind === "delta" && r[0].text === "普通文本无标签", JSON.stringify(r));
r = feed(["<think>忘了闭合"]);
check("未闭合标签内容归 reasoning", r.length === 1 && r[0].kind === "reasoning" && r[0].text === "忘了闭合", JSON.stringify(r));
r = feed(["先说一句 ", "<think>a</think>", "再说一句"]);
check("前后文本保留", r.filter((x) => x.kind === "delta").map((x) => x.text).join("").replace(/\s+/g, " ") === "先说一句 再说一句", JSON.stringify(r));
const st = splitThink("前缀<think>思考</think>后缀");
check("非流式剥离", st.text === "前缀 后缀" && st.reasoning === "思考", JSON.stringify(st));

group("safeParseArgs 修复");
check("尾逗号修复", JSON.stringify(safeParseArgs('{"a": 1,}')) === '{"a":1}', JSON.stringify(safeParseArgs('{"a": 1,}')));
check("非 JSON 降级 _raw", safeParseArgs("不是json")._raw === "不是json");
check("对象直通", safeParseArgs({ a: 1 }).a === 1);
process.exit(summary() ? 0 : 1);
