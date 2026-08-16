// sniffing.js — StreamCap 嗅探（webRequest + video 扫描兜底 + tab 事件 + 右键菜单）
import { state, persist, broadcast, taskLabel } from './state.js';
import { maybeDispatch } from './scheduler.js';
import { log } from './log.js';
import { detectFormat, FORMAT_LABEL } from './formats.js';

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

// 把扫描/上报的 URL 去重写入 sniffStore（收 hls/dash/mp4/flv，条目带 format）
export function storeVideos(tabId, urls, pageTitle) {
  if (!state.sniffStore[tabId]) state.sniffStore[tabId] = { videos: [], pageUrl: '', pageTitle: '' };
  if (pageTitle) state.sniffStore[tabId].pageTitle = pageTitle;
  for (const url of urls) {
    const fmt = detectFormat(url);
    if (fmt === 'unknown') continue; // 跳过无法识别的资源
    if (!state.sniffStore[tabId].videos.some(e => e.url === url)) {
      state.sniffStore[tabId].videos.unshift({
        url, format: fmt,
        referer: state.sniffStore[tabId].pageUrl,
        resolution: guessResolution(url),
        timestamp: Date.now(),
      });
    }
  }
  if (state.sniffStore[tabId].videos.length > 30) state.sniffStore[tabId].videos = state.sniffStore[tabId].videos.slice(0, 30);
}

// ============ 文件大小探测（MP4 直链用 Range 请求拿 Content-Range 总大小） ============
// 只对 mp4 直链有意义（HLS/DASH 是分片流，playlist 大小不代表视频大小）。
// 由视频页面的 content script 发请求：页面上下文浏览器自动带 Referer + Cookie，
// 且 部分站点等 CDN 允许同源页面 fetch（播放分片就靠它）——background 的 fetch/DNR
// 注入 Referer 都不可靠（forbidden header / DNR 不命中 background 请求）。
async function fetchSize(url, tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { type: 'FETCH_SIZE', url });
    return resp && resp.size ? resp.size : null;
  } catch {
    return null; // 页面已关闭/无 content：无法探测
  }
}

// 补齐 sniffStore 里 mp4 条目的 size（GET_M3U8S 时调用，popup 打开/刷新时展示）
export async function fillSizes(store, tabId) {
  if (!store || !store.videos || !tabId) return;
  const need = store.videos.filter(e => e.format === 'mp4' && e.size === undefined);
  // 并发上限 3，避免一次拉太多
  for (let i = 0; i < need.length; i += 3) {
    const chunk = need.slice(i, i + 3);
    await Promise.all(chunk.map(async e => {
      const size = await fetchSize(e.url, tabId);
      e.size = size || null; // null 显示"—"（页面关闭/获取失败）
    }));
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
      if (!state.sniffStore[tab.id]) state.sniffStore[tab.id] = { videos: [], pageUrl: '', pageTitle: '' };
      state.sniffStore[tab.id].pageUrl = state.sniffStore[tab.id].pageUrl || tab.url || '';
      storeVideos(tab.id, resp.urls, resp.pageTitle || '');
    });
    openManager();
  }
});

export function openManager() {
  chrome.tabs.create({ url: chrome.runtime.getURL('manager/manager.html') });
}

// ============ webRequest 嗅探（URL 后缀） ============
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const { url, tabId, requestHeaders } = details;
    if (tabId < 0) return;

    let referer = '';
    for (const h of requestHeaders || []) {
      if (h.name.toLowerCase() === 'referer') { referer = h.value; break; }
    }

    if (!state.sniffStore[tabId]) state.sniffStore[tabId] = { videos: [], pageUrl: '' };

    // 按后缀识别 hls/dash/mp4/flv，去重（mp4 可能误报多，但加入下载前可筛选）
    const fmt = detectFormat(url);
    if (fmt !== 'unknown' && !state.sniffStore[tabId].videos.some(e => e.url === url)) {
      state.sniffStore[tabId].videos.unshift({
        url, referer, format: fmt,
        resolution: guessResolution(url),
        timestamp: Date.now(),
      });
      if (state.sniffStore[tabId].videos.length > 30) state.sniffStore[tabId].videos.pop();
    }
    if (!state.sniffStore[tabId].pageUrl && referer) {
      state.sniffStore[tabId].pageUrl = referer;
    }
  },
  { urls: ['*://*/*.m3u8*', '*://*/*.mpd*', '*://*/*.mp4*', '*://*/*.flv*'] },
  ['requestHeaders']
);

// 兜底：按 Content-Type 嗅探无扩展名/动态 URL 的视频流
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const { url, tabId } = details;
    if (tabId < 0) return;

    const ct = (details.responseHeaders || []).find(
      h => h.name.toLowerCase() === 'content-type'
    );
    const fmt = detectFormat(url, ct?.value || '');
    if (fmt === 'unknown') return; // 后缀 + Content-Type 都识别不出

    // 有明确后缀的已由上面的 listener 处理（m3u8/mpd/mp4/flv），这里只补无后缀但 Content-Type 明确的
    if (detectFormat(url) !== 'unknown') return;

    if (!state.sniffStore[tabId]) state.sniffStore[tabId] = { videos: [], pageUrl: '' };
    if (state.sniffStore[tabId].videos.some(e => e.url === url)) return;

    state.sniffStore[tabId].videos.unshift({
      url,
      referer: state.sniffStore[tabId].pageUrl || '',
      format: fmt,
      resolution: guessResolution(url),
      timestamp: Date.now(),
    });
    if (state.sniffStore[tabId].videos.length > 30) state.sniffStore[tabId].videos.pop();
  },
  { urls: ['<all_urls>'], types: ['xmlhttprequest', 'media'] },
  ['responseHeaders']
);

// ============ 视频响应注入 CORS 头 ============
// 部分无扩展名 CDN 等无扩展名 CDN（/stream?t=）不返回 Access-Control-Allow-Origin，
// 页面上下文 content fetch 被 CORS 拦截（Failed to fetch）。cors_rules.json 只按
// URL 扩展名（.mp4/.ts/.m4s）注入，覆盖不到这类。这里按响应 Content-Type 兜底：
// 任何视频流响应（video/*、mpegurl、dash+xml 或 URL 后缀是视频格式）都注入 CORS 头。
const VIDEO_CT = ['video/', 'application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'application/dash+xml'];
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    const headers = details.responseHeaders;
    // preflight OPTIONS：Range 头不在 CORS safelist，带 Range 的 fetch 会先发 OPTIONS 预检。
    // 必须给预检响应注入 Allow-Origin/Methods/Headers，否则预检失败 → fetch 报 Failed to fetch。
    if (details.method === 'OPTIONS') {
      if (headers.some(h => h.name.toLowerCase() === 'access-control-allow-origin')) return;
      headers.push({ name: 'Access-Control-Allow-Origin', value: '*' });
      headers.push({ name: 'Access-Control-Allow-Methods', value: 'GET, HEAD, OPTIONS' });
      headers.push({ name: 'Access-Control-Allow-Headers', value: 'Range, Referer, Content-Type' });
      return { responseHeaders: headers };
    }
    // 视频响应：注入 CORS 头（DNR 扩展名规则的 Content-Type 兜底）
    const ct = headers.find(h => h.name.toLowerCase() === 'content-type');
    const v = (ct?.value || '').toLowerCase();
    const isVideo = VIDEO_CT.some(p => v.includes(p)) || detectFormat(details.url) !== 'unknown';
    if (!isVideo) return;
    if (headers.some(h => h.name.toLowerCase() === 'access-control-allow-origin')) return;
    headers.push({ name: 'Access-Control-Allow-Origin', value: '*' });
    return { responseHeaders: headers };
  },
  { urls: ['<all_urls>'] },
  ['blocking', 'responseHeaders']
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
  // ★ 该 tab 队列里所有 queued 任务也标 failed（页面已关闭无法下载）：
  //   否则 delete tabQueues 后任务还停留在 queued 状态，成为"不在任何队列的孤儿"，
  //   并发槽空着也永远不会被 maybeDispatch 派发（用户手动点开始才暴露"注入失败"）。
  const q = state.tabQueues[tabId];
  if (q) {
    for (const did of q) {
      const d = state.downloads[did];
      if (d && d.status === 'queued') {
        d.status = 'failed';
        d.error = '页面已关闭';
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      }
    }
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
