// state.js — StreamCap 全局状态 + 持久化/广播
export const state = {
  nextId: Date.now(),
  downloads: {},      // id → record
  tabQueues: {},      // tabId → [downloadId, ...]
  tabActive: {},      // tabId → downloadId | null
  sniffStore: {},     // tabId → { m3u8s: [], pageUrl: '', pageTitle: '' }
  managerPorts: [],   // manager 页长连接端口
};

export function persist() {
  const list = Object.values(state.downloads).map(d => ({
    id: d.id, url: d.url, referer: d.referer, resolution: d.resolution,
    status: d.status, pct: d.pct, done: d.done, total: d.total,
    speed: d.speed, error: d.error, createdAt: d.createdAt, tabId: d.tabId,
    fileName: d.fileName, pageTitle: d.pageTitle, dupIndex: d.dupIndex,
    retryCount: d.retryCount, consecutiveFails: d.consecutiveFails,
    lastProgressAt: d.lastProgressAt, lastDone: d.lastDone, lastDoneAt: d.lastDoneAt, stalledAt: d.stalledAt,
    stopPendingAt: d.stopPendingAt, priorityAt: d.priorityAt,
  }));
  chrome.storage.local.set({ vgp_downloads: list });
}

export function broadcast(msg) {
  const str = JSON.stringify(msg);
  state.managerPorts.forEach(p => { try { p.postMessage(msg); } catch { /* dead */ } });
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// 日志任务标识：优先任务名（如 video.mp4），重复任务带序号，否则回退 id
export function taskLabel(id) {
  const d = state.downloads[id];
  if (!d) return `#${id}`;
  const name = d.pageTitle ? `${d.pageTitle}.mp4` : `#${id}`;
  return d.dupIndex ? `${name} (${d.dupIndex})` : name;
}
