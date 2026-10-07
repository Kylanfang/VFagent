// 留痕上报：把使用留痕批量上报到配置的上报端点（fire-and-forget，不阻塞对话）。
// 配置：环境变量 VFLETCH_REPORT_URL（主控 /api/ingest 完整地址）+ VFLETCH_REPORT_KEY（共享密钥）。
// 主控侧密钥为同名 env VFLETCH_RELAY_KEY（与生图中继共用一把钥匙）。
const QUEUE = [];
let flushing = false;
let failStreak = 0;

export function reportConfigured() {
  return Boolean(process.env.VFLETCH_REPORT_URL && process.env.VFLETCH_REPORT_KEY);
}

/** 入队一条上报事件：{ kind, subject, summary, detail } */
export function reportEvent(event) {
  if (!reportConfigured()) return;
  QUEUE.push({ ...event, at: new Date().toISOString().slice(0, 19).replace("T", " ") });
  if (QUEUE.length > 200) QUEUE.splice(0, QUEUE.length - 200);
  scheduleFlush();
}

function scheduleFlush(delayMs = 3000) {
  if (flushing) return;
  flushing = true;
  setTimeout(flush, delayMs).unref?.();
}

const qlen = () => QUEUE.length;
/** 日志脱敏：去掉换行/控制字符，避免上报失败信息被构造成多行日志（日志伪造） */
function oneLine(value, max = 140) {
  return String(value ?? "").replace(/[\r\n\u0000-\u001F]+/g, " ").slice(0, max);
}

async function flush() {
  const batch = QUEUE.splice(0, 50);
  if (batch.length === 0) {
    flushing = false;
    return;
  }
  let retryDelay = 3000;
  try {
    const res = await fetch(process.env.VFLETCH_REPORT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: process.env.VFLETCH_REPORT_KEY, events: batch }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${oneLine(await res.text().catch(() => ""), 120)}`);
    failStreak = 0;
  } catch (error) {
    // 上报失败不能静默：否则主控密钥不一致/网络断开时运维完全无感知（监管留痕在悄悄丢失）
    failStreak += 1;
    // 修复：原实现从队列 splice 出来的这一批在失败后被直接丢弃 —— 主控短暂不可达或
    // 密钥不一致时，这批留痕**永久消失**（只在日志里留一行警告），与"全量留痕"的产品承诺相悖。
    // 改为整批回填队首等待重试，并按失败次数做指数退避（上限 60s），避免打爆主控。
    QUEUE.unshift(...batch);
    if (QUEUE.length > 200) QUEUE.splice(200);
    retryDelay = Math.min(60_000, 3000 * 2 ** Math.min(failStreak, 5));
    if (failStreak === 1 || failStreak % 20 === 0) {
      console.warn(`[report] 上报失败（连续第 ${failStreak} 次，队列积压 ${qlen()} 条，${Math.round(retryDelay / 1000)}s 后重试）: ${oneLine(error?.message ?? error)}`);
    }
  }
  flushing = false;
  if (QUEUE.length > 0) scheduleFlush(retryDelay);
}
