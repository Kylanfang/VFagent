import React, { useEffect, useState } from "react";
import { getAigcOverview, aigcRescan } from "../lib/api.js";
import { StatCard, Sparkline, ShareBars } from "./ui.jsx";

/**
 * AI 生成内容实时监测：生成率 + 幻觉率
 * - AI 生成率：用户输入与工作区文本文件的统计特征评分（助手输出按定义计 AI 生成）
 * - 幻觉率：AI 结论中的数值主张在会话证据（工具返回/用户输入）中的溯源命中率
 */
export default function AigcView() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => getAigcOverview().then(setData).catch((e) => setError(String(e?.message ?? e)));
  useEffect(() => {
    load();
    const t = setInterval(load, 15000); // 实时刷新
    return () => clearInterval(t);
  }, []);

  if (error) return <div className="view-pad"><div className="msg-error">监测数据加载失败：{error}</div></div>;
  if (!data) return <div className="view-pad"><div className="chart-empty">加载中…</div></div>;

  const t = data.totals ?? {};
  const rescan = async () => {
    setBusy(true);
    try {
      const r = await aigcRescan();
      setData(r.overview);
    } catch (e) {
      window.alert(String(e?.message ?? e));
    }
    setBusy(false);
  };

/** 告警摘录去掉 Markdown 记号（###、**、`），界面直接读句子 */
function stripMd(text, max = 90) {
  const t = String(text ?? "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

  const aiTrend = (data.trend ?? []).filter((x) => x.hour).map((x) => ({ label: x.hour.slice(11), value: Math.round((x.ai ?? 0) * 100) }));
  const hallTrend = (data.trend ?? []).filter((x) => x.hour && x.hall != null).map((x) => ({ label: x.hour.slice(11), value: Math.round((x.hall ?? 0) * 100) }));
  const subjectBars = (data.bySubject ?? []).slice(0, 8).map((s) => ({ label: s.subject, value: s.monitored }));

  return (
    <div className="view-pad">
      <header className="view-head">
        <h2 className="view-title">AI 生成监测</h2>
        <span className="view-sub">生成率 · 幻觉率 · 实时增量扫描（30s）</span>
        <div className="spacer" />
        <button className="ghost-btn" onClick={rescan} disabled={busy}>{busy ? "扫描中…" : "立即扫描"}</button>
      </header>

      <div className="kpi-row">
        <StatCard label="AI 生成率" value={t.aiRate != null ? (t.aiRate * 100).toFixed(1) : "—"} unit="%" tone="warn" hint="用户输入与文件的统计特征评分均值" />
        <StatCard label="数值无依据率（幻觉率·数值口径）" value={t.hallucinationRate ?? "—"} unit="%" tone="high" hint="无依据数值主张 ÷ 全部数值主张" />
        <StatCard label="已监测内容" value={String(t.events ?? 0)} unit="项" hint={`含对话 ${t.events - (t.checked ?? 0)} 条 / 输入与文件 ${t.checked ?? 0} 项`} />
        <StatCard label="待复核结论" value={String(t.needReview ?? 0)} unit="条" tone="ok" hint="数值主张过半无依据的 AI 回复" />
      </div>

      <div className="grid-2">
        <section className="card">
          <h3>AI 生成率趋势 <small className="dim">（近 24 小时 · %）</small></h3>
          {aiTrend.length > 1 ? <Sparkline data={aiTrend} width={440} height={90} /> : <div className="chart-empty">样本不足</div>}
        </section>
        <section className="card">
          <h3>数值无依据率趋势 <small className="dim">（近 24 小时 · %）</small></h3>
          {hallTrend.length > 1 ? <Sparkline data={hallTrend} width={440} height={90} /> : <div className="chart-empty">暂无含数值主张的结论</div>}
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <h3>按 AI 员工分布（数值主张口径）</h3>
          <div className="table-wrap">
            <table className="entity-table">
              <thead><tr><th>员工 / 来源</th><th>监测条数</th><th>生成率</th><th>数值主张</th><th>无依据</th><th>幻觉率</th></tr></thead>
              <tbody>
                {(data.bySubject ?? []).map((s) => {
                  const hall = s.claims > 0 ? Math.round((s.ungrounded / s.claims) * 1000) / 10 : null;
                  return (
                    <tr key={s.subject}>
                      <td style={{ fontWeight: 600 }}>{s.subject}</td>
                      <td>{s.monitored}</td>
                      <td>{s.ai_rate != null ? `${Math.round(s.ai_rate * 100)}%` : "—"}</td>
                      <td>{s.claims ?? 0}</td>
                      <td>{s.ungrounded ?? 0}</td>
                      <td>{hall != null ? <span className={`pill ${hall >= 40 ? "pill-bad" : hall >= 20 ? "" : "pill-ok"}`}>{hall}%</span> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
        <section className="card">
          <h3>待复核告警 <small className="dim">（数值主张过半无依据）</small></h3>
          <div className="alert-list">
            {(data.alerts ?? []).length === 0 ? <div className="chart-empty">暂无告警</div> : null}
            {(data.alerts ?? []).map((a, i) => (
              <div key={i} className="alert-row">
                <span className="dot bad" />
                <div className="alert-main">
                  <div className="alert-title">{a.subject} · {a.ungrounded}/{a.claims} 项主张无依据</div>
                  <div className="alert-sub">{stripMd(a.detail?.excerpt, 90)}</div>
                  {(a.detail?.examples ?? []).slice(0, 2).map((ex, j) => (
                    <div key={j} className="alert-sub" style={{ color: "#b3372c" }}>疑无依据：{ex.claim} —— {ex.context}</div>
                  ))}
                </div>
                <span className="pill">{a.created_at?.slice(5, 16)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <h3>检测口径说明</h3>
        <div className="kv-table">
          <div className="kv-row"><span className="kv-key">AI 生成率</span><span className="kv-val">{data.method?.aiLikeness}</span></div>
          <div className="kv-row"><span className="kv-key">幻觉率</span><span className="kv-val">{data.method?.hallucination}</span></div>
          <div className="kv-row"><span className="kv-key">监测范围</span><span className="kv-val">V-Fletch 全部会话消息（用户输入 + AI 回复）与工作区文本文件（md/txt/csv/json 等）</span></div>
        </div>
      </section>
    </div>
  );
}
