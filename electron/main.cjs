// V-Fletch Desktop — Electron 主进程（CJS：Electron 44 的 ESM 主进程无法解析内置 electron 模块）
// 职责：单实例锁 → 可写 config 引导 → 动态空闲端口 → 内嵌启动 HTTP server
//       → 原生窗口加载 http://127.0.0.1:<port>（UI 与后端同源，MCP 工具回路不变）
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
// 客户端只与自有服务器通信（页面/接口/流式对话），强制绕过系统代理：
// 避免 VPN/Clash 把长连接 SSE 劫持到境外出口导致 502/断流
app.commandLine.appendSwitch("no-proxy-server");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { existsSync, mkdirSync, readdirSync, readFileSync, copyFileSync, cpSync, appendFileSync, statSync, renameSync } = require("node:fs");
const net = require("node:net");

const DIR = __dirname; // <app>/electron
const APP_ROOT = path.resolve(DIR, ".."); // <app>（开发=vfletch/，打包=resources/app/）
const isPacked = app.isPackaged;

// 日志：超过 5MB 滚动为 main.log.1（只保留一代），避免无限增长（审计 L2）
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;
function log(msg) {
  console.log(msg);
  try {
    const file = path.join(app.getPath("userData"), "main.log");
    try {
      if (existsSync(file) && statSync(file).size > LOG_ROTATE_BYTES) {
        const prev = `${file}.1`;
        try { if (existsSync(prev)) require("node:fs").rmSync(prev, { force: true }); } catch {}
        renameSync(file, prev);
      }
    } catch {}
    appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

// 启动失败弹窗（审计 L5）：把常见英文异常翻成用户能看懂的中文，并提供"复制日志"按钮
function explainStartupError(raw) {
  const m = String(raw ?? "");
  if (/EADDRINUSE/i.test(m)) return "端口被占用：可能已有一个 V-Fletch 在运行，或其他程序占用了该端口。请先关闭后重试。";
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|health/i.test(m)) return "无法连接后端服务：本地引擎未能在限定时间内启动。请检查端口占用与杀毒软件拦截。";
  if (/EACCES|EPERM/i.test(m)) return "没有文件访问权限：请以有权限的账户运行，或检查安装目录是否被杀毒软件拦截。";
  if (/ENOENT/i.test(m)) return "缺少必要文件：安装可能不完整，请重新安装。";
  if (/SQLITE|database/i.test(m)) return "本地数据库打开失败：可能被其他进程占用或文件损坏，请重启电脑后重试。";
  if (/ERR_MODULE_NOT_FOUND|Cannot find module/i.test(m)) return "程序文件缺失：安装可能不完整，请重新安装。";
  return "启动过程中发生未预期的错误。";
}
function showStartupError(rawMsg) {
  const friendly = explainStartupError(rawMsg);
  const logFile = path.join(app.getPath("userData"), "main.log");
  const detail = String(rawMsg).slice(0, 1500);
  try {
    const { clipboard } = require("electron");
    const r = dialog.showMessageBoxSync({
      type: "error",
      title: "V-Fletch 启动失败",
      message: friendly,
      detail: `技术详情：\n${detail}\n\n日志文件：${logFile}`,
      buttons: ["复制日志并退出", "退出"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (r === 0) {
      let tail = "";
      try { tail = readFileSync(logFile, "utf8").split("\n").slice(-200).join("\n"); } catch {}
      clipboard.writeText(`${friendly}\n\n${detail}\n\n---- main.log 末尾 ----\n${tail}`);
    }
  } catch {
    dialog.showErrorBox("V-Fletch 启动失败", `${friendly}\n\n${detail}`);
  }
}

// ---------- 0. 进程级安全网 ----------
// 任何未捕获异常/未处理的 Promise 拒绝只记日志，绝不让主进程崩溃或弹"启动失败"后僵死。
// （曾出现：偶发 rejection 冒泡 → 启动失败弹窗 → app.quit() 被残留子进程卡住 → 界面冻结）
process.on("unhandledRejection", (reason) => {
  try { log(`[safety] unhandledRejection: ${String((reason && reason.stack) || reason).slice(0, 800)}`); } catch {}
});
process.on("uncaughtException", (err) => {
  try { log(`[safety] uncaughtException: ${String((err && err.stack) || err).slice(0, 800)}`); } catch {}
});
// 退出兜底：quit() 若被 MCP stdio 子进程拖住，1.5s 后强制退出，避免"卡着不动"
app.on("before-quit", () => {
  setTimeout(() => { try { app.exit(0); } catch {} }, 1500);
});

// 本地单机模式：不存在任何联网许可证/授权校验，也不依赖远程服务器。

// ---------- 1. config 引导 ----------
// 打包后 app 目录可能无写权限，把内置 config/*.json 首次拷贝到 userData/config（可写、可编辑）。
// 开发模式直接读源码 config/，改文件即时生效。
function ensureConfigDir() {
  const builtin = path.join(APP_ROOT, "config");
  let dir;
  // 显式指定 VFLETCH_CONFIG_DIR 且目录存在 → 直接使用（测试/多实例隔离用）
  const envDir = process.env.VFLETCH_CONFIG_DIR ? path.resolve(process.env.VFLETCH_CONFIG_DIR) : null;
  if (envDir && existsSync(envDir)) {
    dir = envDir;
  } else if (isPacked && existsSync(builtin)) {
    dir = path.join(app.getPath("userData"), "config");
    mkdirSync(dir, { recursive: true });
    for (const entry of readdirSync(builtin, { withFileTypes: true })) {
      const dst = path.join(dir, entry.name);
      if (existsSync(dst)) continue;
      try {
        if (entry.isDirectory()) {
          // 子目录（如 mcp-bundled）：从解包资源根递归复制（asar 内的目录无法被子进程读取）
          cpSync(path.join(resourceRoot(), "config", entry.name), dst, { recursive: true });
        } else {
          copyFileSync(path.join(builtin, entry.name), dst);
        }
      } catch (e) {
        log(`config copy fail ${entry.name}: ${e.message}`);
      }
    }
  } else {
    dir = builtin;
  }
  process.env.VFLETCH_CONFIG_DIR = dir;
  return dir;
}

// 打包后 web/dist 与 config/mcp-bundled 被 asarUnpack 到真实文件系统（asar 内目录 cpSync/子进程都读不了）
function resourceRoot() {
  return APP_ROOT.includes("app.asar") ? APP_ROOT.replace("app.asar", "app.asar.unpacked") : APP_ROOT;
}

/** 界面可写副本：首启从包内 web/dist 复制到 userData/ui，此后更新只交换该目录 */
function ensureUiDir() {
  const src = path.join(resourceRoot(), "web", "dist");
  const dir = path.join(app.getPath("userData"), "ui");
  try {
    if (existsSync(src) && !existsSync(path.join(dir, "index.html"))) {
      cpSync(src, dir, { recursive: true });
      log(`ui bootstrapped: ${dir}`);
    }
  } catch (e) {
    log(`ui bootstrap fail: ${e.message}`);
  }
  return existsSync(path.join(dir, "index.html")) ? dir : src;
}

// ---------- 2. 动态空闲端口 ----------
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// ---------- 3. 等待内嵌 server 就绪 ----------
async function waitHealth(port, timeoutMs) {
  const url = `http://127.0.0.1:${port}/api/health`;
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error(`服务未就绪: ${url}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------- 4. 主窗口 ----------
let win = null;

function createWindowTo(targetUrl) {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1000,
    minHeight: 660,
    title: "V-Fletch",
    frame: false, // 无边框：标题栏由渲染层自绘（Codex 式）
    autoHideMenuBar: true,
    backgroundColor: "#f5f6f8",
    icon: path.join(APP_ROOT, "brand", "icon.ico"),
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(DIR, "preload.cjs"),
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.loadURL(targetUrl);
  // 最大化状态同步：自绘标题栏按钮图标需要在 最大化/还原 间切换（无边框窗口没有原生标题栏可依赖）
  const sendMaxState = () => {
    try {
      if (win && !win.isDestroyed()) win.webContents.send("win:maxState", win.isMaximized());
    } catch {}
  };
  win.on("maximize", sendMaxState);
  win.on("unmaximize", sendMaxState);
  win.on("closed", () => {
    win = null;
  });
}

function createWindow(port) {
  createWindowTo(`http://127.0.0.1:${port}`);
}

// 无边框窗口控制 IPC
ipcMain.on("win:min", () => win?.minimize());
ipcMain.on("win:max", () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on("win:close", () => win?.close());

// ---------- 5. 生命周期 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // GPU 兜底（测试报告 P0）：无独显/远程桌面/VM/CI 上 GPU 进程崩溃会直接 "Goodbye" 自杀，
  // 办公界面不需要硬件加速，全局关闭以规避整类启动失败
  app.disableHardwareAcceleration();
  app.on("child-process-gone", (_e, details) => {
    log(`child-process-gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode} service=${details.service ?? ""}`);
  });

  app.whenReady().then(async () => {
    // ---- 本地单机模式：始终内嵌启动本地引擎，不连接任何远端服务器 ----
    // 桌面壳与 Web 版共用同一份 server/main.mjs；账号、模型与数据全部在本机。
    try {
      const configDir = ensureConfigDir();
      log(`config dir: ${configDir}`);
      const port = await freePort();
      process.env.VFLETCH_PORT = String(port);
      process.env.VFLETCH_HOST = "127.0.0.1";
      process.env.VFLETCH_ROOT = APP_ROOT;
      // 界面运行于可写副本（userData/ui），首次从包内 web/dist 引导
      const uiDir = ensureUiDir();
      process.env.VFLETCH_WEB_DIST = uiDir;
      // 工作区（文件类工具与监测扫描的根）
      const wsDir = path.join(app.getPath("userData"), "workspace");
      try { mkdirSync(wsDir, { recursive: true }); } catch {}
      process.env.VFLETCH_WORKSPACE = wsDir;
      // 引擎：开发态为源码 main.mjs；发行包为单文件构建产物 main.cjs
      const engineMjs = path.join(APP_ROOT, "server", "main.mjs");
      const engineCjs = path.join(APP_ROOT, "server", "main.cjs");
      const enginePath = existsSync(engineMjs) ? engineMjs : engineCjs;
      log(`engine: ${path.basename(enginePath)}`);
      await import(pathToFileURL(enginePath).href);
      await waitHealth(port, 40000);
      log(`V-Fletch ready on http://127.0.0.1:${port}`);
      createWindow(port);
    } catch (e) {
      const msg = String((e && e.stack) || e);
      log(`startup error: ${msg}`);
      showStartupError(msg);
      // app.quit() 可能被未退出的子进程卡住（表现为弹窗后应用僵死）——定时强制退出兜底
      setTimeout(() => { try { app.exit(1); } catch {} }, 500);
    }
  });

  app.on("window-all-closed", () => {
    app.quit(); // Windows/Linux：关窗即退出（连带停掉内嵌 server）
  });
}
