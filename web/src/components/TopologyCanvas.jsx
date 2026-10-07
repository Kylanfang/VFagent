import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * 组织拓扑关系画布：真人成员 / 管理员 → AI 员工（归属）→ 临时部门（成员关系）
 * 节点可拖拽调整位置；悬停高亮该节点的全部连线。
 */
const W = 980;
const NODE_W = 128;
const NODE_H = 40;
const COL_X = [110, 430, 790];
const COL_TITLE = ["真人成员", "AI 员工", "临时部门"];
const TYPE_STYLE = {
  boss: { fill: "#1f5c8b", text: "#fff", label: "管理员账号" },
  admin: { fill: "#b26a00", text: "#fff", label: "管理员" },
  member: { fill: "#6b7688", text: "#fff", label: "成员" },
  ai: { fill: "#1f8a5f", text: "#fff", label: "AI 员工" },
  team: { fill: "#7b4fa6", text: "#fff", label: "临时部门" },
  public: { fill: "#8d99ab", text: "#fff", label: "公共（服务端托管）" },
};

export default function TopologyCanvas({ employees, teams, users, isStaff }) {
  const svgRef = useRef(null);
  const [hover, setHover] = useState(null);
  const dragRef = useRef(null);

  const graph = useMemo(() => {
    const nodes = [];
    const edges = [];
    const id2node = new Map();

    const add = (id, type, label, col) => {
      const n = { id, type, label: String(label ?? id).slice(0, 12), col, row: 0 };
      nodes.push(n);
      id2node.set(id, n);
      return n;
    };

    // 第一列：真人（管理员/成员）+ 公共托管
    const humans = [];
    if (isStaff && Array.isArray(users)) {
      for (const u of users) {
        if (u.status !== "active") continue;
        const type = u.role === "boss" ? "boss" : u.role === "observer" ? "admin" : "member";
        humans.push(add(`u:${u.id}`, type, u.display_name || u.username, 0));
      }
    }
    const pub = add("__public__", "public", "公共 API 池", 0);
    humans.push(pub);

    // 第二列：AI 员工
    for (const e of employees ?? []) {
      const n = add(`e:${e.id}`, "ai", e.name, 1);
      const owner = e.owner_user_id != null ? `u:${e.owner_user_id}` : "__public__";
      if (id2node.has(owner)) edges.push({ from: owner, to: n.id, kind: "own" });
      else edges.push({ from: "__public__", to: n.id, kind: "own" });
    }

    // 第三列：临时部门 → 成员 AI 员工
    for (const t of teams ?? []) {
      const n = add(`t:${t.id}`, "team", t.name, 2);
      const memberIds = Array.isArray(t.member_ids) ? t.member_ids : [];
      for (const mid of memberIds) {
        if (id2node.has(`e:${mid}`)) edges.push({ from: `e:${mid}`, to: n.id, kind: "team" });
      }
      const humanIds = Array.isArray(t.member_user_ids) ? t.member_user_ids : [];
      for (const hid of humanIds) {
        if (id2node.has(`u:${hid}`)) edges.push({ from: `u:${hid}`, to: n.id, kind: "team" });
      }
    }

    // 按列分行
    const colCount = [0, 0, 0];
    for (const n of nodes) {
      n.row = colCount[n.col];
      colCount[n.col] += 1;
    }
    const height = Math.max(3, ...colCount) * (NODE_H + 26) + 90;
    const layout = new Map(nodes.map((n) => [n.id, { x: COL_X[n.col], y: 70 + n.row * (NODE_H + 26) }]));
    return { nodes, edges, height, layout };
  }, [employees, teams, users, isStaff]);

  const [pos, setPos] = useState(graph.layout);
  // 数据变化时重置布局
  useEffect(() => { setPos(graph.layout); }, [graph]);

  const toSvgXY = (evt) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const scale = rect.width / W;
    return { x: (evt.clientX - rect.left) / scale, y: (evt.clientY - rect.top) / (rect.height / graph.height) };
  };

  const onNodeDown = (evt, id) => {
    const p = toSvgXY(evt);
    const n = pos.get(id);
    if (!p || !n) return;
    dragRef.current = { id, dx: p.x - n.x, dy: p.y - n.y };
    evt.currentTarget.setPointerCapture?.(evt.pointerId);
  };
  const onPointerMove = (evt) => {
    const d = dragRef.current;
    if (!d) return;
    const p = toSvgXY(evt);
    if (!p) return;
    setPos((prev) => {
      const next = new Map(prev);
      next.set(d.id, { x: Math.max(10, Math.min(W - NODE_W - 10, p.x - d.dx)), y: Math.max(56, Math.min(graph.height - NODE_H - 10, p.y - d.dy)) });
      return next;
    });
  };
  const onPointerUp = () => { dragRef.current = null; };

  const edgePath = (from, to) => {
    const a = pos.get(from);
    const b = pos.get(to);
    if (!a || !b) return "";
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  };

  const active = (e) => hover == null || e.from === hover || e.to === hover;

  return (
    <section className="card">
      <h3>组织拓扑关系 <small className="dim">（节点可拖拽 · 悬停高亮关系 · 共 {graph.nodes.length} 节点 / {graph.edges.length} 关系）</small></h3>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${graph.height}`}
        width="100%"
        role="img"
        style={{ touchAction: "none", userSelect: "none" }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <defs>
          <marker id="tp-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#9aa8ba" />
          </marker>
        </defs>
        {COL_TITLE.map((t, i) => (
          <text key={t} x={COL_X[i] + NODE_W / 2} y={34} textAnchor="middle" fontSize="12" fontWeight="700" fill="#6b7688">
            {t}
          </text>
        ))}
        {graph.edges.map((e, i) => (
          <path
            key={i}
            d={edgePath(e.from, e.to)}
            fill="none"
            stroke={active(e) ? (e.kind === "own" ? "#4f8fd9" : "#7b4fa6") : "#dde3ea"}
            strokeWidth={active(e) ? 1.8 : 1.1}
            markerEnd="url(#tp-arrow)"
            opacity={active(e) ? 0.9 : 0.35}
          />
        ))}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id) ?? { x: 0, y: 0 };
          const st = TYPE_STYLE[n.type];
          const dim = hover != null && hover !== n.id && !graph.edges.some((e) => (e.from === hover && e.to === n.id) || (e.to === hover && e.from === n.id));
          return (
            <g
              key={n.id}
              transform={`translate(${p.x}, ${p.y})`}
              style={{ cursor: "grab", opacity: dim ? 0.35 : 1 }}
              onPointerDown={(evt) => onNodeDown(evt, n.id)}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
            >
              <rect width={NODE_W} height={NODE_H} rx="8" fill={st.fill} stroke="rgba(255,255,255,.55)" strokeWidth="1" />
              <text x={NODE_W / 2} y={NODE_H / 2 + 4.5} textAnchor="middle" fontSize="12.5" fontWeight="600" fill={st.text}>
                {n.label}
              </text>
              <title>{`${st.label}：${n.label}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="vf-chart-legend" style={{ marginTop: 6 }}>
        {Object.entries(TYPE_STYLE).map(([k, v]) => (
          <span key={k} className="vf-legend-item"><i style={{ background: v.fill }} />{v.label}</span>
        ))}
      </div>
    </section>
  );
}
