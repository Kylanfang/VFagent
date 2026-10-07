// 服务端引擎单文件构建：bundle + minify + CJS。
// 产物为不可读的构建文件（无注释/无源结构），作为独立运行套件内的 server/main.cjs。
import { rmSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release", "engine", "main.cjs");
// 构建期把版本号烧进产物：独立运行套件的 app 目录里往往没有 package.json，
// 只靠运行时读 package.json 会让 /api/meta 退化成 "0.0.0"，而登录页与设置页都会把它显示给用户
// （LoginView 的「v{meta.version} · 本地服务在线」、SettingsView 的「版本」卡片）。
const VERSION = (() => {
  try { return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? "0.0.0"; } catch { return "0.0.0"; }
})();

rmSync(path.dirname(OUT), { recursive: true, force: true });

await esbuild.build({
  entryPoints: [path.join(ROOT, "server", "main.mjs")],
  outfile: OUT,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  define: { __VF_BUILD_VERSION__: JSON.stringify(VERSION) },
});

const { statSync } = await import("node:fs");
console.log(`engine: ${OUT} (${(statSync(OUT).size / 1024).toFixed(0)} KB) · version=${VERSION}`);
