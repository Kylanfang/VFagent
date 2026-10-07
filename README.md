# V-Fletch

> 模型无关的**本地**办公 Agent 框架：一个 Node 后端 + 一个 Vite/React 前端 + MCP 工具接入。
> 一条命令起服务，**不需要任何服务器、云端或联网授权校验**——除你自己配置的模型端点外没有外部依赖。

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen.svg)](#环境要求)

---

## 一句话定位

**V-Fletch 是一个可下载后本地直接运行的办公 Agent 框架**：把「流式对话 + 工具执行回合 + 企业知识库 +
多用户/监管留痕 + MCP 工具生态」装进一个零云端依赖的 Node 单体服务里，用浏览器打开即用。

关键词：本地 Agent 框架 / MCP 客户端 / 工具回合循环 / OpenAI 兼容多供应商 / 知识库 / 多用户与审计留痕 / 离线可跑。

---

## 特性

| 能力 | 说明 |
|---|---|
| **模型无关** | 任意 OpenAI 兼容端点（DeepSeek / 智谱 GLM / Qwen / 本地 vLLM 等）；非兼容协议可写自定义 adapter（`server/adapters/custom.mjs`）。支持 `env:VAR_NAME` 引用密钥，不落盘明文。 |
| **工具回合循环** | 模型 → 工具 → 模型 的多轮自动回路（`maxToolRounds` 默认 8 防死循环）；不支持 function calling 的模型自动降级为文本 JSON 协议。 |
| **MCP 工具接入** | 连接 stdio / Streamable-HTTP 两类 MCP server；工具暴露为命名空间名 `<serverId>__<toolName>`，多 server 同名工具不冲突；带冲突诊断与连通性探测。 |
| **内置工具 server** | 无 `config/mcp.json` 也能用：审计风控、联网检索、图像生成、本地代码执行、任务规划、记忆库等 in-process server。 |
| **流式对话** | SSE 流式输出，含思考过程剥离、工具调用可视化、会话取消（浏览器主线程冻结也能送达停止指令）。 |
| **知识库** | 企业共享知识库 + 上传/归档/恢复/清理。 |
| **多用户与权限** | 主控 / 观察员 / 员工三级；scrypt 加盐哈希、32 字节随机会话 token、24h 过期。 |
| **监管与审计** | RMS 风控模块把聊天/工具/任务/成本/风险事件落 SQLite；审计视图 + AI 生成内容监测。 |
| **本地优先** | 数据库用 Node 内置 `node:sqlite`（零外部依赖）；运行时数据落在可写 `CONFIG_DIR`，不入库。 |
| **桌面壳（可选）** | 可选 Electron 壳（`npm run app`）与本地运行套件打包（`npm run kit:local`）；非必需。 |

---

## 环境要求

- **Node ≥ 22.5**（后端使用 Node 内置 `node:sqlite`，该模块自 Node 22.5.0 起提供）。
- npm（随 Node 附带）。
- 一个可用的模型端点（OpenAI 兼容 API，或本地推理服务）。

---

## 本地快速开始

> 全程零远端依赖。唯一的出网流量来自你**自己配置**的模型端点（以及你显式启用的远端 MCP）。

```bash
# 0) 安装依赖
npm install

# 1) 配置模型：从模板复制后填写
cp config/model.example.json config/model.json
#    - apiKey 建议写 "env:VAR_NAME" 从环境变量读取，不落盘明文
#    - 任意 OpenAI 兼容端点均可；非 OpenAI 兼容协议写 adapter（见 server/adapters/custom.mjs）

# 2) 配置 MCP（可选）：从模板复制，把要启用的 server 的 enabled 改成 true
cp config/mcp.example.json config/mcp.json
#    —— 跳过此步也能跑：MCP 层自动降级为仅内置 server

# 3) 构建前端（首次运行或前端改动后）
npm run build:web

# 4) 启动（后端同时托管构建好的前端）
npm start
#   → 打开 http://127.0.0.1:8787
```

**首次启动**会自动创建管理员账号：

- 用户名：`central`
- 初始口令：优先取环境变量 **`VF_BOSS_P`**；未设置时使用公开的开发默认口令 `vfletch-dev`
  （启动日志会明确提示尽快改密；也可在「设置」页修改）。

**开发模式（前端热更新）：**

```bash
npm run dev:web    # http://127.0.0.1:5173 ，/api 已代理到 8787
```

**可选：桌面壳**

```bash
npm run app        # 启动 Electron 桌面壳（内嵌本地引擎）
npm run kit:local  # 生成 release/vfletch-local-kit/ 本地运行套件
```

---

## 目录结构导航

| 目录 / 文件 | 作用 |
|---|---|
| `server/` | **后端**。`main.mjs` 是 HTTP 入口（node:http，含全部 `/api/*` 路由）；`lib/` 为各功能模块；`adapters/` 为模型协议适配器；`cli.mjs` 为诊断 CLI。 |
| `server/lib/` | 核心库：`chat.mjs`/`chat-graph.mjs` 回合编排、`mcp-manager.mjs` MCP 连接、`model.mjs` 模型客户端、`context.mjs` 上下文裁剪、`auth.mjs` 账号、`db.mjs` SQLite、`rms.mjs` 风控、`team.mjs` AI 员工、`memory.mjs` 记忆库、`subagent.mjs` 子代理等。 |
| `server/adapters/` | 自定义模型协议适配器模板（`custom.mjs`）。 |
| `server/audit/` | 审计视图用的**示例数据**（`audit-data.json`，来源见 `PROVENANCE.md`）。 |
| `web/` | **前端**（Vite + React）。`src/components/` 为各视图组件，`src/lib/api.js` 为 API 客户端，`src/styles.css` 为样式，`public/` 为静态资源与运维控制台页。 |
| `electron/` | 可选的 Electron 桌面壳（`main.cjs` 始终启动内嵌**本地**引擎，无远程校验）。 |
| `config/` | 配置模板（`model.example.json`、`mcp.example.json`）。**运行时**的 `model.json`/`mcp.json`/数据库在此生成，已被 `.gitignore` 排除。 |
| `scripts/` | 构建与打包脚本（`build-engine.mjs` 单文件引擎、`write-version.mjs` 版本写入、`make-local-kit.mjs` 本地套件、`bundle-mcp.mjs`、`mcp-check.mjs`、`test-aigc.mjs`）。 |
| `dev/` | 开发与自动化测试：`run-all.sh` 全量回归、`t-*.mjs` 各专项测试、`apitest.mjs` 接口测试、`testlib.mjs` 测试基座、`seed-*.mjs` 演示数据。 |
| `tools/` | 零依赖辅助工具（`loadtest.mjs` 稳定性压测、`regression-tests.mjs` 定向回归）与随附的 SQLite 命令行二进制。 |
| `docs/` | **公开**文档（见下方文档索引）。 |
| `brand/` | 品牌资源（图标、Logo 源文件、主题预览页）。 |
| `launch.bat` / `stop.bat` | Windows 快捷启动/停止脚本。 |
| `package.json` | 依赖与脚本入口（`start` / `dev:web` / `build:web` / `app` / `kit:local` / `mcp:*` / `model:ping`）。 |
| `LICENSE` | Apache License 2.0 全文。 |
| `PROVENANCE.md` | **来源与合规声明**：独立开发声明、对齐范围披露、核验方法与未核验项。 |
| `checksums.sha256` | 全仓文件完整性校验清单。 |

---

## 配置说明

### 模型（`config/model.json`）

从 `config/model.example.json` 复制。结构：

```jsonc
{
  "active": "deepseek-v4",              // 当前启用的供应商 id
  "defaults": { "temperature": 0.3, "maxOutputTokens": 8192, "maxToolRounds": 8 },
  "providers": {
    "deepseek-v4": {
      "label": "DeepSeek V4",
      "protocol": "openai-compatible",  // 或 "custom"
      "model": "deepseek-v4",
      "baseUrl": "https://api.deepseek.com/v1",
      "supportsTools": true,
      "supportsStream": true,
      "apiKey": "env:DEEPSEEK_API_KEY"  // 推荐：从环境变量读取，不落盘明文
    }
  }
}
```

- `protocol: "custom"` 时，`adapter: "custom"` 指向 `server/adapters/custom.mjs` 导出的 `chatStream()`，
  由你自行映射请求/响应（模板内有事件契约说明）。
- 思维模型（如 `deepseek-reasoner`）：设 `systemAsUser: true` 且 `supportsTools: false`。
- 额外请求体字段用 `extraBody` 注入（模板含 GLM / Qwen 示例）。

### MCP（`config/mcp.json`）

从 `config/mcp.example.json` 复制。`servers[]` 每一项：

```jsonc
{
  "id": "filesystem",
  "name": "本地文件系统",
  "transport": "stdio",                 // 或 "http"（Streamable HTTP）
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "enabled": false
}
```

- `transport: "http"` 用 `url` + `headers`（`headers` 值支持 `env:VAR_NAME`）。
- **不提供该文件**时后端仍可启动，MCP 层自动降级为仅内置 server。
- 详见 [`docs/remote-mcp-guide.md`](docs/remote-mcp-guide.md)。

### 关键环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `VFLETCH_PORT` | `8787` | 监听端口 |
| `VFLETCH_CONFIG_DIR` | 源码版为 `./config` | 运行时配置与数据库目录 |
| `VF_BOSS_P` | （未设则 `vfletch-dev`） | 首次启动创建管理员账号时的初始口令 |
| `VFLETCH_TRUST_PROXY` | 未设置 | 是否采信 `X-Forwarded-For`（详见下文「反向代理与限流」） |
| `VFLETCH_MAX_FAILS` / `VFLETCH_IP_MAX_FAILS` | `5` / `60` | 登录失败锁定 / 单 IP 限流阈值 |
| `VFLETCH_MAX_CONCURRENT_TURNS` | `10` | 并发回合上限（超出返回 429） |

---

## 文档索引

| 文档 | 作用 |
|---|---|
| [`README.md`](README.md) | 本文件：定位、快速开始、目录导航、配置与边界。 |
| [`PROVENANCE.md`](PROVENANCE.md) | 来源与合规声明：独立开发声明、主题令牌对齐范围的如实披露、核验方法与未核验项。 |
| [`LICENSE`](LICENSE) | Apache License 2.0 全文。 |
| [`docs/remote-mcp-guide.md`](docs/remote-mcp-guide.md) | 远端 MCP（Streamable HTTP）配置与连不通时的排查步骤、离线替代方案。 |
| [`checksums.sha256`](checksums.sha256) | 全仓文件 SHA-256 校验清单。 |
| `config/model.example.json` | 模型接入配置模板（含 DeepSeek / GLM / Qwen 示例）。 |
| `config/mcp.example.json` | MCP 配置模板。 |
| `server/adapters/custom.mjs` | 自定义模型协议适配器模板与事件契约说明。 |

---

## CLI 诊断

```bash
node server/cli.mjs mcp:list     # 列出所有 server 与工具（含暴露名）
node server/cli.mjs mcp:doctor   # 冲突诊断 + 疑似明文密钥告警
node server/cli.mjs model:ping   # 逐个供应商发探测请求
```

对应 npm 脚本：`npm run mcp:list` / `npm run mcp:doctor` / `npm run model:ping`。

---

## 架构

```
web/  (Vite + React，构建为静态资源)
  │  fetch / SSE
  ▼
server/main.mjs  (node:http)
  ├─ /api/chat           SSE 流式对话（含工具执行回合）
  ├─ /api/models         模型配置（脱敏，密钥只回 hasApiKey/env 引用）
  ├─ /api/mcp/list|reload|call|probe|install|uninstall
  ├─ /api/kb/*           企业共享知识库
  ├─ /api/team/*|auth/*|admin/*   员工体系 / 账号 / 管理
  ├─ /api/audit/*|rms/*|aigc/*    审计留痕 / 风控 / AI 内容监测
  └─ /api/settings|usage|suggest|upload|image|meta|health
        ├─ lib/model.mjs        OpenAI 兼容 / custom adapter
        ├─ lib/mcp-manager.mjs  stdio/http MCP 连接、命名空间、冲突诊断
        └─ lib/chat.mjs        回合循环：模型 → 工具 → 模型
```

### 工具命名规则

所有 MCP 工具对模型暴露为 **`<serverId>__<toolName>`**（仅含 `[A-Za-z0-9_-]`，超 64 字符截断补 hash）。
多个 server 提供同名工具也不会冲突；`mcp:doctor` 会列出所有被截断/改名的工具。

---

## 密钥安全

- `config/model.json` 与 `config/mcp.json` 里的密钥都建议写 `"env:VAR_NAME"`，不落盘明文。
- 读取配置时只返回 `hasApiKey` / `env` 引用，**密钥永不回传明文**；保存时空 `apiKey` = 保持原值。
- `mcp:doctor` 会扫描 server 配置里疑似明文密钥并告警。
- 明文密钥**不要提交进仓库**；若不慎提交，请先轮换该密钥，再改为 `env:` 引用。

---

## 测试

```bash
bash dev/run-all.sh            # 一键全量回归（28 套件，需先重启隔离测试服务器）
node dev/t-unit-guards.mjs     # 单元守护（78 项，无需服务）
node dev/t-stress.mjs          # 压力测试（需 VF_TEST_BASE 指向运行中的实例）
node dev/t-persist-check.mjs   # 重启后限流存活复验（自起 :8797）
node dev/t-trust-proxy.mjs     # 反向代理信任语义（自起 :8798）
node dev/t-session-owner.mjs   # 会话归属契约：他人 session id 必须 403
node dev/apitest.mjs           # 接口测试
tools/loadtest.mjs             # 稳定性压测（零依赖）
```

> ⚠️ 测试实例是**单例**（默认 `127.0.0.1:8790`）。不要同时跑多个 `dev/run-all.sh`：
> 任何一方重启或重置数据库都会让另一方出现大片假失败。需要并行时各自用不同的
> `VFLETCH_PORT` + `VFLETCH_CONFIG_DIR`。

---

## 反向代理与限流（可选）

> 本地直跑（`npm start`）时无需关注本节；仅当你把服务放到反向代理后面时才需要。

登录失败计数与审计里的客户端 IP 默认取**直连对端**地址，不采信 `X-Forwarded-For`。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `VFLETCH_TRUST_PROXY` | 未设置（=仅在对端为本机/内网反代时采信 XFF） | 设为 `1` 强制采信；设为 `0` **彻底忽略** XFF。采信时取 XFF 链中**最后一个合法 IP**（反代以 append 方式追加，链首由客户端可伪造），避免限流键与审计 IP 被伪造。服务直接对外暴露时请设为 `0`。 |
| `VFLETCH_MAX_FAILS` | `5` | 同一「用户名+IP」连续失败多少次后锁定 |
| `VFLETCH_IP_MAX_FAILS` | `60` | 单 IP 在 10 分钟窗口内跨用户名失败多少次后限流 |
| `VFLETCH_MAX_CONCURRENT_TURNS` | `10` | 并发回合上限，超出直接友好拒绝（429）而非排队雪崩 |

---

## 合规与许可

- **许可**：Apache License 2.0（见 [`LICENSE`](LICENSE)）。
- **来源**：代码为独立实现，未包含任何第三方受版权保护的源码。设计上参考的是公开的 agent 架构模式
  （工具回合循环、MCP 工具命名空间、上下文裁剪）。
- **对齐披露**：对话页的浅色主题令牌与输入区元素骨架，对齐自公开分发的第三方桌面应用的渲染层表现，
  **仅涉及配色数据与 DOM 元素名**，不含任何上游源码；未使用其产品标识、商标、内部模块名或调色板生成器。
- **发布面净化**：发布前已做全量签名扫描与结构比对，并移除云端地址、演示凭据、联网授权校验与远程控制通道。
  方法与完整结果见 [`PROVENANCE.md`](PROVENANCE.md)（含未核验项，如实列出）。
- **第三方商标**归其各自所有者，仅用于描述性指代；本项目与其无隶属或背书关系。

---

## 已知边界

- 本机 Windows 示例 MCP server 用 `npx.cmd`（MCP SDK 在 Windows 下 spawn `npx` 会失败）。
- 每个回合最多执行 `maxToolRounds` 轮工具调用（默认 8），防止模型死循环。
- 不支持 function calling 的模型自动降级为 ```` ```tool JSON``` ```` 文本协议（见 `server/lib/model.mjs`）。
- 请求体超限时会在返回 4xx 后**主动断开该连接**（未读完的 body 会污染同一条长连接的后续请求）。
- 首次运行必须先 `npm run build:web`，否则后端没有可托管的前端产物（会给出缺失提示）。
- **`npm install && npm start` 需先按上文第 1 步建好 `config/model.json`**；未配置模型时服务可启动，
  但对话会因拿不到模型端点而失败。纯离线环境需自备本地推理端点。
- `server/lib/report.mjs` 提供一个**可选**的跨实例留痕上报能力（`VFLETCH_REPORT_URL`），未配置时完全惰性、不发任何网络请求。
- git 历史问题与随附二进制等发布注意事项见 [`PROVENANCE.md`](PROVENANCE.md) 第 6.4 节。

---

## 许可

Apache License 2.0 — 见 [`LICENSE`](LICENSE)。
