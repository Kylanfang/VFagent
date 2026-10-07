// 把 stdio MCP 服务器打包为单文件 CJS，随发行包分发（测试员机器无需 npm/npx/Node）。
// 产物：release/mcp-bundled/*.cjs，由引擎以 ELECTRON_RUN_AS_NODE 方式 spawn。
import { rmSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "release", "mcp-bundled");
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const SERVERS = [
  ["mcp-filesystem.mjs", path.join(ROOT, "node_modules", "@modelcontextprotocol", "server-filesystem", "dist", "index.js")],
  ["mcp-seq.mjs", path.join(ROOT, "node_modules", "@modelcontextprotocol", "server-sequential-thinking", "dist", "index.js")],
  ["mcp-github.mjs", path.join(ROOT, "node_modules", "@modelcontextprotocol", "server-github", "dist", "index.js")],
  ["mcp-finance.mjs", path.join(ROOT, "node_modules", "finance-mcp", "build", "index.js")],
];

for (const [out, entry] of SERVERS) {
  if (!statSync(entry, { throwIfNoEntry: false })) {
    console.log(`跳过 ${out}（源不存在: ${path.relative(ROOT, entry)}）`);
    continue;
  }
  await esbuild.build({
    entryPoints: [entry],
    outfile: path.join(OUT, out),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    minify: true,
    legalComments: "none",
    logLevel: "silent",
    // finance-mcp 内部存在动态 require("fs") 等：ESM 输出不带 CJS require，需注入 createRequire 兜底
    banner: { js: "import { createRequire as __crc } from 'node:module'; const require = __crc(import.meta.url);" },
  });
  console.log(`${out}: ${(statSync(path.join(OUT, out)).size / 1024).toFixed(0)} KB`);
}
// 部分 MCP 包（sequential-thinking / finance-mcp）启动时会读脚本旁的 package.json 取版本号，
// 缺失即抛错退出（表现为 "Connection closed"）——打包时附带一份最小 package.json
// finance-mcp 读取的是脚本"上一级"目录的 package.json，因此父目录也需要一份
writeFileSync(
  path.join(OUT, "..", "package.json"),
  JSON.stringify({ name: "vfletch-mcp-bundled", version: "1.0.0", private: true }, null, 2) + String.fromCharCode(10),
);
writeFileSync(
  path.join(OUT, "package.json"),
  JSON.stringify({ name: "vfletch-mcp-bundled", version: "1.0.0", private: true }, null, 2) + String.fromCharCode(10),
);
console.log("MCP 打包完成 →", OUT);
