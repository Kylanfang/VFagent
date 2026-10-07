// 构建后写版本戳：web/dist/version.json（UI 启动时读取展示；轮询对比检测本地是否发布了新版本）
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
const now = new Date();
const build = "b" + now.getTime().toString(36);

writeFileSync(
  path.join(ROOT, "web", "dist", "version.json"),
  JSON.stringify(
    {
      version: pkg.version,
      build,
      builtAt: `${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    },
    null,
    2,
  ) + "\n",
);
console.log(`version.json: ${pkg.version} ${build}`);
