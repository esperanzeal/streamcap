// host.js — 任务宿主标签页选择与迁移（手动重试 + 自动接管共用）
import { state } from './state.js';
import { queueTask } from './pool.js';

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
  // “卡过”的判定改用 v5 真实存在的信号（stallCount 已无人自增 → 旧判据恒为 false，防呆失效）：
  const wasStalled = (d.reloadCount || 0) > 0
    || (d.acquireFails || 0) > 0
    || (d.consecutiveFails || 0) > 0
    || /停摆|停滞|无进度|无响应|无法建立承载页/.test(d.error || '');
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
  // 候选池必须有"依据"：① 页面 URL 与任务页面同源；② sniffStore 里确实记录过该任务 URL 的 tab。
  // ★ 禁止退化为"任意其它 tab"（曾经如此）——不同源页面照样能跑下载（分片是绝对 URL），但：
  //   ① OPFS 分片按 origin 隔离，跨源读不到旧分片 → 续传失效、从头重下；
  //   ② 任务来源页与宿主页不一致，定位/回原页全乱；
  //   ③ 需要站点 Referer/Cookie 鉴权的分片会 403。
  //   用户实测：两个不同站的任务（各自页面已关）双双挂到"为第一个任务自动打开的那个页面"，
  //   且都能下（其实是重新下）——就是踩了这条退路。无依据时应当走下面的"开任务自己的页面"。
  const others = [...cands.values()].filter(t => t.id !== orig);
  const sniffHas = t => {
    const store = state.sniffStore[t.id];
    return !!(store && Array.isArray(store.videos) && store.videos.some(v => v.url === d.url));
  };
  const sameOriginPool = others.filter(isSameOrigin);
  const urlHitPool = others.filter(t => !isSameOrigin(t) && sniffHas(t));
  const source = sameOriginPool.length ? sameOriginPool : urlHitPool;
  const tabLoad = tid => (state.tabActive[tid] ? 1 : 0); // v5：队列不绑 tab，负载 = 该 tab 是否在跑

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
  // v5：任务只在全局 readyQueue 里排队；tab 只是承载页，迁移 = 换承载页 + 释放原来的
  if (state.tabActive[d.tabId] === d.id) state.tabActive[d.tabId] = null;
  if (state.tabPool[d.tabId]) state.tabPool[d.tabId].taskId = null;
  d.tabId = hostTabId;
  let origin = "";
  try { origin = new URL(d.pageUrl || d.referer || "").origin; } catch { /* 无来源页 */ }
  state.tabPool[hostTabId] = { origin, taskId: d.id, lastUsedAt: Date.now() };
  queueTask(d.id);
  d.status = "queued";
  d.error = null;
  if (resetCounters) {
    // 手动重试 = 新的尝试周期（保留 createdAt 保持 FIFO 原位置）
    d.consecutiveFails = 0;
  }
  // resetCounters=false（自动接管）：失败计数不清零 → 停滞/失败上限持续累计，
  // 保证换承载页重试也有界，不会无限兜圈
}
