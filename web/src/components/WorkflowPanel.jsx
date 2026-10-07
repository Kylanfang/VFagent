import React, { useState } from "react";

/**
 * ZCode 式工作流面板：计划步骤（todo_write）垂直连接线 + 实时工具流水。
 * 设计语言与对话页 z-* 组件一致：等宽字号、状态徽标、进行中脉冲。
 */

const STEP_META = {
  pending: { icon: "○", label: "待执行", cls: "pending" },
  in_progress: { icon: "◐", label: "执行中", cls: "running" },
  completed: { icon: "✓", label: "完成", cls: "done" },
};

function StepRow({ step, index, last }) {
  const meta = STEP_META[step.status] ?? STEP_META.pending;
  return (
    <li className={`wf-step ${meta.cls}`}>
      <span className="wf-node">
        <span className="wf-node-dot">{meta.icon}</span>
        {!last ? <span className="wf-line" /> : null}
      </span>
      <span className="wf-step-body">
        <span className="wf-step-text">{step.text}</span>
        <span className="wf-step-status">{meta.label}</span>
      </span>
    </li>
  );
}

function ToolFeed({ tools }) {
  const [open, setOpen] = useState(false);
  if (tools.length === 0) return null;
  const shown = open ? tools : tools.slice(-3);
  return (
    <div className="wf-tools">
      <div className="wf-tools-title">工具流水</div>
      <ul className="wf-tools-list">
        {shown.map((t, i) => (
          <li key={t.id ?? i} className={`wf-tool ${t.isError ? "err" : ""}`}>
            <span className={`wf-tool-dot ${t.running ? "run" : t.isError ? "fail" : "ok"}`} />
            <span className="wf-tool-name">{t.name}</span>
            <span className="wf-tool-state">{t.running ? "运行中" : t.isError ? "失败" : "完成"}</span>
          </li>
        ))}
      </ul>
      {tools.length > 3 ? (
        <button className="wf-tools-more" onClick={() => setOpen((v) => !v)}>
          {open ? "收起" : `展开全部 ${tools.length} 项`}
        </button>
      ) : null}
    </div>
  );
}

/** 工作流面板：由 todo_write 计划 + 本回合工具流水组成（ZCode 式步骤流） */
export default function WorkflowPanel({ tasks, tools = [] }) {
  const [collapsed, setCollapsed] = useState(false);
  const list = Array.isArray(tasks) ? tasks : [];
  const toolList = Array.isArray(tools) ? tools : [];
  if (list.length === 0 && toolList.length === 0) return null;

  const done = list.filter((t) => t.status === "completed").length;
  const runningStep = list.find((t) => t.status === "in_progress");
  const allDone = list.length > 0 && done === list.length;
  const anyToolRunning = toolList.some((t) => t.running);

  return (
    <div className={`wf-panel ${collapsed ? "collapsed" : ""}`}>
      <button className="wf-head" onClick={() => setCollapsed((v) => !v)}>
        <span className="wf-badge">{allDone && !anyToolRunning ? "DONE" : "WORKFLOW"}</span>
        <span className="wf-title">工作流</span>
        {list.length > 0 ? (
          <span className="wf-prog">{done}/{list.length}</span>
        ) : null}
        {runningStep ? <span className="wf-now">执行中：{String(runningStep.text).slice(0, 24)}</span> : null}
        <span className={`wf-chev ${collapsed ? "" : "up"}`}>▾</span>
      </button>
      {!collapsed ? (
        <div className="wf-body">
          {list.length > 0 ? (
            <>
              <div className="wf-bar"><div className="wf-bar-fill" style={{ width: `${(done / list.length) * 100}%` }} /></div>
              <ol className="wf-steps">
                {list.map((t, i) => (
                  <StepRow key={t.id ?? i} step={t} index={i} last={i === list.length - 1} />
                ))}
              </ol>
            </>
          ) : null}
          <ToolFeed tools={toolList} />
        </div>
      ) : null}
    </div>
  );
}
