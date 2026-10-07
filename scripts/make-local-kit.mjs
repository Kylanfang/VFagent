// 生成本地运行套件：release/vfletch-local-kit/
// 目标机：任意平台（Windows / macOS / Linux），自带 **Node ≥22.5**（引擎用 Node 内置 node:sqlite，
// 该模块自 Node 22.5.0 起才存在）。
// 内容：引擎单文件产物（跨平台）+ 构建好的前端 + 配置模板 + 本地启动说明。
// 纯本地形态：不涉及任何服务器注册、反向代理或云端地址。
import { cpSync, rmSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = path.join(ROOT, "release", "engine", "main.cjs");
const KIT = path.join(ROOT, "release", "vfletch-local-kit");
const APP = path.join(KIT, "app");

if (!existsSync(ENGINE)) {
  console.log("构建引擎产物...");
  execSync("node scripts/build-engine.mjs", { cwd: ROOT, stdio: "inherit" });
}
if (!existsSync(path.join(ROOT, "web", "dist", "index.html"))) {
  console.log("构建前端...");
  execSync("npm run build:web", { cwd: ROOT, stdio: "inherit" });
}

rmSync(KIT, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });

// 引擎 + 前端 + 配置模板（引擎 + 空模型配置 + MCP 模板；不含任何密钥或运行时数据）
cpSync(ENGINE, path.join(APP, "main.cjs"));
cpSync(path.join(ROOT, "web", "dist"), path.join(APP, "web-dist"), { recursive: true });
mkdirSync(path.join(APP, "config"), { recursive: true });
cpSync(path.join(ROOT, "config", "model.example.json"), path.join(APP, "config", "model.example.json"));
if (existsSync(path.join(ROOT, "config", "mcp.example.json"))) {
  cpSync(path.join(ROOT, "config", "mcp.example.json"), path.join(APP, "config", "mcp.example.json"));
}
cpSync(path.join(ROOT, "server", "audit", "audit-data.json"), path.join(APP, "config", "audit-data.json"));

writeFileSync(path.join(KIT, "README-本地运行.md"), `# V-Fletch 本地运行套件

## 前置
- 安装 **Node.js ≥ 22.5**（引擎使用 Node 内置 \`node:sqlite\`，该模块自 22.5.0 起才存在）
  - 校验：\`node -v\` 应输出 v22.5.0 或更高

## 步骤（约 2 分钟）
1. 进入 app 目录：
   \`\`\`
   cd vfletch-local-kit/app
   \`\`\`
2. 配置模型（复制模板后填写自己的 OpenAI 兼容端点与密钥）：
   \`\`\`
   cp config/model.example.json config/model.json
   \`\`\`
3. 可选：配置 MCP（不配置时自动仅用内置 server）：
   \`\`\`
   cp config/mcp.example.json config/mcp.json
   \`\`\`
4. 启动：
   \`\`\`
   node main.cjs
   \`\`\`
5. 浏览器打开 http://127.0.0.1:8787 （首次启动自动创建管理员账号，初始密码见启动日志）

## 说明
- 纯本地运行：账号、模型与数据都在本机，除你自己配置的模型端点外不访问任何外部服务。
- 数据落在 \`config/vfletch.db\`，备份 = 复制该文件。
`);

execSync(`tar -cf vfletch-local-kit.tar vfletch-local-kit`, { cwd: path.dirname(KIT), stdio: "ignore" });
console.log(`本地运行套件: ${KIT}`);
console.log(`打包: release/vfletch-local-kit.tar`);
console.log(`引擎大小: ${(statSync(path.join(APP, "main.cjs")).size / 1024).toFixed(0)} KB`);
