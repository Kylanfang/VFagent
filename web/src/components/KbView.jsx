import React, { useCallback, useEffect, useState } from "react";
import { kbList, kbCreate, kbUpdate, kbDelete, kbArchive, kbRestore, kbPurge } from "../lib/api.js";

/**
 * 企业共享知识库（全员可读；管理员可发布维护）。
 * 当前为空库筹备阶段：空态引导 + 完整 CRUD 能力已实装（发布即可见、agent 可检索）。
 */
export default function KbView({ user }) {
  const [docs, setDocs] = useState(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(null); // {id?, title, content, tags}
  const [notice, setNotice] = useState("");
  const [openDoc, setOpenDoc] = useState(null);

  const canEdit = user?.role === "boss" || user?.role === "observer";
  // 回收站（主控/管理员）：归档 = 一级删除（可恢复）；彻底删除 = 二级删除（需二次确认，不可恢复）
  const [showTrash, setShowTrash] = useState(false);
  const [trash, setTrash] = useState([]);
  const loadTrash = useCallback(async () => {
    if (!canEdit) return;
    try { const r = await kbArchive(); setTrash(r?.docs ?? []); } catch { setTrash([]); }
  }, [canEdit]);
  useEffect(() => { loadTrash(); }, [loadTrash]);
  const restore = async (d) => {
    try { await kbRestore(d.id); flash(`已恢复「${d.title}」`); await Promise.all([load(), loadTrash()]); } catch (e) { flash(String(e?.message ?? e)); }
  };
  const purge = async (d) => {
    if (!window.confirm(`彻底删除「${d.title}」？`)) return;
    if (!window.confirm("再次确认：彻底删除后无法恢复（这是第二级删除）。确定继续？")) return;
    try { await kbPurge(d.id); flash(`已彻底删除「${d.title}」`); await loadTrash(); } catch (e) { flash(String(e?.message ?? e)); }
  };

  const load = useCallback(async () => {
    try {
      const r = await kbList();
      setDocs(r?.docs ?? []);
    } catch (e) {
      setDocs([]);
      setNotice(String(e?.message ?? e));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const flash = (m) => { setNotice(m); setTimeout(() => setNotice(""), 3500); };

  const save = async () => {
    if (!editing?.title?.trim()) { flash("标题不能为空"); return; }
    try {
      const payload = { title: editing.title.trim(), content: editing.content ?? "", tags: editing.tags ?? [] };
      if (editing.id) await kbUpdate(editing.id, payload);
      else {
        const r = await kbCreate(payload);
        flash(r?.status === "pending" ? "已提交，待主控/管理员审核（可在列表中查看进度）" : "已发布到知识库");
      }
      setEditing(null);
      await load();
    } catch (e) {
      flash(String(e?.message ?? e));
    }
  };
  const approve = async (id) => {
    try { await kbUpdate(id, { approve: true }); flash("已通过并发布"); await load(); } catch (e) { flash(String(e?.message ?? e)); }
  };
  const reject = async (id) => {
    if (!window.confirm("拒绝并退回该投稿？")) return;
    try { await kbDelete(id); flash("已退回"); await load(); } catch (e) { flash(String(e?.message ?? e)); }
  };

  const remove = async (id) => {
    if (!window.confirm("确认归档该文档？")) return;
    try { await kbDelete(id); flash("已归档（可在回收站恢复或彻底删除）"); await Promise.all([load(), loadTrash()]); } catch (e) { flash(String(e?.message ?? e)); }
  };

  // 列表口径：已发布全员可见；待审核仅主控/管理员（队列展示）与投稿人自己（进度）可见
  const base = (docs ?? []).filter((d) => d.status === "active" || (d.status === "pending" && (canEdit || d.mine)));
  const filtered = base.filter((d) =>
    query.trim() === "" ||
    d.title.includes(query.trim()) ||
    String(d.content ?? "").includes(query.trim()) ||
    (d.tags ?? []).some((t) => String(t).includes(query.trim())),
  );

  return (
    <div className="view-pad">
      <header className="view-head">
        <h2 className="view-title">企业共享知识库</h2>
        <span className="view-sub">全员共享 · 制度 / 规范 / 项目资料 · AI 可直接检索引用</span>
        <div className="spacer" />
        {canEdit ? (
          <button className={`ghost-btn ${showTrash ? "on" : ""}`} onClick={() => { setShowTrash((v) => !v); loadTrash(); }} title="已归档（一级删除）的文档在这里，可恢复或彻底删除">
            🗑 回收站{trash.length > 0 ? `（${trash.length}）` : ""}
          </button>
        ) : null}
        <button className="ghost-btn" onClick={() => setEditing({ title: "", content: "", tags: [] })}>{canEdit ? "+ 发布文档" : "+ 投稿到知识库"}</button>
      </header>
      {notice ? <div className="msg-error" style={{ marginBottom: 10 }}>{notice}</div> : null}
      {showTrash && canEdit ? (
        <section className="card" style={{ marginBottom: 12 }}>
          <h3>回收站（{trash.length}）<small className="dim">归档的文档不再被 AI 检索；恢复后重新发布，彻底删除需二次确认且不可恢复</small></h3>
          {trash.length === 0 ? <div className="chart-empty">回收站是空的</div> : trash.map((d) => (
            <div key={d.id} className="conflict-row" style={{ alignItems: "center" }}>
              <span className="pill">已归档</span>
              <div className="conflict-msg"><strong>{d.title}</strong> · {d.created_by} · {String(d.updated_at ?? "").slice(0, 16)}</div>
              <span style={{ whiteSpace: "nowrap" }}>
                <button className="ghost-btn tiny" onClick={() => restore(d)}>恢复</button>{" "}
                <button className="ghost-btn tiny" style={{ color: "#c62828", borderColor: "rgba(198,40,40,.4)" }} onClick={() => purge(d)}>彻底删除</button>
              </span>
            </div>
          ))}
        </section>
      ) : null}

      {(docs ?? []).length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <input
            className="kb-search"
            placeholder="搜索标题 / 内容 / 标签…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}

      {docs == null ? (
        <div className="chart-empty">加载中…</div>
      ) : docs.length === 0 ? (
        <section className="card kb-empty">
          <div className="kb-empty-icon">📚</div>
          <h3>知识库正在筹备中</h3>
          <p className="dim">
            这里将存放企业共享的制度、规范与项目资料，全体成员可见；<br />
            发布后 AI 办公体回答问题时会自动检索引用这里的资料。
          </p>
          <button className="ghost-btn" onClick={() => setEditing({ title: "", content: "", tags: [] })}>{canEdit ? "发布第一篇文档" : "投稿第一篇文档"}</button>
        </section>
      ) : filtered.length === 0 ? (
        <div className="chart-empty">没有匹配「{query}」的文档</div>
      ) : (
        <>
        {(canEdit ? (docs ?? []).filter((d) => d.status === "pending") : []).length > 0 ? (
          <section className="card" style={{ marginBottom: 12 }}>
            <h3>待审核投稿（{(docs ?? []).filter((d) => d.status === "pending").length}）</h3>
            {(docs ?? []).filter((d) => d.status === "pending").map((d) => (
              <div key={d.id} className="conflict-row" style={{ alignItems: "flex-start" }}>
                <span className="pill">待审核</span>
                <div className="conflict-msg"><strong>{d.title}</strong> · 投稿人 {d.created_by}{d.content ? ` · ${String(d.content).slice(0, 60)}` : ""}</div>
                <span style={{ whiteSpace: "nowrap" }}>
                  <button className="ghost-btn tiny" onClick={() => approve(d.id)}>通过</button>{" "}
                  <button className="ghost-btn tiny" onClick={() => reject(d.id)}>拒绝</button>
                </span>
              </div>
            ))}
          </section>
        ) : null}
        <div className="kb-grid">
          {filtered.map((d) => (
            <section key={d.id} className="card kb-doc" onClick={() => setOpenDoc(openDoc === d.id ? null : d.id)}>
              <div className="kb-doc-head">
                <h3 style={{ margin: 0 }}>{d.title}</h3>
                <span className="dim small">{(d.updated_at ?? "").slice(0, 10)}</span>
              </div>
              {(d.tags ?? []).length > 0 ? (
                <div className="kb-tags">
                  {d.tags.map((t, i) => <span key={i} className="kb-tag">{t}</span>)}
                </div>
              ) : null}
              {openDoc === d.id ? (
                <pre className="kb-content">{d.content || "（无正文）"}</pre>
              ) : (
                <p className="dim kb-excerpt">{String(d.content || "（无正文）").slice(0, 120)}{String(d.content ?? "").length > 120 ? "…" : ""}</p>
              )}
              <div className="kb-doc-foot">
                <span className="dim small">发布人：{d.created_by ?? "—"}</span>
                <span onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6 }}>
                  {d.status === "pending" && d.mine ? (
                    <>
                      <span className="pill">待主控审核</span>
                      <button className="ghost-btn tiny" onClick={() => remove(d.id)}>撤回</button>
                    </>
                  ) : canEdit ? (
                    <>
                      <button className="ghost-btn tiny" onClick={() => setEditing({ id: d.id, title: d.title, content: d.content, tags: d.tags ?? [] })}>编辑</button>
                      <button className="ghost-btn tiny" onClick={() => remove(d.id)}>归档</button>
                    </>
                  ) : null}
                </span>
              </div>
            </section>
          ))}
        </div>
        </>
      )}

      {editing ? (
        <div className="modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditing(null); }}>
          <div className="modal-body">
            <h3 style={{ margin: "0 0 12px" }}>{editing.id ? "编辑文档" : "发布到知识库"}</h3>
            <label className="record-field" style={{ marginBottom: 10 }}>
              <span className="record-key">标题 *</span>
              <input value={editing.title} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="如：报销制度 V3" />
            </label>
            <label className="record-field" style={{ marginBottom: 10 }}>
              <span className="record-key">正文（支持长文本）</span>
              <textarea rows={9} value={editing.content} onChange={(e) => setEditing({ ...editing, content: e.target.value })} placeholder="制度正文 / 规范条款 / 项目说明…" />
            </label>
            <label className="record-field">
              <span className="record-key">标签（逗号分隔，最多 8 个）</span>
              <input value={(editing.tags ?? []).join(",")} onChange={(e) => setEditing({ ...editing, tags: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 8) })} placeholder="财务,制度" />
            </label>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
              <button className="ghost-btn" onClick={() => setEditing(null)}>取消</button>
              <button className="ghost-btn primary" onClick={save}>保存</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
