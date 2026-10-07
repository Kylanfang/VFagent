import React from "react";

// 零依赖 SVG 图表：柱状 / 折线 / 饼图 / 热力图
// 数据契约（模型在 ```chart 代码块里输出）：
// {"type":"bar|line|pie|heatmap","title":"...","unit":"万元","labels":["A","B"],"datasets":[{"label":"本期","data":[1,2]}]}
// heatmap：labels 为列（维度），datasets 每组为一行（部门/主体），data 与列对齐；
// 可选 "scale":[0,100] 指定色阶范围（缺省用数据自身 min/max），颜色绿→琥珀→红。
const PALETTE = ["#0d3a6b", "#1f5c8b", "#4f8fd9", "#b8860b", "#1f8a5f", "#b3372c", "#8fb8dd", "#6b7688"];

const W = 640;
const H = 320;
const PAD = { left: 58, right: 18, top: 30, bottom: 46 };

function allValues(spec) {
  return (spec?.datasets ?? []).flatMap((d) => (Array.isArray(d?.data) ? d.data : []))
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v));
}

function niceCeil(value) {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = 10 ** exp;
  const n = value / base;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * base;
}

function axisScale(spec) {
  const values = allValues(spec);
  const rawMax = values.length > 0 ? Math.max(...values) : 1;
  const rawMin = values.length > 0 ? Math.min(...values, 0) : 0;
  const max = niceCeil(rawMax === 0 ? 1 : rawMax);
  const min = rawMin < 0 ? -niceCeil(Math.abs(rawMin)) : 0;
  return { min, max };
}

function ticks(min, max, count = 4) {
  const out = [];
  for (let i = 0; i <= count; i += 1) out.push(min + ((max - min) * i) / count);
  return out;
}

function fmt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return String(n);
  if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(1)}万`;
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(Math.abs(v) < 1 ? 2 : 1);
}

function Grid({ min, max }) {
  const plotH = H - PAD.top - PAD.bottom;
  return (
    <g>
      {ticks(min, max).map((t, i) => {
        const y = PAD.top + plotH - ((t - min) / (max - min || 1)) * plotH;
        return (
          <g key={i}>
            <line x1={PAD.left} y1={y} x2={W - PAD.right} y2={y} stroke="#e6e9ef" strokeWidth="1" />
            <text x={PAD.left - 8} y={y + 4} textAnchor="end" fontSize="11" fill="#6b7688">
              {fmt(t)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function BarChart({ spec }) {
  const labels = spec?.labels ?? [];
  const datasets = spec?.datasets ?? [];
  const { min, max } = axisScale(spec);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const groupW = plotW / Math.max(labels.length, 1);
  const barW = Math.min(46, (groupW * 0.7) / Math.max(datasets.length, 1));

  return (
    <g>
      <Grid min={min} max={max} />
      {labels.map((label, li) =>
        datasets.map((ds, di) => {
          const value = Number(ds?.data?.[li] ?? 0);
          const h = Math.max(1, ((value - min) / (max - min || 1)) * plotH);
          const x = PAD.left + groupW * li + groupW / 2 - (barW * datasets.length) / 2 + barW * di;
          const y = PAD.top + plotH - ((value - min) / (max - min || 1)) * plotH;
          return (
            <g key={`${li}-${di}`}>
              <rect x={x} y={y} width={Math.max(1, barW - 2)} height={Math.max(1, plotH - (y - PAD.top))} fill={PALETTE[di % PALETTE.length]} rx="1" />
              <text x={x + (barW - 2) / 2} y={y - 6} textAnchor="middle" fontSize="10.5" fill="#16202e">
                {fmt(value)}
              </text>
            </g>
          );
        }),
      )}
      {labels.map((label, li) => (
        <text key={li} x={PAD.left + groupW * li + groupW / 2} y={H - PAD.bottom + 20} textAnchor="middle" fontSize="11.5" fill="#16202e">
          {String(label).slice(0, 10)}
        </text>
      ))}
    </g>
  );
}

function LineChart({ spec }) {
  const labels = spec?.labels ?? [];
  const datasets = spec?.datasets ?? [];
  const { min, max } = axisScale(spec);
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const step = labels.length > 1 ? plotW / (labels.length - 1) : plotW;
  const px = (i) => PAD.left + (labels.length > 1 ? step * i : plotW / 2);
  const py = (v) => PAD.top + plotH - ((Number(v) - min) / (max - min || 1)) * plotH;

  return (
    <g>
      <Grid min={min} max={max} />
      {labels.map((label, li) => (
        <text key={li} x={px(li)} y={H - PAD.bottom + 20} textAnchor="middle" fontSize="11.5" fill="#16202e">
          {String(label).slice(0, 10)}
        </text>
      ))}
      {datasets.map((ds, di) => {
        const pts = (ds?.data ?? []).map((v, i) => `${px(i)},${py(v)}`).join(" ");
        return (
          <g key={di}>
            <polyline points={pts} fill="none" stroke={PALETTE[di % PALETTE.length]} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
            {(ds?.data ?? []).map((v, i) => (
              <circle key={i} cx={px(i)} cy={py(v)} r="3.2" fill="#fff" stroke={PALETTE[di % PALETTE.length]} strokeWidth="2" />
            ))}
          </g>
        );
      })}
    </g>
  );
}

// 热力图色阶：绿（低）→ 琥珀（中）→ 红（高）
function heatColor(t) {
  const stops = [
    [0, [31, 138, 95]],
    [0.5, [224, 168, 0]],
    [1, [179, 55, 44]],
  ];
  const x = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  let i = 0;
  while (i < stops.length - 2 && x > stops[i + 1][0]) i += 1;
  const [t0, c0] = stops[i];
  const [t1, c1] = stops[i + 1];
  const k = (x - t0) / (t1 - t0 || 1);
  const c = c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function heatText(bg) {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(bg);
  if (!m) return "#fff";
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#16202e" : "#fff";
}

function HeatmapChart({ spec, height }) {
  const labels = spec?.labels ?? [];
  const datasets = spec?.datasets ?? [];
  const values = allValues(spec);
  const sMin = Array.isArray(spec?.scale) && spec.scale.length === 2 ? Number(spec.scale[0]) : (values.length ? Math.min(...values) : 0);
  const sMax = Array.isArray(spec?.scale) && spec.scale.length === 2 ? Number(spec.scale[1]) : (values.length ? Math.max(...values) : 1);
  const norm = (v) => (Number(v) - sMin) / (sMax - sMin || 1);

  const x0 = PAD.left;
  const y0 = PAD.top + 18;
  const cw = (W - PAD.left - PAD.right) / Math.max(labels.length, 1);
  const ch = Math.min(44, Math.max(24, (height - y0 - 6) / Math.max(datasets.length, 1)));

  return (
    <g>
      {labels.map((label, li) => (
        <text key={li} x={x0 + cw * li + cw / 2} y={PAD.top + 10} textAnchor="middle" fontSize="11.5" fontWeight="600" fill="#16202e">
          {String(label).slice(0, 10)}
        </text>
      ))}
      {datasets.map((ds, di) => (
        <g key={di}>
          <text x={x0 - 8} y={y0 + ch * di + ch / 2 + 4} textAnchor="end" fontSize="11.5" fill="#16202e">
            {String(ds?.label ?? `系列 ${di + 1}`).slice(0, 10)}
          </text>
          {labels.map((label, li) => {
            const raw = ds?.data?.[li];
            const v = Number(raw);
            const has = Number.isFinite(v);
            const bg = heatColor(norm(v));
            return (
              <g key={li}>
                <rect x={x0 + cw * li + 1.5} y={y0 + ch * di + 1.5} width={cw - 3} height={ch - 3} rx="3" fill={has ? bg : "#eef1f5"}>
                  {has ? <title>{`${ds?.label ?? ""} · ${label}: ${fmt(v)}`}</title> : null}
                </rect>
                <text x={x0 + cw * li + cw / 2} y={y0 + ch * di + ch / 2 + 4} textAnchor="middle" fontSize="11" fontWeight="600" fill={has ? heatText(bg) : "#9aa3b2"}>
                  {has ? fmt(v) : "—"}
                </text>
              </g>
            );
          })}
        </g>
      ))}
    </g>
  );
}

function PieChart({ spec }) {
  const labels = spec?.labels ?? [];
  const data = (spec?.datasets?.[0]?.data ?? []).map((v) => Math.max(0, Number(v) || 0));
  const total = data.reduce((a, b) => a + b, 0) || 1;
  const cx = 190;
  const cy = H / 2;
  const r = 108;
  let angle = -Math.PI / 2;

  return (
    <g>
      {data.map((value, i) => {
        const slice = (value / total) * Math.PI * 2;
        const x1 = cx + r * Math.cos(angle);
        const y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(angle + slice);
        const y2 = cy + r * Math.sin(angle + slice);
        const large = slice > Math.PI ? 1 : 0;
        const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
        angle += slice;
        const pct = ((value / total) * 100).toFixed(1);
        return (
          <path key={i} d={path} fill={PALETTE[i % PALETTE.length]} stroke="#fff" strokeWidth="1.5">
            <title>{`${labels[i] ?? i}: ${fmt(value)}（${pct}%）`}</title>
          </path>
        );
      })}
      {labels.map((label, i) => {
        const pct = ((data[i] / total) * 100).toFixed(1);
        return (
          <g key={i} transform={`translate(360, ${40 + i * 30})`}>
            <rect width="12" height="12" rx="2" fill={PALETTE[i % PALETTE.length]} />
            <text x="19" y="10.5" fontSize="12" fill="#16202e">
              {String(label).slice(0, 16)} · {fmt(data[i])}（{pct}%）
            </text>
          </g>
        );
      })}
    </g>
  );
}

export default function ChartBlock({ spec }) {
  const type = String(spec?.type ?? "bar").toLowerCase();
  const title = spec?.title ?? "";
  const unit = spec?.unit ?? "";
  const datasets = spec?.datasets ?? [];
  const labels = spec?.labels ?? [];
  const valid = labels.length > 0 && datasets.length > 0;

  // 热力图按行数自适应高度，其余类型固定高度
  const heatH = PAD.top + 18 + datasets.length * 44 + 8;
  const height = type === "heatmap" ? Math.min(1200, Math.max(H, heatH)) : H;

  if (!valid) {
    return <div className="vf-chart vf-chart--bad">图表数据不完整（缺少 labels 或 datasets）</div>;
  }

  return (
    <figure className="vf-chart">
      {title ? (
        <figcaption className="vf-chart-title">
          {title}
          {unit ? <span className="vf-chart-unit">单位：{unit}</span> : null}
        </figcaption>
      ) : null}
      <svg viewBox={`0 0 ${W} ${height}`} width="100%" role="img" preserveAspectRatio="xMidYMid meet">
        {type === "line" ? <LineChart spec={spec} /> : type === "pie" ? <PieChart spec={spec} /> : type === "heatmap" ? <HeatmapChart spec={spec} height={height} /> : <BarChart spec={spec} />}
      </svg>
      {type !== "pie" && type !== "heatmap" && datasets.length > 1 ? (
        <div className="vf-chart-legend">
          {datasets.map((ds, i) => (
            <span key={i} className="vf-legend-item">
              <i style={{ background: PALETTE[i % PALETTE.length] }} />
              {ds?.label ?? `系列 ${i + 1}`}
            </span>
          ))}
        </div>
      ) : null}
    </figure>
  );
}
