import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { CONFIG_DIR, loadMcpConfig } from "./config.mjs";
import { log, warn } from "./util.mjs";
import { BUILTIN_SERVERS } from "./builtin.mjs";
import { addMcpServer, removeMcpServer, getMcpServerDefinition } from "./settings.mjs";

// ---------------------------------------------------------------------------
// MCP 子进程回收（修复：进程退出后 npx/node 子进程全部变成孤儿进程）
//
// 背景：SDK 的 StdioClientTransport.close() 只 kill **直接子进程**，而 Windows 上
// `npx -y @scope/server` 的结构是 cmd/npx(直接子进程) → node server.js(孙进程)，
// 杀掉 npx 之后真正的 MCP server 仍然活着。更糟的是 Node 在 Windows 上收到
// `process.kill(pid, "SIGTERM")` 时走的是 TerminateProcess，**不会**执行任何 JS 回调，
// 所以"重启服务"= 泄漏一整套 MCP 子进程（实测一次全量回归后残留 8 个）。
// 这里登记每个 server 子进程的 pid，并优先用 `taskkill /T`（POSIX 用 pkill -P）按**进程树**回收。
const MCP_CHILD_PIDS = new Set();

export function killProcessTree(pid) {
  if (pid == null) return;
  try {
    if (process.platform === "win32") {
      // /T 连子孙一起杀；进程已退出时 taskkill 会返回非 0，属正常情况，忽略即可
      spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      // 先杀直接子进程（npx 下的真实 server），再杀自身
      spawnSync("pkill", ["-P", String(pid)], { stdio: "ignore" });
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* 进程已不存在或无权操作：忽略 */
  }
}

/** 进程退出兜底：`process.on("exit")` 里只能做同步操作，这里同步清掉所有登记的子进程树 */
export function killOrphanedMcpChildrenSync() {
  for (const pid of MCP_CHILD_PIDS) killProcessTree(pid);
  MCP_CHILD_PIDS.clear();
}

const SCOPE = "mcp";

let SDK = null;
async function sdk() {
  if (SDK != null) return SDK;
  const [clientMod, stdioMod, httpMod] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]);
  SDK = {
    Client: clientMod.Client,
    StdioClientTransport: stdioMod.StdioClientTransport,
    StreamableHTTPClientTransport: httpMod.StreamableHTTPClientTransport,
  };
  return SDK;
}

const OPENAI_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function sanitizeSegment(value) {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
}

function shortHash(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 8);
}

/**
 * 把 serverId + toolName 压成 OpenAI 允许的工具名（[A-Za-z0-9_-]{1,64}）。
 * 超长时截断并补 hash，保证仍然唯一。
 * 修复：原 `budget = Math.max(warnLimit - prefix.length - 9, 8)` 的下限 8 会在
 * serverId 很长（prefix > warnLimit-9）时产出**超过 warnLimit** 的名字，模型端直接拒整次请求；
 * 且重名后缀 `_aN` 是在截断之后追加的，也会突破上限。这里统一在最后做长度收敛。
 */
export function namespacedToolName(serverId, toolName, warnLimit = 64) {
  const limit = Number(warnLimit) > 0 ? Math.floor(Number(warnLimit)) : 64;
  const prefix = `${sanitizeSegment(serverId)}__`;
  const base = sanitizeSegment(toolName);
  const full = `${prefix}${base}`;
  if (full.length <= limit) return { name: full, truncated: false };
  const hash = shortHash(base || full);
  const budget = Math.max(limit - prefix.length - 9, 1);
  let name = `${prefix}${base.slice(0, budget)}_${hash}`;
  if (name.length > limit) name = `${prefix.slice(0, Math.max(limit - 9, 0))}_${hash}`;
  return { name: name.slice(0, limit), truncated: true };
}

/** 重名（或超长）时生成不与已有名字冲突、且长度不超限的备用名：_a、_a2、_a3… */
function collisionName(base, taken, limit) {
  let n = 1;
  let alt = `${base}_a`;
  while (taken.has(alt) || alt.length > limit) {
    n += 1;
    alt = `${base}_a${n}`;
    if (n > 1000) {
      alt = `${base.slice(0, Math.max(limit - 12, 1))}_${shortHash(`${base}#${n}`)}`;
      break;
    }
  }
  return alt.slice(0, limit);
}

function withTimeout(promise, ms, label) {
  if (ms == null || ms <= 0) return promise;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const SUSPICIOUS_ENV = /(sk-[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{8,}|Bearer\s+\S+|token|secret|password|api[-_]?key)/i;

export class McpManager {
  constructor() {
    this.servers = [];
    this.tools = new Map();
    this.exposedNames = new Map(); // `${serverId}\u0000${originalName}` -> 实际暴露名（含重名重命名）
    this.conflicts = [];
    this.startedAt = null;
    this.starting = null; // start() 的串行化链
  }

  /**
   * 重连全部 MCP server。
   * 修复 A（子进程泄漏）：原实现直接 `this.servers = []` 丢弃旧记录，从不 close()，
   * 每次 reload/install/uninstall 都会重新 spawn 一套子进程，旧的永久存活（卸载后仍在跑）。
   * 修复 B（重入竞态）：/api/mcp/reload、installServer、uninstallServer、设置保存都会调 start()，
   * 并发重叠时互相覆盖 this.servers，出现重复 server、重复工具、N 倍子进程。这里用 Promise 链串行化。
   */
  async start() {
    const run = () => this.#doStart();
    const next = (this.starting ?? Promise.resolve()).then(run, run);
    this.starting = next.catch(() => {});
    return next;
  }

  /**
   * 关闭当前已连接的外部 client（内置 server 无 client，跳过）。
   * 修复（子进程孤儿化）：先按**进程树**回收子进程，再 close()。
   * 顺序很关键 —— SDK 的 close() 会先把直接子进程（npx）杀掉，此后 `taskkill /T <npxPid>`
   * 便失去了定位孙进程的锚点，真正的 MCP server 就永远活着了。
   */
  async #closeClients() {
    const servers = this.servers;
    const clients = servers.map((s) => s.client).filter((c) => c != null);
    this.servers = [];
    this.tools.clear();
    this.exposedNames.clear();
    for (const server of servers) {
      if (server.pid != null) {
        killProcessTree(server.pid);
        MCP_CHILD_PIDS.delete(server.pid);
      }
    }
    await Promise.all(
      clients.map(async (client) => {
        try { await client.close(); } catch { /* 已断开/超时的连接关闭失败可忽略 */ }
      }),
    );
  }

  /** 进程优雅退出时调用：释放全部 MCP 子进程（供 SIGINT/SIGTERM 与 exit 兜底使用） */
  async stopAll() {
    await this.#closeClients();
  }

  async #doStart() {
    // 配置读取容错：mcp.json 正被写入/损坏时降级为仅内置 server，不让 start() 整体失败
    let config;
    try {
      config = loadMcpConfig();
    } catch (error) {
      warn(SCOPE, "mcp.json 读取失败，本次仅加载内置 server", { error: String(error?.message ?? error) });
      config = { limits: {}, servers: [] };
    }
    // 内置 server 代码级注入：即使用户 mcp.json 是旧版也能生效；用户显式配置同 id 时以用户为准
    const servers = [...config.servers];
    for (const [id, def] of Object.entries(BUILTIN_SERVERS)) {
      if (!servers.some((s) => s.id === id)) {
        servers.push({ id, name: def.name ?? id, builtin: id, enabled: true });
      }
    }
    const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await sdk();
    this.limits = config.limits ?? {};
    await this.#closeClients();
    this.conflicts = [];

    for (const definition of servers) {
      if (definition.enabled !== true) {
        this.servers.push({
          id: definition.id,
          name: definition.name ?? definition.id,
          transport: definition.transport,
          status: "disabled",
          tools: [],
          error: null,
        });
        continue;
      }

      // ---- 内置（in-process）server：无外部进程依赖，状态恒为 connected ----
      if (definition.builtin != null) {
        const builtin = BUILTIN_SERVERS[definition.builtin];
        const record = {
          id: definition.id,
          name: definition.name ?? builtin?.name ?? definition.id,
          transport: "builtin",
          status: "connecting",
          tools: [],
          error: null,
          command: null,
          url: null,
        };
        if (builtin == null) {
          record.status = "error";
          record.error = `未知内置 server: ${definition.builtin}`;
          warn(SCOPE, record.error);
        } else {
          record.tools = builtin.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          }));
          record.builtin = builtin;
          record.status = "connected";
          record.connectedAt = new Date().toISOString();
          log(SCOPE, `${definition.id}（内置）就绪，工具 ${record.tools.length} 个`);
        }
        this.servers.push(record);
        continue;
      }

      const record = {
        id: definition.id,
        name: definition.name ?? definition.id,
        transport: definition.transport,
        status: "connecting",
        tools: [],
        error: null,
        command: definition.command ?? null,
        url: definition.url ?? null,
      };
      try {
        // 占位符解析：{{APP}}=应用根、{{WORKSPACE}}=工作区（发行包 stdio server 随包分发时使用）
        const resolveToken = (v) =>
          String(v ?? "")
            .replaceAll("{{APP}}", process.env.VFLETCH_ROOT ?? process.cwd())
            .replaceAll("{{CONFIG}}", process.env.VFLETCH_CONFIG_DIR ?? path.join(process.env.VFLETCH_ROOT ?? process.cwd(), "config"))
            .replaceAll("{{WORKSPACE}}", process.env.VFLETCH_WORKSPACE ?? process.cwd());
        const resolveCommand = (cmd) => {
          let c = resolveToken(cmd);
          // "node" 在 Electron 环境下用自带运行时（ELECTRON_RUN_AS_NODE），测试员机器无需安装 Node
          if (c === "node" && process.versions.electron) return process.execPath;
          // Windows 下 npx 必须带 .cmd 后缀才能被 spawn（目录里的配置直接写 npx 亦可）
          if (process.platform === "win32" && c.toLowerCase() === "npx") c = "npx.cmd";
          return c;
        };
        const childEnv = { ...process.env, ...(definition.env ?? {}) };
        if (process.versions.electron && resolveCommand(definition.command) === process.execPath) {
          childEnv.ELECTRON_RUN_AS_NODE = "1";
        }
        const transport =
          definition.transport === "http"
            ? new StreamableHTTPClientTransport(new URL(definition.url), {
                requestInit: Object.keys(definition.headers ?? {}).length > 0 ? { headers: definition.headers } : undefined,
              })
            : new StdioClientTransport({
                command: resolveCommand(definition.command),
                args: (definition.args ?? []).map(resolveToken),
                env: childEnv,
                stderr: "pipe",
              });
        // 修复：stderr 被 SDK 接成 PassThrough 但原实现从不读取——子进程写满管道缓冲（约 16-64KB）后
        // 会阻塞在 write 上，表现为 initialize 永久挂起；同时最有价值的失败输出被丢弃。
        if (transport?.stderr?.on != null) {
          transport.stderr.on("data", (chunk) => {
            const text = String(chunk ?? "").trim();
            if (text !== "") warn(SCOPE, `${definition.id} stderr: ${text.slice(0, 500)}`);
          });
          transport.stderr.on("error", () => {});
        }

        const client = new Client({ name: "v-fletch", version: "0.1.0" });
        try {
          await withTimeout(client.connect(transport), this.limits.connectTimeoutMs ?? 60000, `${definition.id} 连接`);
        } catch (error) {
          // 连接失败（含超时）时子进程可能已经 spawn 出来：这里按进程树回收，避免"连不上但进程还在"
          const pid = transport?.pid ?? null;
          if (pid != null) killProcessTree(pid);
          throw error;
        }
        // 登记子进程 pid，供 close/stopAll/进程退出时按进程树回收
        if (transport?.pid != null) {
          record.pid = transport.pid;
          MCP_CHILD_PIDS.add(transport.pid);
        }

        const listed = await withTimeout(client.listTools(), this.limits.connectTimeoutMs ?? 60000, `${definition.id} 列工具`);
        record.client = client;
        record.tools = (listed?.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        }));
        record.status = "connected";
        record.connectedAt = new Date().toISOString();
        log(SCOPE, `${definition.id} 已连接，工具 ${record.tools.length} 个`);
      } catch (error) {
        record.status = "error";
        record.error = String(error?.message ?? error);
        warn(SCOPE, `${definition.id} 连接失败`, { error: record.error });
      }
      this.servers.push(record);
    }

    this.#indexTools();
    this.#diagnose(config);
    this.startedAt = new Date().toISOString();
    return this.snapshot();
  }

  #indexTools() {
    this.tools.clear();
    this.exposedNames.clear();
    const limit = Number(this.limits?.warnToolNameLength) > 0 ? Number(this.limits.warnToolNameLength) : 64;
    for (const server of this.servers) {
      if (server.status !== "connected") continue;
      for (const tool of server.tools) {
        let { name, truncated } = namespacedToolName(server.id, tool.name, limit);
        if (this.tools.has(name)) {
          // 命名冲突不再丢弃工具（此前被丢弃的工具即用户眼中的"无效 MCP"）：
          // 自动加后缀 _a/_a2… 让所有工具都可用，冲突降级为 info 提示
          const alt = collisionName(name, this.tools, limit);
          this.conflicts.push({
            severity: "info",
            kind: "namespace-collision",
            server: server.id,
            tool: tool.name,
            message: `工具重名 ${name}：来自 ${server.id} 的版本已自动重命名为 ${alt}，可正常使用`,
          });
          name = alt;
        }
        // 记录实际暴露名：snapshot() 必须复用它，否则重名重命名后在 MCP 页/直调通道里会看到重复名
        this.exposedNames.set(`${server.id}\u0000${tool.name}`, name);
        this.tools.set(name, { serverId: server.id, originalName: tool.name, truncated, tool });
      }
    }
  }

  #diagnose(config) {
    const warnLimit = this.limits.warnToolNameLength ?? 64;
    const maxSchema = this.limits.maxSchemaCharsPerTool ?? 12000;
    const maxTotal = this.limits.maxToolsTotal ?? 60;

    const ids = new Set();
    for (const definition of config.servers) {
      if (ids.has(definition.id)) {
        this.conflicts.push({
          severity: "error",
          kind: "duplicate-server-id",
          server: definition.id,
          message: `mcp.json 中出现重复的 server id: ${definition.id}`,
        });
      }
      ids.add(definition.id);

      if (process.platform === "win32" && definition.transport !== "http" && definition.command === "npx") {
        // Windows 下 spawn "npx" 会失败，运行时已自动映射为 npx.cmd——降级为 info 提示而非 error（P1-4）
        this.conflicts.push({
          severity: "info",
          kind: "windows-npx",
          server: definition.id,
          message: `Windows 下已自动将 npx 映射为 npx.cmd 运行；如遇启动问题可手工改为 npx.cmd`,
        });
      }

      for (const [key, value] of Object.entries(definition.env ?? {})) {
        // 注意：definition.env 已被 loadMcpConfig() 解析（"env:VAR" → 进程环境里的真实密钥），
        // 因此不能拿它判断"是否明文写盘"。改为读磁盘原始定义：只有**非空且未使用 env: 引用**的值才算明文密钥。
        const rawValue = Object.entries(getMcpServerDefinition(definition.id)?.env ?? {})
          .find(([k]) => k === key)?.[1];
        if (rawValue == null) continue;
        const literal = String(rawValue).trim();
        if (literal === "" || literal.startsWith("env:")) continue;
        if (SUSPICIOUS_ENV.test(`${key}=${literal}`)) {
          this.conflicts.push({
            severity: "warning",
            kind: "inline-secret",
            server: definition.id,
            message: `环境变量 ${key} 疑似把密钥明文写在 mcp.json 里，建议改成 "env:VAR_NAME"`,
          });
        }
      }
    }

    const byOriginalName = new Map();
    for (const [namespaced, entry] of this.tools) {
      const list = byOriginalName.get(entry.originalName) ?? [];
      list.push({ namespaced, serverId: entry.serverId });
      byOriginalName.set(entry.originalName, list);

      if (entry.truncated) {
        this.conflicts.push({
          severity: "warning",
          kind: "truncated-name",
          server: entry.serverId,
          tool: entry.originalName,
          message: `工具名过长，暴露给模型时已截断为 ${namespaced}，模型看到的名称与 MCP 原名不一致`,
        });
      }
      if (!OPENAI_NAME_RE.test(namespaced)) {
        this.conflicts.push({
          severity: "error",
          kind: "invalid-name",
          server: entry.serverId,
          tool: entry.originalName,
          message: `暴露给模型的名称 ${namespaced} 不符合 [A-Za-z0-9_-]{1,64}，模型端会拒绝`,
        });
      }
      if ((entry.tool.description ?? "").trim().length === 0) {
        this.conflicts.push({
          severity: "warning",
          kind: "missing-description",
          server: entry.serverId,
          tool: entry.originalName,
          message: `${entry.originalName} 没有 description，模型无法判断何时该调用它`,
        });
      }
      const schemaSize = JSON.stringify(entry.tool.inputSchema ?? {}).length;
      if (schemaSize > maxSchema) {
        this.conflicts.push({
          severity: "warning",
          kind: "schema-too-large",
          server: entry.serverId,
          tool: entry.originalName,
          message: `${entry.originalName} 的 schema 有 ${schemaSize} 字符，超过阈值 ${maxSchema}，会显著挤压上下文`,
        });
      }
    }

    for (const [originalName, list] of byOriginalName) {
      if (list.length > 1) {
        this.conflicts.push({
          severity: "info",
          kind: "duplicate-tool-name",
          message: `工具 ${originalName} 由多个 server 提供（${list.map((item) => item.serverId).join(", ")}），已用命名空间区分：${list.map((item) => item.namespaced).join(", ")}`,
        });
      }
    }

    if (this.tools.size > maxTotal) {
      this.conflicts.push({
        severity: "warning",
        kind: "too-many-tools",
        message: `当前共 ${this.tools.size} 个工具，超过阈值 ${maxTotal}。工具定义会常驻上下文，建议只启用需要的 server`,
      });
    }

    for (const server of this.servers) {
      if (server.status === "error") {
        this.conflicts.push({
          severity: "error",
          kind: "server-error",
          server: server.id,
          message: `${server.id} 启动失败：${server.error}`,
        });
      }
      if (server.status === "connected" && server.tools.length === 0) {
        this.conflicts.push({
          severity: "info",
          kind: "no-tools",
          server: server.id,
          message: `${server.id} 已连接但没有暴露任何工具`,
        });
      }
    }
  }

  toOpenAiTools() {
    return [...this.tools.entries()].map(([name, entry]) => ({
      type: "function",
      function: {
        name,
        description: `[${entry.serverId}] ${entry.tool.description ?? ""}`.trim(),
        parameters: entry.tool.inputSchema ?? { type: "object", properties: {} },
      },
    }));
  }

  /**
   * 工具视图（沙盒）：返回与 McpManager 同接口的只读子集，回合层拿到的是它而不是全量管理器，
   * 视图外的工具即使模型编造名字调用也会被拒绝（不是"隐藏"而是"不可达"）。
   * - scoped(prefix)：只保留暴露名以 prefix 开头的工具（如 "secretary__"）
   * - without(prefixes)：剔除以任一 prefix 开头的工具（普通会话剥离 AI 秘书的系统只读工具）
   */
  #view(filter) {
    const parent = this;
    const tools = new Map([...this.tools.entries()].filter(([name]) => filter(name)));
    return {
      tools,
      get servers() { return parent.servers; },
      get startedAt() { return parent.startedAt; },
      toOpenAiTools: () => [...tools.entries()].map(([name, entry]) => ({
        type: "function",
        function: {
          name,
          description: `[${entry.serverId}] ${entry.tool.description ?? ""}`.trim(),
          parameters: entry.tool.inputSchema ?? { type: "object", properties: {} },
        },
      })),
      callTool: (name, args, timeoutMs) => {
        if (!tools.has(name)) return Promise.reject(new Error(`当前会话无权使用工具: ${name}`));
        return parent.callTool(name, args, timeoutMs);
      },
      snapshot: () => ({ ...parent.snapshot(), toolCount: tools.size, scoped: true }),
      scoped: (prefix) => parent.#view((n) => filter(n) && n.startsWith(prefix)),
      without: (prefixes) => parent.#view((n) => filter(n) && !prefixes.some((p) => n.startsWith(p))),
    };
  }

  scoped(prefix) {
    return this.#view((name) => name.startsWith(String(prefix ?? "")));
  }

  without(prefixes) {
    const list = Array.isArray(prefixes) ? prefixes : [prefixes];
    return this.#view((name) => !list.some((p) => name.startsWith(String(p ?? ""))));
  }

  async callTool(namespacedName, args, timeoutMs) {
    const entry = this.tools.get(namespacedName);
    if (entry == null) throw new Error(`未注册的工具: ${namespacedName}`);
    const server = this.servers.find((item) => item.id === entry.serverId);
    if (server == null) throw new Error(`MCP server ${entry.serverId} 不存在`);

    // 内置 server：直接进程内调用 handler
    if (server.transport === "builtin" && server.builtin != null) {
      const tool = server.builtin.tools.find((t) => t.name === entry.originalName);
      if (tool == null) throw new Error(`内置工具不存在: ${entry.originalName}`);
      try {
        const result = await tool.handler(args ?? {});
        if (result != null && typeof result === "object" && result.isError === true) {
          // 内置工具可用 isError 标记业务失败（如 code_run 超时），把详情带给模型
          const { isError, ...rest } = result;
          return { text: JSON.stringify(rest), isError: true };
        }
        return { text: typeof result === "string" ? result : JSON.stringify(result), isError: false };
      } catch (error) {
        return { text: `内置工具执行失败: ${String(error?.message ?? error)}`, isError: true };
      }
    }

    if (server?.client == null) throw new Error(`MCP server ${entry.serverId} 未连接`);
    const result = await withTimeout(
      server.client.callTool({ name: entry.originalName, arguments: args ?? {} }),
      timeoutMs ?? this.limits.callTimeoutMs ?? 120000,
      `${namespacedName} 调用`,
    );
    return normalizeToolResult(result);
  }

  /**
   * 动态安装一个 MCP server：写回 config/mcp.json 后立即重连全部。
   * definition 为原始结构（env 里的 "env:VAR" 保持引用，不落盘明文）。
   */
  async installServer(definition) {
    const transport = definition?.transport === "http" ? "http" : "stdio";
    const id = String(definition?.id ?? "").trim();
    // 先校验再落盘：此前非法定义（空命令/带空格 id）会先写进 mcp.json 再卡 20s 连接超时，且垃圾配置永久残留
    if (!/^[a-z][a-z0-9_-]{0,31}$/i.test(id)) throw new Error("server id 需为 1-32 位字母/数字/下划线/中划线，字母开头");
    if (BUILTIN_SERVERS[id] != null) throw new Error(`id 与内置 server 冲突: ${id}`);
    const normalized = {
      id,
      name: String(definition?.name ?? id).trim() || id,
      enabled: definition?.enabled !== false,
      transport,
    };
    if (transport === "http") {
      const url = String(definition?.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) throw new Error("http 传输需提供以 http(s):// 开头的 url");
      normalized.url = url;
      normalized.headers = definition?.headers && typeof definition.headers === "object" ? definition.headers : {};
    } else {
      const command = String(definition?.command ?? "").trim();
      if (command === "") throw new Error("stdio 传输需提供 command");
      normalized.command = command;
      normalized.args = Array.isArray(definition?.args) ? definition.args.map(String) : [];
      normalized.env = definition?.env && typeof definition.env === "object" ? definition.env : {};
    }
    // 草稿安装（draft）：需密钥/连接串的目录条目（envKeys 非空）批准后先落盘为「停用」，
    // 主控在 MCP 页补齐环境变量后再启用；否则这类条目在批准瞬间因缺密钥连接失败，永远装不上。
    if (definition?.draft === true) {
      normalized.enabled = false;
      const savedDraft = addMcpServer(normalized);
      const draftSnapshot = await this.start();
      return { ...savedDraft, snapshot: draftSnapshot, draft: true };
    }
    const saved = addMcpServer(normalized);
    const snapshot = await this.start();
    const record = this.servers.find((s) => s.id === id);
    // disabled 是合法终态（草稿/停用），不能当成"连接失败"——原实现只认 connected，
    // 导致 enabled:false 的安装必然抛错并顺手删掉刚写入的配置。
    if (record == null || (record.status !== "connected" && record.status !== "disabled")) {
      const reason = record?.error ?? `server 未连接（status=${record?.status ?? "未注册"}）`;
      // 回滚：若安装前已存在同 id 的可用定义（upsert 覆盖），恢复它；否则才删除。
      try {
        if (saved?.previous != null) addMcpServer(saved.previous);
        else removeMcpServer(id);
      } catch {}
      await this.start().catch(() => {});
      throw new Error(`MCP server "${id}" 连接失败，已撤销安装：${reason}`);
    }
    return { ...saved, snapshot };
  }

  /**
   * 动态卸载一个 MCP server：从 config/mcp.json 移除后立即重连全部。
   * 内置 server 是代码级注入的（start() 会自动补回），因此卸载内置 server 时写入一条 enabled:false
   * 的停用记录，否则原实现会"返回 200 但仍然连着"（用户以为删掉了，实际还在跑）。
   */
  async uninstallServer(id) {
    const def = getMcpServerDefinition(id);
    let saved;
    if (BUILTIN_SERVERS[id] != null || def?.builtin != null) {
      saved = addMcpServer({
        id,
        name: def?.name ?? BUILTIN_SERVERS[id]?.name ?? id,
        builtin: def?.builtin ?? id,
        enabled: false,
      });
    } else {
      saved = removeMcpServer(id);
    }
    const snapshot = await this.start();
    return { ...saved, snapshot };
  }

  snapshot() {
    const warnLimit = Number(this.limits?.warnToolNameLength) > 0 ? Number(this.limits.warnToolNameLength) : 64;
    return {
      startedAt: this.startedAt,
      toolCount: this.tools.size,
      servers: this.servers.map((server) => ({
        id: server.id,
        name: server.name,
        transport: server.transport,
        status: server.status,
        error: server.error,
        command: server.command,
        url: server.url,
        toolCount: server.tools.length,
        tools: server.tools.map((tool) => {
          const { name } = namespacedToolName(server.id, tool.name, warnLimit);
          const exposed = this.exposedNames.get(`${server.id}\u0000${tool.name}`) ?? name;
          return {
            originalName: tool.name,
            exposedName: exposed,
            description: tool.description,
            schemaChars: JSON.stringify(tool.inputSchema ?? {}).length,
          };
        }),
      })),
      conflicts: this.conflicts,
    };
  }
}

export function normalizeToolResult(result) {
  const content = result?.content ?? [];
  const textParts = [];
  let structured = null;
  for (const item of content) {
    if (item?.type === "text" && typeof item.text === "string") textParts.push(item.text);
    else if (item?.type !== "text") structured = structured ?? item;
  }
  // MCP 2025-06-18：工具可以只返回 structuredContent（无 text content）。
  // 原实现完全忽略该字段，模型会收到"(工具无输出)"，无法区分"没有数据"和"数据在结构化字段里"。
  if (structured == null && result?.structuredContent != null) structured = result.structuredContent;
  let text = textParts.join("\n");
  if (structured != null) {
    text = `${text}${text ? "\n" : ""}${JSON.stringify(structured).slice(0, 4000)}`;
  }
  if (result?.isError === true) {
    text = `工具返回错误: ${text}`;
  }
  return { text: text || "(工具无输出)", isError: result?.isError === true };
}
