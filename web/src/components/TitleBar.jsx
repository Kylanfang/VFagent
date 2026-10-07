import React, { useEffect, useState } from "react";

// 品牌 logo：直接使用用户提供的原始 PNG（web/public/vf-logo.png，运行时打包到 /vf-logo.png）
// 与 brand/logo-2048.png / brand/icon.ico / favicon 完全同源
function LogoSVG({ size = 16 }) {
  return (
    <img
      src="/vf-logo.png"
      alt="V-Fletch"
      width={size}
      height={size}
      style={{ display: "block", borderRadius: "50%" }}
      draggable={false}
    />
  );
}

export default function TitleBar({ user, onLogout, uiVersion, updateAvailable }) {
  const desktop = window.vfDesktop;
  const [maxed, setMaxed] = useState(false);
  useEffect(() => {
    if (!desktop?.onMaxState) return undefined;
    return desktop.onMaxState(setMaxed); // 返回取消订阅函数，随组件卸载清理
  }, [desktop]);
  return (
    <div className="titlebar">
      <div className="titlebar-brand">
        <LogoSVG size={20} />
        <span className="brand-name">V‑Fletch</span>
        <span className="brand-tag">Office Intelligence</span>
      </div>
      <div className="titlebar-drag" onDoubleClick={() => desktop?.toggleMaximize()} title="双击最大化/还原" />
      {user ? (
        <div className="titlebar-user">
          <span className={`role-chip ${user.role !== "employee" ? "role-boss" : ""}`}>
            {(() => {
              const roleLabel = user.role === "boss" ? "管理员账号" : user.role === "observer" ? "管理员" : "成员";
              const displayName = user.display_name ?? user.username;
              // 角色名与显示名相同时只显示一个，避免"管理员账号 · 管理员账号"
              return roleLabel === displayName ? roleLabel : `${roleLabel} · ${displayName}`;
            })()}
          </span>
          <button
            className={`tb-btn ${updateAvailable ? "tb-update" : ""}`}
            onClick={() => window.location.reload()}
            title={updateAvailable ? "检测到新版本，点击刷新" : "重新载入（获取最新界面版本）"}
          >
            {updateAvailable ? (
              <>
                <span className="tb-update-dot" />
                刷新
              </>
            ) : (
              <svg viewBox="0 0 12 12" width="12" height="12"><path d="M10.5 6a4.5 4.5 0 11-1.3-3.2M10.5 1.5v2.8H7.7" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" /></svg>
            )}
          </button>
          {uiVersion ? <span className="tb-version" title={`构建 ${uiVersion.build} · ${uiVersion.builtAt}`}>v{uiVersion.version}</span> : null}
          <button className="tb-btn" onClick={onLogout} title="退出登录">
            <svg viewBox="0 0 12 12" width="12" height="12"><path d="M5 2H2.8v7.2H5M7.5 4l2 2-2 2M4.2 6h5.3" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </div>
      ) : null}
      {desktop ? (
        <div className="titlebar-controls">
          <button className="tb-btn" onClick={() => desktop.minimize()} title="最小化">
            <svg viewBox="0 0 12 12" width="12" height="12"><path d="M2 6h8" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
          <button className="tb-btn" onClick={() => desktop.toggleMaximize()} title={maxed ? "还原" : "最大化"}>
            {maxed ? (
              <svg viewBox="0 0 12 12" width="12" height="12"><rect x="2" y="4" width="6" height="6" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M4 4V2h6v6H8" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
            ) : (
              <svg viewBox="0 0 12 12" width="12" height="12"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" /></svg>
            )}
          </button>
          <button className="tb-btn close" onClick={() => desktop.close()} title="关闭">
            <svg viewBox="0 0 12 12" width="12" height="12"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.2" /></svg>
          </button>
        </div>
      ) : null}
    </div>
  );
}
