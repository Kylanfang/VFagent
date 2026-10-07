import { activeProvider, loadModelConfig, loadMcpConfig } from "./lib/config.mjs";
import { McpManager } from "./lib/mcp-manager.mjs";
import { createModelClient } from "./lib/model.mjs";

const [, , command] = process.argv;

function pad(value, width) {
  return String(value).padEnd(width);
}

async function mcpList() {
  const manager = new McpManager();
  const snapshot = await manager.start();
  console.log(`\n已配置 MCP server：${snapshot.servers.length} 个，已启用工具 ${snapshot.toolCount} 个\n`);
  for (const server of snapshot.servers) {
    console.log(`${pad(server.status.toUpperCase(), 10)} ${pad(server.id, 18)} ${server.transport.padEnd(6)} tools=${server.tools.length}${server.error ? `  error=${server.error}` : ""}`);
    for (const tool of server.tools) {
      console.log(`${"".padEnd(12)}- ${tool.exposedName}  (${tool.originalName}, ${tool.schemaChars} chars)`);
    }
  }
  console.log("");
}

async function mcpDoctor() {
  const manager = new McpManager();
  const snapshot = await manager.start();
  const { conflicts } = snapshot;
  if (conflicts.length === 0) {
    console.log("\n未发现冲突。\n");
    return;
  }
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...conflicts].sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));
  const counts = sorted.reduce((acc, item) => ({ ...acc, [item.severity]: (acc[item.severity] ?? 0) + 1 }), {});
  console.log(`\n诊断结果：${JSON.stringify(counts)}\n`);
  for (const item of sorted) {
    console.log(`[${item.severity.toUpperCase()}] ${item.kind}${item.server ? ` (${item.server}${item.tool ? `/${item.tool}` : ""})` : ""}`);
    console.log(`    ${item.message}`);
  }
  console.log("");
}

async function modelPing() {
  const config = loadModelConfig();
  for (const provider of Object.values(config.providers)) {
    const line = `${pad(provider.id, 14)} ${pad(provider.protocol, 20)} ${provider.model}`;
    if (provider.baseUrl?.includes("REPLACE-ME")) {
      console.log(`${line}\n    未配置：baseUrl / model 仍是占位符`);
      continue;
    }
    if ((provider.apiKey ?? "") === "") {
      console.log(`${line}\n    未配置：缺少 API Key（检查环境变量）`);
      continue;
    }
    try {
      const client = await createModelClient(provider);
      let text = "";
      for await (const event of client.stream({
        messages: [{ role: "user", content: "回复两个字：收到" }],
        tools: undefined,
        temperature: 0,
        maxOutputTokens: 32,
        signal: AbortSignal.timeout(30000),
      })) {
        if (event.type === "delta") text += event.text;
      }
      console.log(`${line}\n    OK: ${text.trim().slice(0, 60) || "(空回复)"}`);
    } catch (error) {
      console.log(`${line}\n    FAIL: ${String(error?.message ?? error).slice(0, 200)}`);
    }
  }
  console.log("");
}

const commands = { "mcp:list": mcpList, "mcp:doctor": mcpDoctor, "model:ping": modelPing };

if (commands[command] == null) {
  console.log(`用法: node server/cli.mjs <${Object.keys(commands).join(" | ")}>`);
  process.exit(1);
}

await commands[command]();
process.exit(0);
