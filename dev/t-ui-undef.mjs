// 前端静态守护：no-undef 扫描 web/src（未声明标识符 = 构建能过、浏览器必炸的 ReferenceError 类 bug）。
// 来历：ChatView 曾在 done 分支对未声明的 finish 赋值，每轮回合结束都弹 "finish is not defined" 红条，
// 而 API 层回归（run-all 全部脚本）测不到浏览器运行时错误——只能靠作用域分析在静态阶段拦。
// 依赖 eslint（一次性 npx 下载后走本机缓存）。
import { execSync } from "node:child_process";

let output = "";
try {
  output = execSync(
    'npx --yes eslint@8.57.0 --no-eslintrc --env browser,es2022 --parser-options "ecmaVersion:2022,sourceType:module,ecmaFeatures:{jsx:true}" --rule "{\\"no-undef\\":\\"error\\"}" "web/src/**/*.jsx" "web/src/**/*.js"',
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") },
  );
} catch (error) {
  output = String(error.stdout ?? "") + String(error.stderr ?? "");
}
// 排除"禁用注释引用未加载规则"这类噪音（如 react-hooks/*），只认 no-undef 实质问题
const undefLines = output.split("\n").filter((l) => /no-undef|is not defined/i.test(l) && !/Definition for rule/.test(l));
let fail = undefLines.length > 0 ? 1 : 0;
let pass = fail === 0 ? 1 : 0;
console.log(undefLines.length === 0 ? "  ✅ web/src 无未声明标识符引用（no-undef 全绿）" : `  ❌ 发现未声明引用：\n${undefLines.join("\n")}`);

// ---------------------------------------------------------------------------
// 静态守护 2：会话 id 绝不能是全局固定值
// 来历：默认会话 id 曾写死 "s1"，而服务端按 conversations.owner_user_id 校验归属 ——
// 多账号共用同一中央库时，只要库里已有 s1（属主是别人），任何新账号/新浏览器点推荐话题
// 后发消息都会 403「无权访问该会话：会话属于其他用户」。API 回归测不到（要浏览器 localStorage
// 全空的"新用户"场景），故在这里做源码级守护。
{
  const { readFileSync } = await import("node:fs");
  const chat = readFileSync(new URL("../web/src/components/ChatView.jsx", import.meta.url), "utf8");
  const hardFixed = /id:\s*"s1"/.test(chat) || /sessions\[0\]\?\.id\s*\?\?\s*"s1"/.test(chat);
  const hasGenerator = /function newSessionId\(/.test(chat) && /newSessionId\(userId\)/.test(chat);
  const hasMigration = /migrateLegacySessionIds\(/.test(chat);
  const checks = [
    ["ChatView 不再使用固定会话 id（s1）", !hardFixed],
    ["ChatView 使用按账号唯一的会话 id 生成器", hasGenerator],
    ["ChatView 装载时迁移遗留固定 id（老 localStorage 自愈）", hasMigration],
  ];
  for (const [label, ok] of checks) {
    console.log(ok ? `  ✅ ${label}` : `  ❌ ${label}`);
    if (ok) pass += 1;
    else fail += 1;
  }
}

console.log(`==== UI 静态守护: 通过 ${pass} / 失败 ${fail} ====`);
process.exit(fail === 0 ? 0 : 1);
