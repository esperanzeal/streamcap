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
    chrome.tabs.sendMessage(tab.id, { type: 'SCAN_VIDEOS' }, (resp) => {
      if (chrome.runtime.lastError || !resp?.urls) return;
      // 扫描结果写入 sniffStore（之前被丢弃 → 右键嗅探/popup 刷新无效）
      if (!sniffStore[tab.id]) sniffStore[tab.id] = { m3u8s: [], pageUrl: '', pageTitle: '' };
      sniffStore[tab.id].pageUrl = sniffStore[tab.id].pageUrl || tab.url || '';
      storeVideos(tab.id, resp.urls, resp.pageTitle || '');
    });
    openManager();
  }
});

function openManager() {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
}

// ============ 状态 ============
let nextId = Date.now();
const downloads = {};       // { id → record }
const tabQueues = {};       // { tabId → [downloadId, ...] }
const tabActive = {};       // { tabId → downloadId | null }
let sniffStore = {};        // { tabId → { m3u8s: [...], pageUrl: '' } }
let managerPorts = [];      // manager 页的长连接端口

// 日志任务标识：优先任务名（如 video.mp4），重复任务带序号，否则回退 id
function taskLabel(id) {
  const d = downloads[id];
  if (!d) return `#${id}`;
  const name = d.pageTitle ? `${d.pageTitle}.mp4` : `#${id}`;
  return d.dupIndex ? `${name} (${d.dupIndex})` : name;
}

// ============ 嗅探 ============

function guessResolution(url) {
  // 格式1：/1080p/、_1080p、-1080P、1080p.m3u8 等常见变体
  const m = url.match(/(?:\/|_|-|\.)(\d{3,4}p)(?=\/|\.|_|-|\?|$)/i);
  if (m) return m[1];
  // 格式2：宽x高，如 1920x1080 / 1280x720 / 720x1080（竖屏）。
  // 保留原始 WxH，不做 p 换算——竖屏 720x1080 若显示 1080p 会产生误导。
  // 用 / ? 或结尾做边界，避免误匹配 UUID/参数里的数字段。
  const m2 = url.match(/\/(\d{3,4})x(\d{3,4})(?=\/|\?|$)/i);
  if (m2) return `${m2[1]}x${m2[2]}`;
  return '?';
}

function isM3u8(url) {
  return /\.m3u8(\?|$)/i.test(url.split('#')[0]);
}

// 把扫描/上报的 URL 去重写入 sniffStore（只收 m3u8）
function storeVideos(tabId, urls, pageTitle) {
  if (!sniffStore[tabId]) sniffStore[tabId] = { m3u8s: [], pageUrl: '', pageTitle: '' };
  if (pageTitle) sniffStore[tabId].pageTitle = pageTitle;
  for (const url of urls) {
    if (!isM3u8(url)) continue; // 跳过非 m3u8 直链（MP4 等）
    if (!sniffStore[tabId].m3u8s.some(e => e.url === url)) {
      sniffStore[tabId].m3u8s.unshift({ url, referer: sniffStore[tabId].pageUrl, resolution: guessResolution(url), timestamp: Date.now() });
    }
  }
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
    persist(); // 立即落盘：否则 SW 空闲重启后恢复逻辑会把它当 downloading 重建，假活占槽
    broadcast({ type: 'DOWNLOAD_UPDATE', download: downloads[active] });
  }
  delete tabActive[tabId];
  delete tabQueues[tabId];
  maybeDispatch();
});

// 页面导航/刷新：content script 即将卸载，下载会中断，但任务会永远卡 downloading
// （onRemoved 只在关闭时触发，刷新/跳转不触发）。这里把进行中任务标为可续传暂停，
// 释放 tabActive，让调度器能派发其他任务；用户点"继续"即可续传。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const active = tabActive[tabId];
  if (!active || !downloads[active]) return;
  const d = downloads[active];
  if (d.status === 'downloading' || d.status === 'retrying') {
    d.status = 'paused';
    d.error = '页面刷新/跳转，可点继续续传';
    tabActive[tabId] = null;
    // 通知 content 停止下载：否则循环可能继续写 OPFS，且点"继续"时新旧循环会共用同一控制器
    chrome.tabs.sendMessage(tabId, { type: 'CANCEL_DOWNLOAD', downloadId: active }).catch(() => {});
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    log('warn', `[页面导航] ${taskLabel(active)} 因页面刷新/跳转暂停（分片已保留）`);
    maybeDispatch();
  }
});

// ============ 持久化 & 广播 ============

function persist() {
  const list = Object.values(downloads).map(d => ({
    id: d.id, url: d.url, referer: d.referer, resolution: d.resolution,
    status: d.status, pct: d.pct, done: d.done, total: d.total,
    speed: d.speed, error: d.error, createdAt: d.createdAt, tabId: d.tabId,
    fileName: d.fileName, pageTitle: d.pageTitle, dupIndex: d.dupIndex,
    retryCount: d.retryCount, consecutiveFails: d.consecutiveFails,
    lastProgressAt: d.lastProgressAt, stalledAt: d.stalledAt,
  }));
  chrome.storage.local.set({ vgp_downloads: list });
}

function broadcast(msg) {
  const str = JSON.stringify(msg);
  managerPorts.forEach(p => { try { p.postMessage(msg); } catch { /* dead */ } });
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ============ 日志（按日期分文件，存 storage.local，防爆上限 5000 条/天） ============
function todayKey() {
  const d = new Date();
  return 'vgp_logs_' +
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0'); // 本地日期；toISOString() 是 UTC，东八区凌晨会落前一天
}
function log(level, msg) {
  try {
    const now = new Date();
    const key = todayKey();
    chrome.storage.local.get(key, data => {
      const arr = data[key] || [];
      arr.push(`[${now.toLocaleTimeString()}] [${level.toUpperCase()}] ${msg}`);
      if (arr.length > 5000) arr.splice(0, arr.length - 5000);
      chrome.storage.local.set({ [key]: arr });
    });
  } catch { /* 日志失败不影响主流程 */ }
}

// 读取某天的日志（manager/logger 页用）
function getLogs(dateStr, callback) {
  const key = 'vgp_logs_' + dateStr;
  chrome.storage.local.get(key, data => callback(data[key] || []));
}

// 清空某天的日志
function clearLogs(dateStr, callback) {
  chrome.storage.local.remove('vgp_logs_' + dateStr, () => callback && callback());
}

// ============ 队列管理 ============

function enqueue(tabId, url, referer, resolution, pageUrl, pageTitle, force = false) {
  // 重复检测：同一 URL 已有未取消任务 → 除非 force 确认，否则拒绝入队
  const existing = Object.values(downloads).find(x => x.url === url && x.status !== 'cancelled');
  if (existing && !force) {
    return { ok: false, duplicate: true, existingId: existing.id, existingStatus: existing.status };
  }
  // force 双保险：2s 内同 URL 只允许 force 入队一次（防双击/重发绕过 UI 禁用产生重复任务）
  if (force && existing) {
    if (existing.createdAt && Date.now() - existing.createdAt < 2000) {
      return { ok: false, error: '该 URL 刚加入过，已忽略重复请求' };
    }
  }
  const id = nextId++;
  // 重复检测：同一 URL 已在任务列表中 → 新任务加序号（(2)、(3)...），提醒用户任务重复
  const dupIndex = Object.values(downloads).filter(x => x.url === url).length + 1;
  downloads[id] = {
    id, url, referer, resolution,
    pageUrl: pageUrl || referer || '',
    pageTitle: pageTitle || '',
    status: 'queued', pct: 0, done: 0, total: 0,
    speed: '', error: null, createdAt: Date.now(), tabId,
    fileName: '',
    dupIndex: dupIndex > 1 ? dupIndex : undefined,
    retryCount: 0, consecutiveFails: 0,
  };
  if (!tabQueues[tabId]) tabQueues[tabId] = [];
  tabQueues[tabId].push(id);
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: downloads[id] });
  log('info', `[入队] ${taskLabel(id)} ${url.substring(0, 60)}`);
  maybeDispatch();
  return { ok: true, downloadId: id };
}

async function dispatchTab(tabId, downloadId) {
  const d = downloads[downloadId];
  if (!d) return;
  d.status = 'downloading';
  d.error = null; // 下载恢复时清除历史错误提示
  if (!d.done) d.pct = 0; // 续传时保留已有进度
  d.lastProgressAt = Date.now(); // 派发即记"最后活跃"：启动/解析阶段计入宽限期，防误判停滞
  d.stalledAt = null; // 清除历史停滞标记
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
  // 停滞任务（stalledAt）按停滞时刻排到队尾最后执行，不占用优先调度位
  const candidates = [];
  for (const tid of Object.keys(tabQueues)) {
    const tabId = Number(tid);
    if (tabActive[tabId]) continue; // 该 tab 已有活动任务
    for (const did of tabQueues[tabId]) {
      const d = downloads[did];
      if (d && d.status === 'queued') candidates.push({ tabId, did, sortKey: d.stalledAt || d.createdAt || 0 });
    }
  }
  candidates.sort((a, b) => a.sortKey - b.sortKey);

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
    log('info', `[调度] 派发 ${taskLabel(c.did)} → tab${c.tabId}（并发 ${max}，活跃 ${activeCount + 1}）`);
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
// 手动恢复 = 新的尝试周期：重置连续失败计数，与单任务"继续"(ENQUEUE retryId)行为对齐
async function resumeAll() {
  const tasks = Object.values(downloads).filter(d => d.status === 'paused');
  for (const d of tasks) {
    d.status = 'queued';
    d.error = null;
    d.consecutiveFails = 0;
    d.retryCount = 0;
    d.stalledAt = null; // 手动恢复 = 新的尝试周期，回到正常 FIFO 位置
    if (!tabQueues[d.tabId]) tabQueues[d.tabId] = [];
    if (!tabQueues[d.tabId].includes(d.id)) tabQueues[d.tabId].push(d.id);
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
      // 状态守卫：正在下载/重试/导出中的任务不接受重试请求（防双击/断线重发把 downloading 打回 queued）
      if (d.status === 'downloading' || d.status === 'retrying' || d.status === 'exporting') {
        sendResponse({ ok: false, error: `任务正在${d.status === 'exporting' ? '导出' : '下载'}，无需重试` });
        return true;
      }
      if (d.status === 'completed') {
        // 已完成任务重试 = 重新下载：分片已清理，进度归零
        d.done = 0; d.pct = 0; d.total = 0; d.fileName = '';
      }
      d.status = 'queued';
      d.error = null;
      // 重试任务：重置连续失败计数与停滞标记（保留 createdAt 保持 FIFO 原位置）
      d.consecutiveFails = 0;
      d.stalledAt = null; // 手动重试 = 新的尝试周期，回到正常 FIFO 位置
      if (!tabQueues[tabId]) tabQueues[tabId] = [];
      if (!tabQueues[tabId].includes(msg.retryId)) tabQueues[tabId].push(msg.retryId);
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      maybeDispatch();
      sendResponse({ ok: true, downloadId: msg.retryId });
    } else {
      // 新下载：用当前 active tab
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const tabId = tabs[0]?.id;
        if (!tabId) { sendResponse({ ok: false, error: '无法获取标签页' }); return; }
        const r = enqueue(tabId, msg.url, msg.referer, msg.resolution, msg.pageUrl, msg.pageTitle, msg.force === true);
        if (!r.ok && r.duplicate) {
          // 重复 URL：返回重复状态，由发起方（popup/页面）弹确认框
          sendResponse({ ok: false, duplicate: true, existingId: r.existingId, existingStatus: r.existingStatus, url: msg.url });
        } else {
          sendResponse({ ok: true, downloadId: r.downloadId });
        }
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

  // 并发任务数设置变更 → 自动 全部暂停 → 全部继续，按新并发数重排任务序列
  if (msg.type === 'SET_MAX_CONCURRENT') {
    const value = msg.value;
    // 先把新值写入 storage（完成后回调），保证后续 maybeDispatch 读到的一定是新值
    chrome.storage.local.get('vgp_settings', s => {
      const merged = { ...(s.vgp_settings || {}), maxConcurrent: value };
      chrome.storage.local.set({ vgp_settings: merged }, () => {
        pauseAll().then(() => resumeAll());
      });
    });
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
      // 通知该任务所在页面清理其分片（任务已删，分片视为孤儿）
      chrome.tabs.sendMessage(d.tabId, { type: 'CLEANUP_OPFS', activeDownloadIds: Object.values(downloads).map(x => x.id) }).catch(() => {});
      broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: msg.downloadId });
    }
    sendResponse({ ok: true });
    return true;
  }

  // 全部重试：仅针对失败/取消任务，原地重置状态重新入队（保留进度续传）
  // 手动暂停（paused）的任务不在范围内——用"全部继续"恢复
  if (msg.type === 'RETRY_FAILED') {
    const targets = Object.values(downloads).filter(d => d.status === 'failed' || d.status === 'cancelled');
    for (const d of targets) {
      d.status = 'queued';
      d.error = null;
      // 保留 done 进度 → OPFS 断点续传生效；仅 completed 类重下才归零（见 ENQUEUE retryId 分支）
      d.consecutiveFails = 0;
      d.retryCount = 0;
      if (!tabQueues[d.tabId]) tabQueues[d.tabId] = [];
      if (!tabQueues[d.tabId].includes(d.id)) tabQueues[d.tabId].push(d.id);
    }
    if (targets.length > 0) {
      persist();
      targets.forEach(d => broadcast({ type: 'DOWNLOAD_UPDATE', download: d }));
      log('info', `[重试] 全部重试：${targets.length} 个失败/取消任务重新入队`);
    }
    maybeDispatch();
    sendResponse({ ok: true, count: targets.length });
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

  // 日志查询 / 清空（logger 页用）
  if (msg.type === 'GET_LOGS') {
    getLogs(msg.date, lines => sendResponse({ lines }));
    return true;
  }
  if (msg.type === 'CLEAR_LOGS') {
    clearLogs(msg.date, () => sendResponse({ ok: true }));
    return true;
  }

  // content script 请求：用 chrome.downloads 触发 blob 下载
  // 不立即标完成——等 chrome.downloads.onChanged 的 complete/interrupted 信号
  if (msg.type === 'DOWNLOAD_BLOB') {
    const { downloadId, blobUrl, filename } = msg;
    const tabId = sender.tab?.id;
    chrome.downloads.download({
      url: blobUrl,
      filename,
      saveAs: false,
      conflictAction: 'uniquify',
    }, (itemId) => {
      if (chrome.runtime.lastError || itemId === undefined) {
        // 触发失败：标记失败，不进入 exporting
        const d = downloads[downloadId];
        if (d) {
          d.status = 'failed';
          d.error = 'Chrome 下载触发失败: ' + (chrome.runtime.lastError?.message || '未知');
          persist();
          broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        }
        log('error', `[导出] ${taskLabel(downloadId)} chrome.downloads 触发失败: ${chrome.runtime.lastError?.message || '未知'}`);
        sendResponse({ ok: false });
        return;
      }
      // 记录映射：Chrome 下载项 id ↔ 扩展任务（存 session，SW 重启不丢）
      chrome.storage.session.get('blob_map', s => {
        const m = s.blob_map || {};
        m[itemId] = { downloadId, tabId, blobUrl, filename };
        chrome.storage.session.set({ blob_map: m });
      });
      // 任务进入"导出中"：等待 Chrome 下载结果信号
      const d = downloads[downloadId];
      if (d) {
        d.status = 'exporting';
        d.pct = 99;
        d.error = null;
        d.speed = ''; // 清除"合并中..."等临时文案
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      }
      log('info', `[导出] ${taskLabel(downloadId)} → Chrome 下载项 #${itemId} 开始，文件名: ${filename}`);
      sendResponse({ ok: true });
    });
    return true;
  }


  // content script 报告发现的 <video> 标签 URL
  if (msg.type === 'REPORT_VIDEO') {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    storeVideos(tabId, msg.urls, msg.pageTitle || '');
    return;
  }

  // popup/右键触发强制扫描：结果写入 sniffStore（供 popup GET_M3U8S 读取）
  if (msg.type === 'SCAN_VIDEOS') {
    const tabId = msg.tabId ?? sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false }); return; }
    chrome.tabs.sendMessage(tabId, { type: 'SCAN_VIDEOS' }, (resp) => {
      if (!chrome.runtime.lastError && resp?.urls) {
        if (!sniffStore[tabId]) sniffStore[tabId] = { m3u8s: [], pageUrl: '', pageTitle: '' };
        if (!sniffStore[tabId].pageUrl && resp.pageUrl) sniffStore[tabId].pageUrl = resp.pageUrl;
        storeVideos(tabId, resp.urls, resp.pageTitle || '');
      }
      // 等扫描结果写入后再响应，popup 才不会读到旧数据
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'PROGRESS') {
    const d = downloads[msg.downloadId];
    if (d) {
      d.pct = msg.pct; d.done = msg.done; d.total = msg.total;
      d.speed = msg.speed || '';
      d.lastProgressAt = Date.now(); // 真实下载进度，用于超时无进度判定
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    }
    return;
  }

  // content 保活心跳：下载进行中每 10s 发一次，防止 SW 空闲 30s 被 Chrome 回收
  // 注意：心跳≠进度，只说明 content 消息循环活着；下载是否推进看 lastProgressAt
  if (msg.type === 'HEARTBEAT') {
    const d = downloads[msg.downloadId];
    if (d) d.lastPing = Date.now();
    return;
  }

  if (msg.type === 'DOWNLOAD_COMPLETE') {
    const d = downloads[msg.downloadId];
    if (d) {
      d.status = 'completed';
      d.pct = 100;
      d.fileName = msg.fileName || '';
      // 下载成功：连续失败计数清零（下次失败从 0 重新计数）
      d.consecutiveFails = 0;
      d.retryCount = 0;
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
      // 终态（completed/exporting/failed）也直接忽略迟到 ERROR：content 单循环只在结束时上报一次，
      // 但用户双击重试等操作可能造成 background 状态与 content 循环不同步，防止终态被回退重下
      if (msg.error === '已取消' || (msg.error || '').includes('已取消') ||
          d.status === 'paused' || d.status === 'cancelled' || d.status === 'queued' ||
          d.status === 'completed' || d.status === 'exporting' || d.status === 'failed') {
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        return;
      }

      // 永久错误（404 / blob 丢失 / m3u8 解析失败）：重试无意义，直接失败并释放并发槽
      if (msg.permanent) {
        d.status = 'failed';
        d.error = msg.error;
        d.consecutiveFails = (d.consecutiveFails || 0) + 1;
        tabActive[d.tabId] = null;
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        log('warn', `[重试] ${taskLabel(d.id)} 永久错误，直接失败: ${msg.error}`);
        maybeDispatch();
        return;
      }

      // 自动重试：连续失败 ≤3 次才停止（排除用户操作导致的终止）
      // 计数持久化（persist 已含 consecutiveFails）→ SW 重启不归零，杜绝无限重试占槽
      const MAX_RETRY = 3;
      const fails = d.consecutiveFails || 0;
      if (fails < MAX_RETRY) {
        d.consecutiveFails = fails + 1;
        d.retryCount = (d.retryCount || 0) + 1;
        d.status = 'retrying';
        d.error = `第 ${d.consecutiveFails}/${MAX_RETRY} 次重试: ${msg.error}`;
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        // ★ 让出并发槽：退避期间其他任务可插队，避免失败任务占坑
        tabActive[d.tabId] = null;
        maybeDispatch();
        const delay = d.consecutiveFails * 3000; // 3s / 6s / 9s 退避
        log('info', `[重试] ${taskLabel(d.id)} 失败，${delay}ms 后重新排队（${d.consecutiveFails}/${MAX_RETRY}）`);
        setTimeout(() => {
          if (!downloads[d.id]) return; // 已被删除
          // 退避期间用户可能已暂停/取消/重新调度该任务：只有仍处于 retrying
          // （未被用户干预）才自动重派，避免双派发
          if (d.status !== 'retrying') return;
          d.status = 'queued';
          d.error = null;
          persist();
          broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
          // 放回原 tab 队列（保留 createdAt → FIFO 原位置），由 maybeDispatch 统一调度
          if (!tabQueues[d.tabId]) tabQueues[d.tabId] = [];
          if (!tabQueues[d.tabId].includes(d.id)) tabQueues[d.tabId].push(d.id);
          maybeDispatch();
        }, delay);
      } else {
        d.status = 'failed';
        d.error = msg.error;
        tabActive[d.tabId] = null;
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        log('warn', `[重试] ${taskLabel(d.id)} 连续失败 ${fails + 1} 次，转入失败队列`);
        maybeDispatch();
      }
    }
    return;
  }
});

// ============ Chrome 下载结果信号 ============
// DOWNLOAD_BLOB 触发的下载任务，其结果决定扩展任务最终状态：
// complete → 真正完成（文件已存盘）→ 通知 content revoke blob + 清理分片
// interrupted → 失败（blob 保留，用户可在下载管理器重试，重试成功后 complete 分支转完成）
// 注意：SW 空闲重启后 downloads 对象是异步加载的，信号可能先于加载到达。
// 若加载未完成就处理 complete 会因 d 不存在而丢信号（任务永远卡 exporting → 重下）。
// 因此：未加载完成时先把信号缓存起来，加载完成后重放。
let loaded = false;
const pendingDownloadSignals = [];

function handleDownloadSignal(delta) {
  chrome.storage.session.get('blob_map', s => {
    const m = s.blob_map || {};
    const rec = m[delta.id];
    if (!rec) return;
    const d = downloads[rec.downloadId];
    if (delta.state.current === 'complete') {
      if (!d) {
        // 加载完成后仍找不到任务 = 任务已被用户删除，丢弃映射
        delete m[delta.id];
        chrome.storage.session.set({ blob_map: m });
        return;
      }
      delete m[delta.id];
      chrome.storage.session.set({ blob_map: m });
      d.status = 'completed';
      d.pct = 100;
      d.fileName = rec.filename;
      d.speed = '';
      d.consecutiveFails = 0;
      d.retryCount = 0;
      tabActive[rec.tabId] = null;
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      log('info', `[下载器] Chrome 下载项 #${delta.id} 完成 → ${taskLabel(rec.downloadId)} 标为已完成`);
      // 通知 content：revoke blob + 清理分片
      chrome.tabs.sendMessage(rec.tabId, { type: 'FINALIZE_DOWNLOAD', downloadId: rec.downloadId, blobUrl: rec.blobUrl }).catch(() => {});
      maybeDispatch();
    } else if (delta.state.current === 'interrupted') {
      if (!d) {
        delete m[delta.id];
        chrome.storage.session.set({ blob_map: m });
        return;
      }
      // 记录 Chrome 的中断原因（FILE_FAILED=磁盘/路径，NETWORK_FAILED=blob 读取，ABORTED 等）
      const errCode = delta.error?.current || 'unknown';
      const retries = rec.retries || 0;
      if (retries < 1 && rec.blobUrl) {
        // blob 还在（页面未关闭、未 revoke）：自动重试一次，瞬时故障直接救回
        rec.retries = retries + 1;
        chrome.storage.session.set({ blob_map: m });
        log('warn', `[下载器] Chrome 下载项 #${delta.id} 中断(${errCode}) → ${taskLabel(rec.downloadId)} 自动重试导出`);
        chrome.downloads.download({
          url: rec.blobUrl,
          filename: rec.filename,
          saveAs: false,
          conflictAction: 'uniquify',
        }, (itemId2) => {
          if (chrome.runtime.lastError || itemId2 === undefined) {
            // 重试也失败：blob 可能已失效或页面已关
            d.status = 'failed';
            d.error = `Chrome 下载中断(${errCode})，重试失败: ${chrome.runtime.lastError?.message || '未知'}`;
            d.speed = '';
            tabActive[rec.tabId] = null;
            persist();
            broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
            log('error', `[下载器] ${taskLabel(rec.downloadId)} 导出重试失败: ${chrome.runtime.lastError?.message || '未知'}`);
            maybeDispatch();
          } else {
            m[itemId2] = rec;
            chrome.storage.session.set({ blob_map: m });
            log('info', `[下载器] ${taskLabel(rec.downloadId)} 导出重试 → Chrome 下载项 #${itemId2}`);
          }
        });
        return;
      }
      d.status = 'failed';
      d.error = `Chrome 下载中断(${errCode})，可在下载管理器点重试或点重试重新合并`;
      d.speed = '';
      tabActive[rec.tabId] = null;
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      log('warn', `[下载器] Chrome 下载项 #${delta.id} 中断(${errCode}) → ${taskLabel(rec.downloadId)} 标为失败（blob 保留可重试）`);
      maybeDispatch();
    } else {
      log('debug', `[下载器] Chrome 下载项 #${delta.id} 状态变化: ${delta.state.current}（未处理）`);
    }
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  if (!loaded) {
    pendingDownloadSignals.push(delta);
    return;
  }
  handleDownloadSignal(delta);
});

// ============ SW 防休眠（MV3 空闲约 30s 会被 Chrome 终止） ============
// 下载跑在 content script 里，SW 被终止本身不影响下载；但会丢失内存态，
// 且"暂停中等待调度"的队列没人唤醒（用户不操作就永远卡着——日志里 22:00-22:03
// 55 个 queued 任务干等就是证据）。用 alarms 定期唤醒 SW 重建队列 + 心跳兜底。
const KEEPALIVE_ALARM = 'vgp_keepalive';

function ensureKeepaliveAlarm() {
  chrome.alarms.get(KEEPALIVE_ALARM, a => {
    if (!a) {
      // periodInMinutes: 1 = Chrome 116 允许的最小周期；SW 空闲 30s 被杀后，
      // 最迟 1 分钟内被唤醒重建队列，避免 queued 任务无人调度。
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM) return;
  // 心跳兜底：SW 刚被唤醒时，检查 downloading 任务是否还活着。
  // 若 content 已死（页面被冻结/关闭），标为可续传暂停并让出并发槽。
  const pingers = Object.values(downloads)
    .filter(d => d.status === 'downloading')
    .map(d => pingDeadTask(d, '页面无响应（后台冻结/关闭），可点继续续传'));
  Promise.allSettled(pingers).then(() => {
    maybeDispatch(); // 队列里若有 queued 任务，趁机派发
  });

  // 无进度超时判定：下载中任务若长时间没有真实进度（PROGRESS），说明下载循环卡死
  // （fetch 挂起/页面冻结后消息循环还活着但下载不推进）。把任务标为可续传暂停、
  // 释放并发槽、记录 stalledAt 排到队尾——恢复调度后它排最后执行，不反复占槽。
  // 阈值放宽到 180s：慢网/丢包时单分片 20s 超时 × (3 首轮 + 5 补试) 可能让一次
  // mini 批次（4 分片并行）的 reportProgress 间隔逼近 100s+，后台 tab 定时器节流还会拉长。
  const now = Date.now();
  const PROGRESS_TIMEOUT = 180000; // 180s 无任何真实进度 → 判卡死
  const stalled = Object.values(downloads).filter(d => {
    if (d.status !== 'downloading') return false;
    // 刚派发（dispatchTab 已重置 lastProgressAt）的任务有完整宽限期，不会秒判
    const last = d.lastProgressAt || d.createdAt || 0;
    return now - last > PROGRESS_TIMEOUT;
  });
  for (const d of stalled) {
    // tabActive 归属校验：只有当前仍由本任务占用并发槽时才释放，避免误清该 tab 其他任务的槽
    if (tabActive[d.tabId] !== d.id) continue;
    d.status = 'paused';
    d.error = '长时间无进度，移至队列末尾，可手动继续续传';
    d.stalledAt = now; // 独立停滞时间戳：manager 排序时排在队尾，不污染 createdAt 语义
    tabActive[d.tabId] = null;
    // 通知 content 停止下载循环（防卡死循环继续空转/继续占资源）
    chrome.tabs.sendMessage(d.tabId, { type: 'CANCEL_DOWNLOAD', downloadId: d.id }).catch(() => {});
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    log('warn', `[停滞] ${taskLabel(d.id)} 无进度超过 ${PROGRESS_TIMEOUT / 1000}s，标为暂停并移至队尾`);
  }
  if (stalled.length > 0) maybeDispatch();
});

// 心跳探测：downloading 任务若 content script 已死（页面导航/刷新/冻结后无感知），
// 会永远卡 downloading 且占着并发槽。ping 无响应 → 标为可续传暂停。
// 带 tabActive 归属校验：ping 超时窗口内用户可能"暂停→继续"换过任务，
// 只有当前仍由本任务占用并发槽时才标记暂停，避免误伤刚恢复的任务。
// 并行探测 + 每任务超时：冻结的 tab 若消息不返回，不能卡住后续任务的探测。
function pingDeadTask(d, pauseReason) {
  const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ping timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
  return withTimeout(chrome.tabs.sendMessage(d.tabId, { type: 'PING' }), 2000)
    .catch(() => {
      const cur = downloads[d.id];
      // 最近 20s 内收到过 content 心跳 → content 还活着，只是 PING 消息延迟/丢失，不误伤
      if (cur && cur.lastPing && Date.now() - cur.lastPing < 20000) return;
      if (cur && cur.status === 'downloading' && tabActive[cur.tabId] === cur.id) {
        cur.status = 'paused';
        cur.error = pauseReason;
        tabActive[cur.tabId] = null;
        // 通知 content 停止下载（与 pauseDownload 对齐，防循环继续写 OPFS）
        chrome.tabs.sendMessage(cur.tabId, { type: 'CANCEL_DOWNLOAD', downloadId: cur.id }).catch(() => {});
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: cur });
        log('warn', `[心跳] ${taskLabel(cur.id)} content 无响应，标为可续传暂停`);
        maybeDispatch();
      }
    });
}

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

// SW 启动即注册保活 alarm（onInstalled 只跑一次，SW 空闲重启不触发）
ensureKeepaliveAlarm();

// ============ 恢复 ============

chrome.storage.local.get('vgp_downloads', data => {
  const list = data.vgp_downloads || [];
  for (const d of list) {
    // 清历史残留的临时文案（如"合并中..."），只在下载中/重试中保留速度
    if (d.status !== 'downloading' && d.status !== 'retrying') d.speed = '';
    downloads[d.id] = d;
  }
  if (list.length > 0) {
    nextId = Math.max(...list.map(d => d.id), Date.now()) + 1;
  }

  // 区分"浏览器重启"和"SW 空闲重启"：
  // MV3 service worker 空闲约 30s 会被 Chrome 终止、有事件再唤醒（SW 重启很频繁），
  // 但下载跑在 content script 里，SW 重启不影响下载，不能把任务误标为暂停。
  // chrome.storage.session 在浏览器重启时清空、在 SW 空闲重启时保留 → 用 marker 区分。
  chrome.storage.session.get('sw_marker', s => {
    if (s.sw_marker) {
      // SW 空闲重启：任务状态保持不变（content script 可能仍在下载）
      // 唯一例外：retrying 的退避 setTimeout 已随 SW 销毁，放回队列等待重新调度
      for (const d of list) {
        if (d.status === 'retrying') { d.status = 'queued'; d.error = null; }
      }
    } else {
      // 浏览器重启：下载进程已断开，置为可续传暂停
      chrome.storage.session.set({ sw_marker: true });
      for (const d of list) {
        if (d.status === 'downloading' || d.status === 'retrying') {
          d.status = 'paused';
          d.error = '扩展重启，可重试续传';
        } else if (d.status === 'exporting') {
          // 导出中：blob 已随页面销毁，Chrome 下载任务也已中断
          // （文件可能已部分/完整保存到下载目录，请先检查再决定是否重下）
          d.status = 'failed';
          d.error = '浏览器重启，请检查下载目录是否已保存，未完成再重新下载';
        }
      }
    }

    // ★ 重建内存队列/活跃表：SW 重启后全局 tabQueues/tabActive 已清空，
    //   若不重建，queued 任务永远不会被 maybeDispatch 派发（任务卡死等待队列）
    for (const d of list) {
      if (d.status === 'queued') {
        if (!tabQueues[d.tabId]) tabQueues[d.tabId] = [];
        if (!tabQueues[d.tabId].includes(d.id)) tabQueues[d.tabId].push(d.id);
      } else if (d.status === 'downloading' || d.status === 'exporting' || d.status === 'retrying') {
        tabActive[d.tabId] = d.id;
      }
    }
    persist();
    log('info', `[恢复] ${s.sw_marker ? 'SW 空闲重启' : '浏览器重启'}，重建队列 queued=${list.filter(d => d.status === 'queued').length}，活跃=${Object.keys(tabActive).length}`);

    // downloads 加载完成：重放 SW 休眠期间缓存的下载信号（防止 complete 信号丢失）
    loaded = true;
    for (const sig of pendingDownloadSignals.splice(0)) handleDownloadSignal(sig);

    maybeDispatch();

    // 心跳兜底：downloading 任务若 content script 已死（页面导航/刷新/冻结后无感知），
    // 会永远卡 downloading 且占着并发槽。这里逐个 ping，无响应 → 标为可续传暂停。
    (async () => {
      const pingers = Object.values(downloads)
        .filter(d => d.status === 'downloading')
        .map(d => pingDeadTask(d, '页面已无响应，可点继续续传'));
      await Promise.allSettled(pingers);
    })();

    // 启动兜底清理：通知所有打开的页面删除孤儿分片（不属于任何活跃任务的分片）
    const activeIds = list.map(d => d.id);
    chrome.tabs.query({}, tabs => {
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, { type: 'CLEANUP_OPFS', activeDownloadIds: activeIds }).catch(() => {});
      }
    });
  });
});
