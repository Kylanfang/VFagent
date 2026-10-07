# 远端 MCP 排查与配置指南

> 适用：V-Fletch（vfletch）中 `transport: "http"`（Streamable HTTP）的远端 MCP server。
> 内置 server（审计/联网/生图/代码/智能体/记忆库）不走网络，无需看本文。

## 1. 先说结论（本次环境的直接原因）

`config/mcp.json`（打包后实际生效的是
`%APPDATA%\v-fletch\config\mcp.json`，首次启动从源码拷过去，之后不再同步）里的示例项
`remote-demo` 指向 `http://127.0.0.1:3001/mcp`，但本机 **并没有任何服务监听 3001**，且该项被置为
`enabled: true` → 每次启动都报连接错误（表现为红色告警 + 服务状态 error）。

处理：已把源码与 userData 两份配置里的 `remote-demo` 改为 `enabled: false`（默认关闭），
不再产生启动告警。需要用时再打开，并把 url 换成真实可达的端点。

## 2. 为什么“远端 MCP 连不上”——可能原因清单

按出现频率排序：

| 原因 | 现象 | 判定方法 |
|---|---|---|
| 目标服务根本没启动 / 端口错 | `fetch failed` / ECONNREFUSED | 探测接口返回 `fetch failed`，延迟 <10ms 即本机拒绝 |
| URL 不是 MCP 端点（如给了首页 / REST API） | HTTP 200/405 但握手失败 | 探测返回非 JSON 或 JSON-RPC error |
| 防火墙 / 代理拦截 | 超时（`UND_ERR_CONNECT_TIMEOUT`） | 探测超时；换 curl 直连对照 |
| 企业代理 | 外网超时但内网正常 | 检查系统代理设置；给 fetch 配代理需要代码支持 |
| 路径写错 | 404 / 405 | 服务端文档确认 `/mcp` 后缀 |
| 需要鉴权 | 401/403 | headers 里补 Authorization/Bearer |
| 传输协议不匹配 | 响应非 SSE/JSON | MCP 新版是 Streamable HTTP；老版 SSE 传输另配 |

## 3. 排查步骤（推荐顺序）

1. **在 MCP 中心点“检测连通性”**（http 类服务卡片下方按钮）：直接对 url 发 JSON-RPC `initialize`
   握手，返回 耗时/服务名/错误，几秒钟见分晓。
2. 若无按钮或想手工验证，命令行：
   ```bash
   curl -i -X POST http://127.0.0.1:3001/mcp \
     -H "content-type: application/json" \
     -H "accept: application/json, text/event-stream" \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
   ```
   - `fetch failed`/拒绝连接 → 服务没起或端口错；
   - HTTP 200 + `{"jsonrpc":"2.0","result":{...}}` → 服务正常，问题在配置；
   - 401/403 → 补 headers；
   - 405/404 → url 不是 MCP 端点。
3. 打开“重新扫描”观察服务状态；仍失败看“诊断详情”与探测返回。
4. 换一个已知可达的 MCP 测试端点做对照（如远程 demo 服务），以区分“网络不通”与“配置错”。

## 4. 正确添加远端 MCP 的方法

编辑生效配置（打包版在 `%APPDATA%\v-fletch\config\mcp.json`，源码版在 `vfletch\config\mcp.json`）：
```jsonc
{
  "servers": [
    {
      "id": "my-remote",
      "name": "我的远端服务",
      "transport": "http",
      "url": "https://example.com/mcp",      // 必须是 Streamable HTTP MCP 端点
      "headers": { "Authorization": "Bearer xxx" },  // 需要鉴权时填；支持 env:XXX
      "enabled": true
    }
  ]
}
```
保存后：MCP 中心 →“重新扫描”（或重启应用）。若改动的是源码版，打包后首次启动会拷贝，
**注意 userData 版优先**——打包版用户请直接改 `%APPDATA%\v-fletch\config\mcp.json`。

## 5. 离线 / 无外网环境下的替代方案

| 场景 | 方案 |
|---|---|
| 没有外网，但有本机服务 | 远端 MCP 跑在 `127.0.0.1` 或局域网 IP（docker/本机 node 均可），transport http 不变 |
| 完全离线 | 用内置 server：审计、联网(仅本机可达源时)、生图(需本机模型)、代码执行、任务规划、记忆库——全部 in-process，零网络依赖 |
| stdio 服务离线装好 | 先把 npx 包装进缓存（有网时装一次 `npx -y xxx`），之后 npx 走本地缓存不再联网；Windows 用 `npx.cmd` |
| 团队共享一个 MCP | 一台机器起 Streamable HTTP MCP 服务，其他人配 `http://<内网IP>:port/mcp` |

## 6. 内置探测接口（给开发/自动化用）

`POST /api/mcp/probe`，body `{"url":"...","headers":{...}}`
返回 `{ok, httpStatus?, latencyMs, serverInfo?, protocolVersion?, error?}`，
已在前端 MCP 中心界面暴露为“检测连通性”按钮。
