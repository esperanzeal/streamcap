// sniffing.js — StreamCap 嗅探（webRequest + video 扫描兜底 + tab 事件 + 右键菜单）
import { state, persist, broadcast, taskLabel } from './state.js';
import { maybeDispatch } from './scheduler.js';
import { log } from './log.js';

export function guessResolution(url) {
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

export function isM3u8(url) {
  return /\.m3u8(\?|$)/i.test(url.split('#')[0]);
}

// 把扫描/上报的 URL 去重写入 sniffStore（只收 m3u8）
export function storeVideos(tabId, urls, pageTitle) {
  if (!state.sniffStore[tabId]) state.sniffStore[tabId] = { m3u8s: [], pageUrl: '', pageTitle: '' };
  if (pageTitle) state.sniffStore[tabId].pageTitle = pageTitle;
  for (const url of urls) {
    if (!isM3u8(url)) continue; // 跳过非 m3u8 直链（MP4 等）
    if (!state.sniffStore[tabId].m3u8s.some(e => e.url === url)) {
      state.sniffStore[tabId].m3u8s.unshift({ url, referer: state.sniffStore[tabId].pageUrl, resolution: guessResolution(url), timestamp: Date.now() });
    }
  }
}

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
      if (!state.sniffStore[tab.id]) state.sniffStore[tab.id] = { m3u8s: [], pageUrl: '', pageTitle: '' };
      state.sniffStore[tab.id].pageUrl = state.sniffStore[tab.id].pageUrl || tab.url || '';
      storeVideos(tab.id, resp.urls, resp.pageTitle || '');
    });
    openManager();
  }
});

export function openManager() {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
}

// ============ webRequest 嗅探 ============
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const { url, tabId, requestHeaders } = details;
    if (tabId < 0) return;

    let referer = '';
    for (const h of requestHeaders || []) {
      if (h.name.toLowerCase() === 'referer') { referer = h.value; break; }
    }

    if (!state.sniffStore[tabId]) state.sniffStore[tabId] = { m3u8s: [], pageUrl: '' };

    // 只存 m3u8，去重
    if (isM3u8(url) && !state.sniffStore[tabId].m3u8s.some(e => e.url === url)) {
      state.sniffStore[tabId].m3u8s.unshift({
        url, referer,
        resolution: guessResolution(url),
        timestamp: Date.now(),
      });
      if (state.sniffStore[tabId].m3u8s.length > 30) state.sniffStore[tabId].m3u8s.pop();
    }
    if (!state.sniffStore[tabId].pageUrl && referer) {
      state.sniffStore[tabId].pageUrl = referer;
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

    if (!state.sniffStore[tabId]) state.sniffStore[tabId] = { m3u8s: [], pageUrl: '' };
    if (state.sniffStore[tabId].m3u8s.some(e => e.url === url)) return;

    state.sniffStore[tabId].m3u8s.unshift({
      url,
      referer: state.sniffStore[tabId].pageUrl || '',
      resolution: guessResolution(url),
      timestamp: Date.now(),
    });
    if (state.sniffStore[tabId].m3u8s.length > 30) state.sniffStore[tabId].m3u8s.pop();
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest'] },
  ['responseHeaders']
);

chrome.tabs.onRemoved.addListener((tabId) => {
  delete state.sniffStore[tabId];
  const active = state.tabActive[tabId];
  if (active && state.downloads[active]) {
    state.downloads[active].status = 'failed';
    state.downloads[active].error = '页面已关闭';
    persist(); // 立即落盘：否则 SW 空闲重启后恢复逻辑会把它当 downloading 重建，假活占槽
    broadcast({ type: 'DOWNLOAD_UPDATE', download: state.downloads[active] });
  }
  delete state.tabActive[tabId];
  delete state.tabQueues[tabId];
  maybeDispatch();
});

// 页面导航/刷新：content script 即将卸载，下载会中断，但任务会永远卡 downloading
// （onRemoved 只在关闭时触发，刷新/跳转不触发）。这里把进行中任务标为可续传暂停，
// 释放 tabActive，让调度器能派发其他任务；用户点"继续"即可续传。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  const active = state.tabActive[tabId];
  if (!active || !state.downloads[active]) return;
  const d = state.downloads[active];
  if (d.status === 'downloading' || d.status === 'retrying') {
    d.status = 'paused';
    d.error = '页面刷新/跳转，可点继续续传';
    state.tabActive[tabId] = null;
    // 通知 content 停止下载：否则循环可能继续写 OPFS，且点"继续"时新旧循环会共用同一控制器
    chrome.tabs.sendMessage(tabId, { type: 'CANCEL_DOWNLOAD', downloadId: active, reason: 'navigation' }).catch(() => {});
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    log('warn', `[页面导航] ${taskLabel(active)} 因页面刷新/跳转暂停（分片已保留）`);
    maybeDispatch();
  }
});
