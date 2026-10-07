import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
const KEYS = (() => { try { return JSON.parse(readFileSync(new URL("../.autotest/keys.json", import.meta.url), "utf8")); } catch { return { qiyuan_key: process.env.QIYUAN_KEY ?? "", campus_key: process.env.CAMPUS_KEY ?? "" }; } })();
const KEY = KEYS.qiyuan_key;
for (const [tag, prompt] of [["shield", "a blue shield icon on white background, flat design, minimal"], ["apple", "a red apple on a wooden table"]]) {
  const t0 = Date.now();
  const r = await fetch("https://api.qiyuanapi.cc/v1/images/generations", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + KEY }, body: JSON.stringify({ model: "qwen-image", prompt, n: 1, size: "512x512" }), signal: AbortSignal.timeout(180000) });
  const j = await r.json().catch(() => null);
  const url = j?.data?.[0]?.url;
  console.log(tag, r.status, (Date.now() - t0) + "ms", url);
  if (url) { const img = await fetch(url); const b = Buffer.from(await img.arrayBuffer()); writeFileSync(`.autotest/probe_${tag}.png`, b); console.log("  saved", b.length); }
}
