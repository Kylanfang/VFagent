// 渲染层桥：无边框窗口控制（contextIsolation 下唯一暴露面）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vfDesktop", {
  minimize: () => ipcRenderer.send("win:min"),
  toggleMaximize: () => ipcRenderer.send("win:max"),
  close: () => ipcRenderer.send("win:close"),
  // 订阅最大化状态变化（返回取消订阅函数；浏览器环境无此能力，调用方自行判空）
  onMaxState: (cb) => {
    const handler = (_event, value) => {
      try { cb(value); } catch {}
    };
    ipcRenderer.on("win:maxState", handler);
    return () => ipcRenderer.removeListener("win:maxState", handler);
  },
});
