import { readFileSync } from "node:fs";
const KEYS = (() => { try { return JSON.parse(readFileSync(new URL("../.autotest/keys.json", import.meta.url), "utf8")); } catch { return { qiyuan_key: process.env.QIYUAN_KEY ?? "", campus_key: process.env.CAMPUS_KEY ?? "" }; } })();
// 生图端点可达性探测
const VF_KEY = KEYS.campus_key;
const QY_KEY = KEYS.qiyuan_key;
async function txt(r, n = 300) { return (await r.text()).slice(0, n); }
const tests = [
  ["VF images", async () => {
    const r = await fetch("http://gateway.example.com/v1/images/generations", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + VF_KEY }, body: JSON.stringify({ model: "Qwen3.5-122B-A10B", prompt: "a cat", n: 1, size: "512x512" }), signal: AbortSignal.timeout(20000) });
    return r.status + " " + await txt(r, 200);
  }],
  ["VF models", async () => {
    const r = await fetch("http://gateway.example.com/v1/models", { headers: { authorization: "Bearer " + VF_KEY }, signal: AbortSignal.timeout(15000) });
    return r.status + " " + await txt(r, 800);
  }],
  ["qiyuan dall-e-3", async () => {
    const r = await fetch("https://api.qiyuanapi.cc/v1/images/generations", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + QY_KEY }, body: JSON.stringify({ model: "dall-e-3", prompt: "a cat", n: 1, size: "1024x1024" }), signal: AbortSignal.timeout(90000) });
    return r.status + " " + await txt(r, 300);
  }],
  ["qiyuan models", async () => {
    const r = await fetch("https://api.qiyuanapi.cc/v1/models", { headers: { authorization: "Bearer " + QY_KEY }, signal: AbortSignal.timeout(20000) });
    const t = await r.text(); let ids = [];
    try { ids = JSON.parse(t).data.map((m) => m.id); } catch {}
    const img = ids.filter((i) => /image|dall|flux|sd|stable|diffusion|imagen|seedream|kolors|cogview|wan|banana/i.test(i));
    return r.status + " n=" + ids.length + " img=" + img.slice(0, 40).join(",");
  }],
  ["pollinations", async () => {
    const r = await fetch("https://image.pollinations.ai/prompt/a%20red%20apple?width=256&height=256&nologo=true", { signal: AbortSignal.timeout(60000) });
    const b = await r.arrayBuffer();
    return r.status + " " + r.headers.get("content-type") + " " + b.byteLength + "B";
  }],
];
for (const [name, fn] of tests) {
  const t0 = Date.now();
  try { console.log("[" + name + "] " + await fn() + " (" + (Date.now() - t0) + "ms)"); }
  catch (e) { console.log("[" + name + "] ERR " + e.message + " " + (e.cause?.message ?? "") + " (" + (Date.now() - t0) + "ms)"); }
}
