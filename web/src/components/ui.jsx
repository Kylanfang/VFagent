// 轻量 SVG 图表组件（零依赖，深色主题）
import React from "react";

export function StatCard({ label, value, unit, tone = "default", hint }) {
  return (
    <div className={`stat-card tone-${tone}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit ? <span className="stat-unit">{unit}</span> : null}
      </div>
      {hint ? <div className="stat-hint">{hint}</div> : null}
    </div>
  );
}

/** 环形状态：已连接/总数 */
export function StatusRing({ value, total, size = 120, label }) {
  const ratio = total > 0 ? value / total : 0;
  const r = (size - 14) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="status-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth="8" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${c * ratio} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dasharray .6s ease" }}
        />
      </svg>
      <div className="ring-center">
        <div className="ring-value">
          {value}
          <span>/{total}</span>
        </div>
        <div className="ring-label">{label}</div>
      </div>
    </div>
  );
}

/** 柱状图（30 天用量） */
export function Bars({ data, height = 120, format }) {
  if (!data || data.length === 0) return <div className="chart-empty">暂无数据</div>;
  const max = Math.max(...data.map((d) => d.value), 1);
  const bw = Math.min(100 / data.length, 10); // 天数少时限制单柱槽宽，避免一根柱子撑满
  return (
    <svg className="bars" viewBox={`0 0 100 ${height}`} preserveAspectRatio="none">
      {data.map((d, i) => {
        const h = Math.max(2, (d.value / max) * (height - 22));
        return (
          <g key={i}>
            <rect x={i * bw + bw * 0.18} y={height - h - 16} width={bw * 0.64} height={h} rx="1.5" fill="var(--accent)" opacity="0.85" />
            <text x={i * bw + bw / 2} y={height - 4} fontSize="7" fill="var(--text-dim)" textAnchor="middle">
              {d.label}
            </text>
            <title>{`${d.label}: ${format ? format(d.value) : d.value}`}</title>
          </g>
        );
      })}
    </svg>
  );
}

/** 水平占比条（供应商分布） */
export function ShareBars({ items, format }) {
  if (!items || items.length === 0) return <div className="chart-empty">暂无数据</div>;
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="share-bars">
      {items.map((item) => (
        <div key={item.label} className="share-row">
          <div className="share-name">{item.label}</div>
          <div className="share-track">
            <div className="share-fill" style={{ width: `${(item.value / max) * 100}%` }} />
          </div>
          <div className="share-value">{format ? format(item.value) : item.value}</div>
        </div>
      ))}
    </div>
  );
}

/** 风险热力格 */
export function HeatGrid({ cells, dimensions }) {
  if (!cells || cells.length === 0) return <div className="chart-empty">暂无数据</div>;
  const rows = [...new Set(cells.map((c) => c.rowLabel))];
  const cols = dimensions?.map((d) => d.name) ?? [...new Set(cells.map((c) => c.colLabel))];
  const color = (score) => {
    if (score >= 80) return "var(--risk-high)";
    if (score >= 65) return "var(--risk-medium)";
    return "var(--risk-low)";
  };
  return (
    <div className="heat-grid" style={{ gridTemplateColumns: `80px repeat(${cols.length}, 1fr)` }}>
      <div />
      {cols.map((c) => (
        <div key={c} className="heat-col-label">
          {c}
        </div>
      ))}
      {rows.map((r) => (
        <React.Fragment key={r}>
          <div className="heat-row-label">{r}</div>
          {cols.map((c) => {
            const cell = cells.find((x) => x.rowLabel === r && x.colLabel === c);
            return (
              <div
                key={`${r}-${c}`}
                className={`heat-cell ${cell ? "" : "empty"}`}
                style={cell ? { background: color(cell.riskScore), opacity: 0.35 + (cell.riskScore / 100) * 0.65 } : undefined}
                title={cell ? `${r} × ${c}：分数 ${cell.riskScore}，风险 ${cell.riskCount}，趋势 ${cell.trend}` : "无数据"}
              >
                {cell ? cell.riskScore : ""}
              </div>
            );
          })}
        </React.Fragment>
      ))}
    </div>
  );
}

/** 迷你趋势线 */
export function Sparkline({ data, width = 220, height = 48 }) {
  if (!data || data.length < 2) return <div className="chart-empty">暂无趋势</div>;
  const max = Math.max(...data.map((d) => d.value), 1);
  const min = Math.min(...data.map((d) => d.value));
  const span = max - min || 1;
  const points = data
    .map((d, i) => `${(i / (data.length - 1)) * width},${height - 6 - ((d.value - min) / span) * (height - 12)}`)
    .join(" ");
  return (
    <svg width={width} height={height} className="sparkline">
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
