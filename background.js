// background.js — StreamCap v3
// webRequest 嗅探 + 下载队列 + 消息路由

// ============ 右键菜单 ============
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'vgp_sniff',
    title: 'StreamCap: 嗅探此页面视频',
    contexts: ['page'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'vgp_sniff' && tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'SCAN_VIDEOS' }, () => {
      if (chrome.runtime.lastError) return;
    });
    openManager();
  }
});

// ============ 状态 ============
let nextId = Date.now();
const downloads = {};       // { id → record }
const tabQueues = {};       // { tabId → [downloadId, ...] }
const tabActive = {};       // { tabId → downloadId | null }
let sniffStore = {};        // { tabId → { m3u8s: [...], pageUrl: '' } }
let managerPorts = [];      // manager 页的长连接端口

// ============ 嗅探 ============

function guessResolution(url) {
  const m = url.match(/\/(\d{3,4}p)\//);
  return m ? m[1] : '?';
}

function isM3u8(url) {
  return /\.m3u8(\?|$)/i.test(url.split('#')[0]);
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const { url, tabId, requestHeaders } = details;
    if (tabId < 0) return;

    let referer = '';
    for (const h of requestHeaders || []) {
      if (h.name.toLowerCase() === 'referer') { referer = h.value; break; }
    }

    if (!sniffStore[tabId]) sniffStore[tabId] = { m3u8s: [], pageUrl: '' };

    // 只存 m3u8，去重
    if (isM3u8(url) && !sniffStore[tabId].m3u8s.some(e => e.url === url)) {
      sniffStore[tabId].m3u8s.unshift({
        url, referer,
        resolution: guessResolution(url),
        timestamp: Date.now(),
      });
      if (sniffStore[tabId].m3u8s.length > 30) sniffStore[tabId].m3u8s.pop();
    }
    if (!sniffStore[tabId].pageUrl && referer) {
      sniffStore[tabId].pageUrl = referer;
    }
  },
  { urls: ['*://*/*.m3u8*', '*://*/*.m3u8?*'] },
  ['requestHeaders']
);

// 兜底：按 Content-Type 嗅探无扩展名的 m3u8 URL
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { url, tabId } = details;
    if (tabId < 0 || isM3u8(url)) return; // 已被上面的 listener 处理

    const ct = (details.responseHeaders || []).find(
      h => h.name.toLowerCase() === 'content-type'
    );
    if (!ct || !ct.value) return;

    const isHls =
      ct.value.includes('application/vnd.apple.mpegurl') ||
      ct.value.includes('application/x-mpegurl') ||
      ct.value.includes('audio/mpegurl');

    if (!isHls) return;

    if (!sniffStore[tabId]) sniffStore[tabId] = { m3u8s: [], pageUrl: '' };
    if (sniffStore[tabId].m3u8s.some(e => e.url === url)) return;

    sniffStore[tabId].m3u8s.unshift({
      url,
      referer: sniffStore[tabId].pageUrl || '',
      resolution: guessResolution(url),
      timestamp: Date.now(),
    });
    if (sniffStore[tabId].m3u8s.length > 30) sniffStore[tabId].m3u8s.pop();
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  delete sniffStore[tabId];
  const active = tabActive[tabId];
  if (active && downloads[active]) {
    downloads[active].status = 'failed';
    downloads[active].error = '页面已关闭';
    broadcast({ type: 'DOWNLOAD_UPDATE', download: downloads[active] });
  }
  delete tabActive[tabId];
  delete tabQueues[tabId];
  maybeDispatch();
});

// ============ 持久化 & 广播 ============

function persist() {
  const list = Object.values(downloads).map(d => ({
    id: d.id, url: d.url, referer: d.referer, resolution: d.resolution,
    status: d.status, pct: d.pct, done: d.done, total: d.total,
    speed: d.speed, error: d.error, createdAt: d.createdAt, tabId: d.tabId,
    fileName: d.fileName, pageTitle: d.pageTitle,
  }));
  chrome.storage.local.set({ vgp_downloads: list });
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  managerPorts.forEach(p => { try { p.postMessage(msg); } catch { /* dead */ } });
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ============ 队列管理 ============

function enqueue(tabId, url, referer, resolution, pageUrl, pageTitle) {
  const id = nextId++;
  downloads[id] = {
    id, url, referer, resolution,
    pageUrl: pageUrl || referer || '',
    pageTitle: pageTitle || '',
    status: 'queued', pct: 0, done: 0, total: 0,
    speed: '', error: null, createdAt: Date.now(), tabId,
    fileName: '',
  };
  if (!tabQueues[tabId]) tabQueues[tabId] = [];
  tabQueues[tabId].push(id);
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: downloads[id] });
  maybeDispatch();
  return id;
}

async function dispatchTab(tabId, downloadId) {
  const d = downloads[downloadId];
  if (!d) return;
  d.status = 'downloading';
  if (!d.done) d.pct = 0; // 续传时保留已有进度
  tabActive[tabId] = downloadId;
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });

  const resumeFrom = d.done || 0;
  const settings = await chrome.storage.local.get('vgp_settings');
  const concurrency = (settings.vgp_settings && settings.vgp_settings.concurrency) || 4;
  const payload = {
    type: 'START_DOWNLOAD',
    downloadId,
    m3u8Url: d.url,
    resumeFrom,
    concurrency,
    referer: d.referer || '',
    pageTitle: d.pageTitle || '',
  };

  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch (err) {
    // content script 未注入 → 尝试注入
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
      await chrome.tabs.sendMessage(tabId, payload);
    } catch (err2) {
      d.status = 'failed';
      d.error = '注入失败: ' + err2.message;
      tabActive[tabId] = null;
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      maybeDispatch();
    }
  }
}

function dequeueNext(tabId) {
  // 已废弃：改为全局并发调度 maybeDispatch()
  maybeDispatch();
}

// 读取并发任务数（0=无上限）。注意：必须用 undefined 判断，不能用 ||（0 会被吞）
async function getMaxConcurrent() {
  const s = await chrome.storage.local.get('vgp_settings');
  const v = s.vgp_settings && s.vgp_settings.maxConcurrent;
  return (v === undefined || v === null) ? 4 : v;
}

// 全局并发调度：最多同时跑 maxConcurrent 个任务（0=无上限），每个 tab 至多 1 个
// 按任务创建时间排序推进（FIFO 优先级）
async function maybeDispatch() {
  const max = await getMaxConcurrent();
  const unlimited = max === 0;
  const activeCount = Object.keys(tabActive).filter(t => tabActive[t]).length;
  if (!unlimited && activeCount >= max) return;

  // 收集所有可派发的候选（排队中且所在 tab 空闲），按创建时间排序
  const candidates = [];
  for (const tid of Object.keys(tabQueues)) {
    const tabId = Number(tid);
    if (tabActive[tabId]) continue; // 该 tab 已有活动任务
    for (const did of tabQueues[tabId]) {
      const d = downloads[did];
      if (d && d.status === 'queued') candidates.push({ tabId, did, createdAt: d.createdAt });
    }
  }
  candidates.sort((a, b) => a.createdAt - b.createdAt);

  let slots = unlimited ? Infinity : (max - activeCount);
  for (const c of candidates) {
    if (slots <= 0) break;
    if (tabActive[c.tabId]) continue; // 前面派发已占用该 tab
    const q = tabQueues[c.tabId];
    const idx = q.indexOf(c.did);
    if (idx < 0) continue;
    q.splice(idx, 1);
    dispatchTab(c.tabId, c.did);
    slots--;
  }
}

// 全部暂停：所有活跃/排队任务 → paused（保留分片），供用户手动重新分配并发
async function pauseAll() {
  const tasks = Object.values(downloads).filter(d =>
    d.status === 'downloading' || d.status === 'retrying' || d.status === 'queued'
  );
  for (const d of tasks) pauseDownload(d.id);
  maybeDispatch();
}

// 全部继续：所有暂停任务重新入队，由并发限制决定启动数量
async function resumeAll() {
  const tasks = Object.values(downloads).filter(d => d.status === 'paused');
  for (const d of tasks) {
    d.status = 'queued';
    d.error = null;
    if (!tabQueues[d.tabId]) tabQueues[d.tabId] = [];
    tabQueues[d.tabId].push(d.id);
  }
  persist();
  tasks.forEach(d => broadcast({ type: 'DOWNLOAD_UPDATE', download: d }));
  maybeDispatch();
}

function pauseDownload(downloadId) {
  const d = downloads[downloadId];
  if (!d) return;
  const tabId = d.tabId;
  if (d.status === 'queued') {
    const q = tabQueues[tabId] || [];
    const i = q.indexOf(downloadId);
    if (i >= 0) q.splice(i, 1);
    d.status = 'paused';
  } else if (d.status === 'downloading' || d.status === 'retrying') {
    d.status = 'paused';
    tabActive[tabId] = null;
    // 暂停：分片保留在 OPFS，可随时续传
    chrome.tabs.sendMessage(tabId, { type: 'CANCEL_DOWNLOAD', downloadId }).catch(() => {});
    maybeDispatch();
  }
  d.error = '已暂停，点击继续恢复';
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
}

function cancelDownload(downloadId) {
  const d = downloads[downloadId];
  if (!d) return;
  const tabId = d.tabId;
  if (d.status === 'queued') {
    d.status = 'cancelled';
    const q = tabQueues[tabId] || [];
    const i = q.indexOf(downloadId);
    if (i >= 0) q.splice(i, 1);
  } else if (d.status === 'downloading' || d.status === 'retrying') {
    d.status = 'cancelled';
    tabActive[tabId] = null;
    // 取消：分片同样保留在 OPFS（浏览器退出时自动清理），可续传
    chrome.tabs.sendMessage(tabId, { type: 'CANCEL_DOWNLOAD', downloadId }).catch(() => {});
    maybeDispatch();
  }
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
}

// ============ 消息路由 ============

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 嗅探查询
  if (msg.type === 'GET_M3U8S') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      sendResponse(sniffStore[tabs[0]?.id] || { m3u8s: [], pageUrl: '' });
    });
    return true;
  }

  // 清空嗅探
  if (msg.type === 'CLEAR_SNIFF') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (sniffStore[tabs[0]?.id]) sniffStore[tabs[0]?.id].m3u8s = [];
      sendResponse({ ok: true });
    });
    return true;
  }

  // 入队
  if (msg.type === 'ENQUEUE') {
    if (msg.retryId && downloads[msg.retryId]) {
      // 重试：优先用 manager 传来的 tabId，fallback 到 active tab
      const d = downloads[msg.retryId];
      const tabId = msg.tabId || d.tabId;
      d.status = 'queued';
      d.error = null;
      if (!tabQueues[tabId]) tabQueues[tabId] = [];
      tabQueues[tabId].push(msg.retryId);
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      maybeDispatch();
      sendResponse({ ok: true, downloadId: msg.retryId });
    } else {
      // 新下载：用当前 active tab
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const tabId = tabs[0]?.id;
        if (!tabId) { sendResponse({ ok: false, error: '无法获取标签页' }); return; }
        const id = enqueue(tabId, msg.url, msg.referer, msg.resolution, msg.pageUrl, msg.pageTitle);
        sendResponse({ ok: true, downloadId: id });
      });
    }
    return true;
  }

  // 取消
  if (msg.type === 'CANCEL') {
    cancelDownload(msg.downloadId);
    sendResponse({ ok: true });
    return true;
  }

  // 暂停（保留进度，可续传）
  if (msg.type === 'PAUSE') {
    pauseDownload(msg.downloadId);
    sendResponse({ ok: true });
    return true;
  }

  // 并发任务数设置变更 → 保存即可，用户手动 全部暂停→全部继续 后生效
  if (msg.type === 'SET_MAX_CONCURRENT') {
    maybeDispatch();
    sendResponse({ ok: true });
    return true;
  }

  // 全部暂停 / 全部继续
  if (msg.type === 'PAUSE_ALL') {
    pauseAll();
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'RESUME_ALL') {
    resumeAll();
    sendResponse({ ok: true });
    return true;
  }

  // 删除
  if (msg.type === 'DELETE_DOWNLOAD') {
    const d = downloads[msg.downloadId];
    if (d) {
      if (d.status === 'downloading') cancelDownload(msg.downloadId);
      delete downloads[msg.downloadId];
      persist();
      broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: msg.downloadId });
    }
    sendResponse({ ok: true });
    return true;
  }

  // 获取所有下载
  if (msg.type === 'GET_DOWNLOADS') {
    sendResponse(Object.values(downloads));
    return true;
  }

  // 打开管理器
  if (msg.type === 'OPEN_MANAGER') {
    chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
    sendResponse({ ok: true });
    return true;
  }

  // ── content script 回报 ──

  // content script 报告发现的 <video> 标签 URL
  if (msg.type === 'REPORT_VIDEO') {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    if (!sniffStore[tabId]) sniffStore[tabId] = { m3u8s: [], pageUrl: '', pageTitle: '' };
    if (msg.pageTitle) sniffStore[tabId].pageTitle = msg.pageTitle;
    for (const url of msg.urls) {
      if (!isM3u8(url)) continue; // 跳过非 m3u8 直链（MP4 等）
      if (!sniffStore[tabId].m3u8s.some(e => e.url === url)) {
        sniffStore[tabId].m3u8s.unshift({ url, referer: sniffStore[tabId].pageUrl, resolution: guessResolution(url), timestamp: Date.now() });
      }
    }
    return;
  }

  if (msg.type === 'PROGRESS') {
    const d = downloads[msg.downloadId];
    if (d) {
      d.pct = msg.pct; d.done = msg.done; d.total = msg.total;
      d.speed = msg.speed || '';
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    }
    return;
  }

  if (msg.type === 'DOWNLOAD_COMPLETE') {
    const d = downloads[msg.downloadId];
    if (d) {
      d.status = 'completed';
      d.pct = 100;
      d.fileName = msg.fileName || '';
      tabActive[d.tabId] = null;
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      maybeDispatch();
    }
    return;
  }

  if (msg.type === 'DOWNLOAD_ERROR') {
    const d = downloads[msg.downloadId];
    if (d) {
      if (msg.done !== undefined) d.done = msg.done;
      if (msg.total !== undefined) d.total = msg.total;

      // 用户操作或调度器中止的任务（已取消/已暂停/已放回队列）：保留状态，不自动重试、不覆盖
      if (msg.error === '已取消' || d.status === 'paused' || d.status === 'cancelled' || d.status === 'queued') {
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        return;
      }

      // 自动重试：连续失败 ≤3 次才停止（排除用户操作导致的终止）
      const MAX_RETRY = 3;
      const retries = d.retryCount || 0;
      if (retries < MAX_RETRY && msg.error !== '已取消') {
        d.retryCount = retries + 1;
        d.status = 'retrying';
        d.error = `第 ${d.retryCount}/${MAX_RETRY} 次重试: ${msg.error}`;
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        const delay = d.retryCount * 3000; // 3s / 6s / 9s 退避
        setTimeout(() => {
          if (!downloads[d.id]) return; // 已被删除
          d.status = 'queued';
          persist();
          broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
          dispatchTab(d.tabId, d.id);
        }, delay);
      } else {
        d.status = 'failed';
        d.error = msg.error;
        tabActive[d.tabId] = null;
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        maybeDispatch();
      }
    }
    return;
  }
});

// ============ Manager 长连接 ============

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'manager') {
    managerPorts.push(port);
    // 推送当前状态
    port.postMessage({ type: 'INIT', downloads: Object.values(downloads) });
    port.onDisconnect.addListener(() => {
      managerPorts = managerPorts.filter(p => p !== port);
    });
  }
});

// ============ 恢复 ============

chrome.storage.local.get('vgp_downloads', data => {
  const list = data.vgp_downloads || [];
  for (const d of list) {
    if (d.status === 'downloading' || d.status === 'retrying') {
      d.status = 'paused';
      d.error = '扩展重启，可重试续传';
    } else if (d.status === 'queued') {
      d.status = 'queued'; // 保持队列状态
    }
    downloads[d.id] = d;
  }
  if (list.length > 0) {
    nextId = Math.max(...list.map(d => d.id), Date.now()) + 1;
  }
});
