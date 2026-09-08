// host.js — 任务宿主标签页选择与迁移（手动重试 + 自动接管共用）
import { state } from './state.js';

export function pingTabLive(tabId) {
  if (tabId === undefined || tabId === null) return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, resp => {
        resolve(!chrome.runtime.lastError && resp && resp.ok === true);
      });
    } catch { resolve(false); }
  });
}
function originOf(u) {
  try { return new URL(u).origin; } catch { return ''; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 宿主健康度：PING/心跳只证明"content 消息循环活着"，不证明"下载能推进"——
// 页面活着但网络卡死时 PING 照通（用户实测：手动关掉卡死页任务才失败）。
// 健康 = 该 tab 当前正在下载的任务在 60s 内有实际进度（done 增长）→ 该 tab 网络能跑。
const HOST_HEALTH_MS = 60000;
function hostIsHealthy(tabId) {
  const runningId = state.tabActive[tabId];
  if (runningId === undefined || runningId === null) return false;
  const d2 = state.downloads[runningId];
  if (!d2 || (d2.status !== 'downloading' && d2.status !== 'retrying')) return false;
  return d2.lastDoneAt && (Date.now() - d2.lastDoneAt) < HOST_HEALTH_MS;
}

// 迁移前真实探测：让候选 tab 的 content 对该任务媒体 URL 发 Range 1KB 请求
//（content PROBE_URL 处理，8s 超时）——走真实下载路径（同页面 context/cookie/
// CORS 注入），比 PING 可靠：页面活着但网络卡时 fetch 会挂/超时。
// background 侧 10s 兜底：content 若消息处理卡住不能无限等。
function probeHost(tabId, url) {
  return Promise.race([
    new Promise(resolve => {
      try {
        chrome.tabs.sendMessage(tabId, { type: 'PROBE_URL', url }, r => {
          if (chrome.runtime.lastError || !r) resolve(false);
          else resolve(!!r.ok && r.ms < 8000);
        });
      } catch { resolve(false); }
    }),
    new Promise(resolve => setTimeout(() => resolve(false), 10000)),
  ]);
}

// ============ 统一宿主选择（手动重试 + 自动接管共用） ============
// 原则（用户拍板 2026-09）：
// ① 有活的同源宿主(PING 通) → 绑定：负载最小分散（不堆叠），满负荷也排队等待，不 fail
// ② 无活宿主：openNewTab=true（手动路径，失败是少数，误关浏览器就该开回全部页）
//              → 自动开同源页承接；openNewTab=false（自动路径，无人值守）→ 返回 null
// ③ needProbe（卡过任务）→ 候选逐个真实网络探测，不过换下一个
// ④ 无卡史 + 原 tab 活 → 原地（零打扰）；卡过的原 tab 进排除集（宁接管/开新也不回）
export async function findHostForTask(d, { origId, pageUrlHint, openNewTab = true } = {}) {
  const pageHint = pageUrlHint || d.pageUrl || d.referer || '';
  const orig = origId ?? d.tabId;
  const wasStalled = (d.stallCount || 0) > 0 || /停滞|无进度|无响应/.test(d.error || '');
  const needProbe = wasStalled; // 卡过的任务候选须真实探测；正常任务 trust PING
  const pageOrigin = originOf(pageHint);

  // 无卡史 + 原 tab 活 → 原地续传（零打扰默认）
  if (!wasStalled && orig !== undefined && orig !== null && await pingTabLive(orig)) return orig;

  // 候选：同源 tab + sniffStore URL 命中源页
  const cands = new Map(); // tabId -> { id, url }
  try {
    const allTabs = await chrome.tabs.query({});
    for (const t of allTabs) if (t.id !== undefined) cands.set(t.id, { id: t.id, url: t.url || '' });
  } catch { /* tabs.query 失败 */ }
  for (const [tid, store] of Object.entries(state.sniffStore)) {
    const n = Number(tid);
    if (n && store && Array.isArray(store.videos) && store.videos.some(v => v.url === d.url)) {
      if (!cands.has(n)) cands.set(n, { id: n, url: '' });
    }
  }
  const isSameOrigin = t => pageOrigin && t.url && originOf(t.url) === pageOrigin;
  // 优先同源池；无同源依据（页面地址缺失）时退到 sniffStore 源页池
  const pool = [...cands.values()].filter(t => isSameOrigin(t) && t.id !== orig);
  const source = pool.length ? pool : [...cands.values()].filter(t => t.id !== orig);
  const tabLoad = tid => (state.tabActive[tid] ? 1 : 0) + (state.tabQueues[tid] ? state.tabQueues[tid].length : 0);

  // 活候选按 (负载升序 → 健康优先) 排序；needProbe 时从负载最小开始逐个探测
  const alive = [];
  for (const t of source) {
    if (await pingTabLive(t.id)) alive.push({ t, load: tabLoad(t.id), healthy: hostIsHealthy(t.id) });
  }
  alive.sort((a, b) => (a.load - b.load) || ((b.healthy ? 1 : 0) - (a.healthy ? 1 : 0)));
  for (const c of alive) {
    if (!needProbe || await probeHost(c.t.id, d.url)) return c.t.id;
  }

  // 无活宿主 / 探测全失败 → 手动路径开新页承接（自动路径 openNewTab=false 直接 null）
  if (openNewTab && pageHint) {
    let opened = null;
    try {
      opened = await chrome.tabs.create({ url: pageHint, active: true });
      let ready = false;
      for (let i = 0; i < 40; i++) { // 最多 20s：页面加载 + content script(document_end) 注入
        await sleep(500);
        if (await pingTabLive(opened.id)) { ready = true; break; }
      }
      if (ready && (!needProbe || await probeHost(opened.id, d.url))) return opened.id;
    } catch { /* 开 tab 失败 */ }
    if (opened !== null) {
      try { await chrome.tabs.remove(opened.id); } catch {} // 未就绪/探测失败：不留废 tab
    }
  }
  return null;
}

export function migrateTaskToTab(d, hostTabId, resetCounters = true) {
  const oldQ = state.tabQueues[d.tabId];
  if (oldQ) {
    const i = oldQ.indexOf(d.id);
    if (i >= 0) oldQ.splice(i, 1);
  }
  if (state.tabActive[d.tabId] === d.id) state.tabActive[d.tabId] = null;
  d.tabId = hostTabId;
  if (!state.tabQueues[hostTabId]) state.tabQueues[hostTabId] = [];
  if (!state.tabQueues[hostTabId].includes(d.id)) state.tabQueues[hostTabId].push(d.id);
  d.status = 'queued';
  d.error = null;
  if (resetCounters) {
    // 手动重试 = 新的尝试周期（保留 createdAt 保持 FIFO 原位置）
    d.consecutiveFails = 0;
    d.stallCount = 0;
    d.retryCount = 0;
  }
  // resetCounters=false（自动接管）：失败计数不清零 → 停滞/失败上限持续累计，
  // 保证"换宿主重试"也有界，不会无限兜圈
}
