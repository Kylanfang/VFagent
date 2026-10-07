// V-Fletch 请求级运行上下文（AsyncLocalStorage）：
// 每个并发请求拥有独立的 { userId, role, employeeId, memoryConsent } 等，
// 修复模块级变量被并发轮次互相覆盖的问题（CodeX MEM-01），并为工具执行层
// 传递身份/授权提供统一通道（后续 ToolGateway 的地基）。
import { AsyncLocalStorage } from "node:async_hooks";

export const runContext = new AsyncLocalStorage();

/** 在请求入口包裹：runInContext({ userId, role }, () => ...) */
export function runInContext(store, fn) {
  return runContext.run(store ?? {}, fn);
}

export function getContext() {
  return runContext.getStore() ?? null;
}

export function contextValue(key, fallback = null) {
  const store = runContext.getStore();
  return store != null && store[key] !== undefined ? store[key] : fallback;
}
