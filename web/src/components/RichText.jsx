import React, { memo, useMemo } from "react";
import ChartBlock from "./charts.jsx";

// 轻量 Markdown 渲染（不引三方依赖）：
// 支持 ```chart 图表块 / ```code 代码块 / 标题 / 表格 / 有序无序列表 / 加粗 / 行内代码 / 图片 / 链接
// 渲染口径对齐"办公助手"风格：结论先行、分节、表格化、可嵌入图表

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`|!\[[^\]]*\]\([^)]+\)|\[[^\]]*\]\([^)]+\))/g;

// 链接/图片 URL 白名单：拦截 javascript:/vbscript:/data:text 等可执行协议（Markdown 链接点击即执行是经典 XSS 面）
function safeHref(url) {
  const u = String(url ?? "").trim();
  if (/^(https?:\/\/|mailto:|\/|#|\.\/|\.\.\/)/i.test(u)) return u;
  return null;
}
function safeImgSrc(url) {
  const u = String(url ?? "").trim();
  if (/^(https?:\/\/|\/|\.\/|data:image\/(png|jpe?g|gif|webp);base64,)/i.test(u)) return u;
  return null;
}

function inlineNodes(text, key) {
  const parts = String(text).split(INLINE_RE).filter((p) => p !== "");
  return parts.map((part, i) => {
    const k = `${key}-${i}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={k}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={k} className="md-code">{part.slice(1, -1)}</code>;
    }
    const img = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(part);
    if (img) {
      const src = safeImgSrc(img[2]);
      if (src == null) return <React.Fragment key={k}>{part}</React.Fragment>;
      return <img key={k} className="md-img" src={src} alt={img[1]} loading="lazy" title="点击放大/还原" onClick={(e) => e.currentTarget.classList.toggle("zoomed")} />;
    }
    const link = /^\[([^\]]*)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const href = safeHref(link[2]);
      if (href == null) return <React.Fragment key={k}>{link[1]}</React.Fragment>;
      return (
        <a key={k} href={href} target="_blank" rel="noreferrer noopener" className="md-link">
          {link[1]}
        </a>
      );
    }
    return <React.Fragment key={k}>{part}</React.Fragment>;
  });
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

function isSeparator(line) {
  return /^\|?[\s:|-]*-[\s:|-]*\|?$/.test((line ?? "").trim()) && (line ?? "").includes("-");
}

function parseBlocks(text) {
  const lines = String(text).split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      out.push({ type: "h", level: heading[1].length, text: heading[2] });
      i += 1;
      continue;
    }
    if (line.trim().startsWith("|") && isSeparator(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push({ type: "table", header, rows });
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i += 1;
      }
      out.push({ type: "ul", items });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      out.push({ type: "ol", items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const items = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        items.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      out.push({ type: "quote", items });
      continue;
    }
    const buf = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !lines[i].trim().startsWith("|")
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    out.push({ type: "p", text: buf.join("\n") });
  }
  return out;
}

function renderBlocks(blocks, keyPrefix) {
  return blocks.map((b, i) => {
    const key = `${keyPrefix}-${i}`;
    if (b.type === "h") {
      const Tag = b.level <= 3 ? "h4" : b.level === 4 ? "h5" : "h6";
      return (
        <Tag key={key} className="md-h">
          {inlineNodes(b.text, key)}
        </Tag>
      );
    }
    if (b.type === "table") {
      return (
        <div className="md-table-wrap" key={key}>
          <table className="md-table">
            <thead>
              <tr>
                {b.header.map((h, j) => (
                  <th key={j}>{inlineNodes(h, `${key}-h${j}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{inlineNodes(cell, `${key}-${r}-${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    if (b.type === "ul") {
      return (
        <ul className="md-list" key={key}>
          {b.items.map((it, j) => (
            <li key={j}>{inlineNodes(it, `${key}-${j}`)}</li>
          ))}
        </ul>
      );
    }
    if (b.type === "ol") {
      return (
        <ol className="md-list" key={key}>
          {b.items.map((it, j) => (
            <li key={j}>{inlineNodes(it, `${key}-${j}`)}</li>
          ))}
        </ol>
      );
    }
    if (b.type === "quote") {
      return (
        <blockquote className="md-quote" key={key}>
          {b.items.map((it, j) => (
            <div key={j}>{inlineNodes(it, `${key}-${j}`)}</div>
          ))}
        </blockquote>
      );
    }
    return (
      <p className="md-p" key={key}>
        {inlineNodes(b.text, key)}
      </p>
    );
  });
}

/** 按围栏代码块切分：```chart 渲染图表，其他渲染为代码块 */
function splitFences(text) {
  const src = String(text ?? "");
  const out = [];
  const re = /```(\w*)[ \t]*\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ kind: "text", value: src.slice(last, m.index) });
    out.push({ kind: "fence", lang: (m[1] || "").toLowerCase(), value: m[2] });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ kind: "text", value: src.slice(last) });
  return out;
}

// ```svg 围栏：内联渲染矢量图。安全策略（2026-09-10 审计 S1 根治）：
// 不再用正则黑名单（可被 <set attributeName="onload">、实体编码 &#x6A;avascript: 等绕过），
// 改为 DOMParser 解析 + 元素/属性白名单重建：只保留绘图元素，剥掉一切事件属性、脚本、外链/脚本 URL、
// foreignObject、动画节点与处理指令；DOMParser 会先解码实体，属性值判定基于解码后的真实值。
const SVG_TAGS = new Set([
  "svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "textPath",
  "title", "desc", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "marker",
  "symbol", "use", "image", "style", "filter", "feGaussianBlur", "feOffset", "feBlend", "feColorMatrix",
  "feComposite", "feFlood", "feMerge", "feMergeNode", "feDropShadow", "feMorphology", "switch",
]);
const DANGEROUS_VALUE_RE = /javascript:|vbscript:|data:text\/html|data:application/i;
const DANGEROUS_STYLE_RE = /url\s*\(|expression\s*\(|@import|javascript|behavior\s*:/i;

function cleanSvgAttrs(el) {
  for (const attr of [...el.attributes]) {
    const name = attr.name.toLowerCase();
    const value = attr.value;
    if (name.startsWith("on") || DANGEROUS_VALUE_RE.test(value)) { el.removeAttribute(attr.name); continue; }
    if (name === "href" || name === "xlink:href") {
      const isImage = el.localName === "image";
      const ok = value.startsWith("#")
        || (isImage && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(value))
        || (isImage && /^(https?:\/\/|\/)/i.test(value));
      if (!ok) el.removeAttribute(attr.name);
      continue;
    }
    if (name === "style" && DANGEROUS_STYLE_RE.test(value)) el.removeAttribute(attr.name);
  }
}

function cleanSvgTree(el) {
  for (const node of [...el.childNodes]) {
    if (node.nodeType === 7 || node.nodeType === 8) { node.remove(); continue; } // 处理指令 / 注释
    if (node.nodeType !== 1) continue; // 文本保留
    const tag = node.localName;
    if (!SVG_TAGS.has(tag)) { node.remove(); continue; }
    if (tag === "style" && DANGEROUS_STYLE_RE.test(node.textContent ?? "")) { node.remove(); continue; }
    cleanSvgAttrs(node);
    cleanSvgTree(node);
  }
}

function sanitizeSvg(src) {
  let s = String(src ?? "").trim();
  if (s.length > 200000 || typeof DOMParser === "undefined") return null;
  const open = /<svg[\s>]/i.exec(s);
  if (!open) return null;
  const end = s.toLowerCase().lastIndexOf("</svg>");
  s = s.slice(open.index, end === -1 ? undefined : end + 6);
  let doc;
  try {
    doc = new DOMParser().parseFromString(s, "image/svg+xml");
  } catch {
    return null;
  }
  if (doc.getElementsByTagName("parsererror").length > 0) return null;
  const root = doc.documentElement;
  if (root == null || root.localName !== "svg") return null;
  cleanSvgAttrs(root);
  cleanSvgTree(root);
  root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  try {
    return new XMLSerializer().serializeToString(root);
  } catch {
    return null;
  }
}

function SvgBlock({ source }) {
  const clean = useMemo(() => sanitizeSvg(source), [source]);
  if (clean == null) {
    return (
      <pre className="md-code-block">
        {String(source ?? "").replace(/\n$/, "")}
      </pre>
    );
  }
  return <div className="md-svg" dangerouslySetInnerHTML={{ __html: clean }} />;
}

// 渲染错误边界：单条消息的 Markdown/图表/SVG 解析异常只降级该条为纯文本，绝不让整页白屏
class RenderBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.error("[RichText] 渲染失败，已降级为纯文本", error);
  }
  componentDidUpdate(prev) {
    if (prev.content !== this.props.content && this.state.failed) this.setState({ failed: false });
  }
  render() {
    if (this.state.failed) return <pre className="md-code-block">{String(this.props.content ?? "")}</pre>;
    return this.props.children;
  }
}

// memo：content 字符串不变则跳过整段 Markdown 重解析（历史消息在流式期间引用/内容均不变）
function RichTextInner({ content }) {
  const segments = splitFences(content);
  return (
    <div className="md">
      {segments.map((seg, i) => {
        if (seg.kind === "fence") {
          if (seg.lang === "chart") {
            let spec = null;
            try {
              spec = JSON.parse(seg.value.trim());
            } catch {
              return (
                <pre className="md-code-block" key={i}>
                  {seg.value}
                </pre>
              );
            }
            return <ChartBlock key={i} spec={spec} />;
          }
          if (seg.lang === "svg") {
            return <SvgBlock key={i} source={seg.value} />;
          }
          return (
            <pre className="md-code-block" key={i}>
              {seg.value.replace(/\n$/, "")}
            </pre>
          );
        }
        return <React.Fragment key={i}>{renderBlocks(parseBlocks(seg.value), `s${i}`)}</React.Fragment>;
      })}
    </div>
  );
}

function RichText({ content }) {
  return (
    <RenderBoundary content={content}>
      <RichTextInner content={content} />
    </RenderBoundary>
  );
}

export default memo(RichText);
