import React, { useCallback, useEffect, useState } from "react";
import TitleBar from "./components/TitleBar.jsx";
import ChatView from "./components/ChatView.jsx";
import AuditView from "./components/AuditView.jsx";
import McpView from "./components/McpView.jsx";
import SettingsView from "./components/SettingsView.jsx";
import RmsView from "./components/RmsView.jsx";
import AigcView from "./components/AigcView.jsx";
import KbView from "./components/KbView.jsx";
import TeamView from "./components/TeamView.jsx";
import StaffView from "./components/StaffView.jsx";
import LoginView from "./components/LoginView.jsx";
import { getHealth, getModels, getMcp, getUsage, authUser, clearAuth, authMe, saveAuth, authToken } from "./lib/api.js";

const NAV = [
  { id: "chat", label: "对话", icon: "M4 5h16v11H8l-4 4z" },
  { id: "audit", label: "审计", icon: "M12 3l9 4v5c0 5-4 8-9 9-5-1-9-4-9-9V7z" },
  { id: "rms", label: "监管", icon: "M12 3l8 3v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z M9.5 12l2 2 3.5-3.5" },
  { id: "aigc", label: "AI 监测", icon: "M3 12h3l2-7 4 14 2-7h7 M14 6a2 2 0 100 4 2 2 0 000-4" },
  { id: "org", label: "组织", icon: "M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.9" },
  { id: "kb", label: "知识库", icon: "M4 19V5a2 2 0 012-2h13v16H6a2 2 0 000 4h13M8 7h7M8 11h5" },
  { id: "staff", label: "成员", icon: "M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M8 11a4 4 0 100-8 4 4 0 000 8zM20 8v6M23 11h-6" },
  { id: "mcp", label: "MCP", icon: "M5 12h4l2-6 3 12 2-6h3" },
  { id: "settings", label: "设置", icon: "M12 8a4 4 0 100 8 4 4 0 000-8zM3 12h2m14 0h2M12 3v2m0 14v2" },
];

function mcpIssueSignature(items) {
  const text = items.map((c) => `${c.severity}|${c.message}`).join(String.fromCharCode(10)).replace(/\s+/g, " ");
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `a${(h >>> 0).toString(36)}`;
}
function mcpDismissedHas(sig) {
  try {
    return new Set(JSON.parse(localStorage.getItem("vfletch.dismissedAlerts") ?? "[]")).has(sig);
  } catch {
    return false;
  }
}

export default function App() {
  const [tab, setTab] = useState("chat");
  const [health, setHealth] = useState(null);
  const [models, setModels] = useState(null);
  const [mcp, setMcp] = useState(null);
  const [usage, setUsage] = useState(null);
  const [user, setUser] = useState(() => authUser());
  const [uiVersion, setUiVersion] = useState(null); // 当前运行的 UI 版本戳
  const [updateAvailable, setUpdateAvailable] = useState(false); // 检测到比当前更新的界面版本

  // 版本与更新检测：启动读取 version.json；每 60s 带 cache-buster 重取，
  // build id 变化即代表本地前端已重新构建 → 顶栏亮「刷新」，点击重载即拉取最新 UI。
  useEffect(() => {
    let stopped = false;
    const check = async (bust) => {
      try {
        const r = await fetch(`/version.json${bust ? `?_=${Date.now()}` : ""}`, { cache: "no-store" });
        if (!r.ok) return;
        const v = await r.json();
        if (stopped || !v?.build) return;
        setUiVersion((prev) => {
          if (prev == null) return v;
          if (prev.build !== v.build) setUpdateAvailable(true);
          return prev;
        });
      } catch {}
    };
    check(false);
    const timer = setInterval(() => { if (!document.hidden) check(true); }, 60000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);

  // 会话失效（401）→ 回登录页
  useEffect(() => {
    const handler = () => setUser(null);
    window.addEventListener("vfletch:unauthorized", handler);
    return () => window.removeEventListener("vfletch:unauthorized", handler);
  }, []);

  const isStaff = user?.role === "boss" || user?.role === "observer"; // 管理员与被授权观察员共享监管视图
  // 成员可见：对话/审计（分权编辑：本人与本部门可直接改，其余提交主控审批）/组织/知识库
  const visibleNav = NAV.filter((item) => isStaff || item.id === "chat" || item.id === "audit" || item.id === "org" || item.id === "kb");

  const refreshBackend = useCallback(async () => {
    try {
      setHealth(await getHealth());
    } catch {
      setHealth({ ok: false });
    }
    // 同步账号资料（角色/部门被主控改动后无需重新登录即生效）
    try {
      const me = await authMe();
      if (me?.user) {
        setUser((prev) => {
          if (prev && JSON.stringify(prev) === JSON.stringify(me.user)) return prev;
          saveAuth({ token: authToken(), user: me.user });
          return me.user;
        });
      }
    } catch {}
    try {
      setModels(await getModels());
    } catch {
      setModels({ providers: [] });
    }
    try {
      setMcp(await getMcp());
    } catch {
      setMcp(null);
    }
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      setUsage(await getUsage());
    } catch {
      setUsage(null);
    }
  }, []);

  useEffect(() => {
    // 登录后才轮询后端（/api/models 等现需鉴权）；轮询本身也充当在线心跳（服务端按令牌刷新 last_seen）；
    // 页面隐藏时跳过（后台标签页不打 API，回前台下一个 tick 自动恢复）
    if (!user) return undefined;
    refreshBackend();
    const timer = setInterval(() => { if (!document.hidden) refreshBackend(); }, 15000);
    return () => clearInterval(timer);
  }, [refreshBackend, user]);

  useEffect(() => {
    if (tab === "settings") refreshUsage();
  }, [tab, refreshUsage]);

  const mcpConnected = mcp?.servers?.filter((s) => s.status === "connected").length ?? 0;
  const mcpTotal = mcp?.servers?.length ?? 0;
  // MCP 红点（微信式）：error 级冲突 + 连接失败的 server 才计；打开 MCP 页即标记已读，
  // 问题内容不变就不再提醒，变了会生成新签名重新提醒
  const mcpIssueItems = [
    ...(mcp?.conflicts ?? []).filter((c) => c.severity === "error"),
    ...(mcp?.servers ?? []).filter((s) => s.status === "error").map((s) => ({ severity: "error", message: `MCP ${s.id} 连接失败：${s.error ?? "未知原因"}` })),
  ];
  const mcpIssueSig = mcpIssueItems.length > 0 ? mcpIssueSignature(mcpIssueItems) : null;
  const [mcpSeenSig, setMcpSeenSig] = useState(null);
  useEffect(() => {
    if (tab === "mcp" && mcpIssueSig != null) {
      setMcpSeenSig(mcpIssueSig);
      try {
        const key = "vfletch.dismissedAlerts";
        const set = new Set(JSON.parse(localStorage.getItem(key) ?? "[]"));
        set.add(mcpIssueSig);
        localStorage.setItem(key, JSON.stringify([...set].slice(-50)));
      } catch {}
    }
  }, [tab, mcpIssueSig]);
  const mcpBadge = mcpIssueSig != null && mcpSeenSig !== mcpIssueSig && !mcpDismissedHas(mcpIssueSig) ? mcpIssueItems.length : 0;

  if (!user) return <LoginView onLogin={setUser} uiVersion={uiVersion} updateAvailable={updateAvailable} />;

  const doLogout = () => {
    import("./lib/api.js").then(({ logout }) => logout());
    clearAuth();
    setUser(null);
  };

  return (
    <div className="app">
      <TitleBar user={user} onLogout={doLogout} uiVersion={uiVersion} updateAvailable={updateAvailable} />
      <div className="app-body">
        <nav className="rail">
          <div className="logo" title="V-Fletch">
            <img
              src="/vf-logo.png"
              alt="V-Fletch"
              width={32}
              height={32}
              style={{ display: "block", borderRadius: "50%" }}
              draggable={false}
            />
          </div>
          {visibleNav.map((item) => (
            <button
              key={item.id}
              className={`rail-btn ${tab === item.id ? "active" : ""}`}
              onClick={() => setTab(item.id)}
              title={item.label}
              aria-label={item.label}
            >
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={item.icon} />
              </svg>
              {item.id === "mcp" && mcpBadge > 0 ? <span className="rail-badge">{mcpBadge}</span> : null}
            </button>
          ))}
          <div className="rail-spacer" />
          <div className="rail-status" title={health?.ok ? `后端正常 · ${mcpConnected}/${mcpTotal} MCP 在线` : "后端离线"}>
            <span className={`dot ${health?.ok ? "ok" : "bad"}`} />
          </div>
        </nav>

        <main className="content">
          {/* 对话页常驻挂载（切页只隐藏不卸载）：流式更新与运行状态跨标签页保留，避免中途切页导致内容截断 */}
          <div className={`chat-mount ${tab === "chat" ? "" : "is-hidden"}`}>
            <ChatView
              key={user.id}
              userId={user.id}
              models={models}
              mcp={mcp}
              role={user.role}
              onOpenMcp={() => setTab("mcp")}
              onOpenSettings={() => setTab("settings")}
            />
          </div>
          {tab === "org" && <TeamView user={user} />}
          {tab === "kb" && <KbView user={user} />}
          {tab === "staff" && isStaff && <StaffView user={user} />}
          {tab === "audit" && <AuditView user={user} />}
          {tab === "rms" && <RmsView />}
          {tab === "aigc" && isStaff && <AigcView />}
          {tab === "mcp" && <McpView mcp={mcp} onRefresh={refreshBackend} user={user} />}
          {tab === "settings" && <SettingsView usage={usage} onRefreshUsage={refreshUsage} mcp={mcp} onRefreshBackend={refreshBackend} user={user} />}
        </main>
      </div>
    </div>
  );
}
