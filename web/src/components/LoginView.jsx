import React, { useState } from "react";
import { login, saveAuth, getMeta } from "../lib/api.js";

/** 登录页：本机账号（管理员=全景监管；员工=办公对话）。
 *  首次启动自动创建管理员账号（用户名 central），初始密码见启动日志。
 *  服务在本地托管页面，无需依赖任何远端。 */
export default function LoginView({ onLogin, uiVersion, updateAvailable }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [meta, setMeta] = useState(null);

  React.useEffect(() => {
    getMeta().then(setMeta).catch((e) => console.warn("[load]", String(e?.message ?? e)));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (busy || username.trim() === "" || password === "") return;
    setBusy(true);
    setError("");
    try {
      const result = await login(username.trim(), password);
      saveAuth(result);
      onLogin(result.user);
    } catch (err) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">
          <img src="/vf-logo.png" alt="" width={44} height={44} draggable={false} />
        </div>
        <h1>V-Fletch 办公体</h1>
        <p className="login-sub">企业账号登录 · 共用一个大脑，按人分账监管</p>
        <label>
          用户名
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            placeholder="如 boss / 工号"
            autoFocus
          />
        </label>
        <label>
          密码
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            placeholder="••••••••"
          />
        </label>
        {error ? <div className="msg-error">{error}</div> : null}
        <button className="login-btn" type="submit" disabled={busy || username.trim() === "" || password === ""}>
          {busy ? "登录中…" : "登 录"}
        </button>
        <div className="login-foot">
          {meta ? <span>v{meta.version} · 本地服务在线</span> : <span>连接服务…</span>}
          {uiVersion ? <span> · 界面 v{uiVersion.version}</span> : null}
        </div>
        {updateAvailable ? (
          <button
            type="button"
            className="login-update-btn"
            onClick={() => window.location.reload()}
            title="检测到新版本，点击刷新获取"
          >
            🔄 刷新到新版本
          </button>
        ) : null}
      </form>
    </div>
  );
}
