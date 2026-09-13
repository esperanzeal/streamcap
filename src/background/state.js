// state.js — StreamCap 全局状态 + 持久化/广播
export const state = {
  nextId: Date.now(),
  downloads: {},      // id → record

  // ============ v5 调度结构（见 pool.js） ============
  readyQueue: [],     // ★ 全局就绪队列 [downloadId, ...]——替代旧的"按 tab 排队"（tabQueues）
  running: {},        // ★ 运行中：downloadId → tabId（占用的并发槽）
  tabPool: {},        // ★ 承载页池：tabId → { origin, taskId: id|null, lastUsedAt }
  slotCount: 4,       // ★ 并发槽位（与 manager 的"并发任务"设置同步；0 = 无限）
  sortMode: 'fifo',   // ★ 队列排序偏好：'fifo' 创建时间 | 'progress' 进度降序（先收尾）

  // ============ 承载页/任务状态 ============
  tabActive: {},      // tabId → downloadId | null（一 tab 一任务，语义正确，保留）

  sniffStore: {},     // tabId → { videos: [], pageUrl: '', pageTitle: '' }
  managerPorts: [],   // manager 页长连接端口
};

export function persist() {
  const list = Object.values(state.downloads).map(d => ({
    id: d.id, url: d.url, referer: d.referer, resolution: d.resolution,
    status: d.status, pct: d.pct, done: d.done, total: d.total,
    speed: d.speed, error: d.error, createdAt: d.createdAt, tabId: d.tabId,
    fileName: d.fileName, pageTitle: d.pageTitle, dupIndex: d.dupIndex,
    pageUrl: d.pageUrl, // ★ 必须持久化：浏览器重启后重试要靠它找同源宿主/自动开原页面
    retryCount: d.retryCount, consecutiveFails: d.consecutiveFails,
    stallCount: d.stallCount, // 停滞计数持久化：重启后不归零，避免又从头循环
    reloadCount: d.reloadCount, // "刷新复活"次数（页面停摆时刷新页面上限）：重启不归零，避免无限刷新
    format: d.format,
    lastProgressAt: d.lastProgressAt, lastDone: d.lastDone, lastDoneAt: d.lastDoneAt,
    lastPing: d.lastPing,
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
