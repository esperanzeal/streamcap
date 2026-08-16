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
// 部分站点等 CDN 防盗链校验 Referer：fetch 不能设 forbidden header（referrer option 跨源会被忽略），
// 用 declarativeNetRequest session 动态规则给探测请求注入 Referer，请求完删除规则。
let dnrRuleId = 20000;
async function fetchSize(url, referer) {
  let ruleId = null;
  if (referer) {
    ruleId = ++dnrRuleId;
    let urlFilter = '*' + url.substring(0, 100) + '*'; // urlFilter 有 2048 字符限制，截断加通配
    try {
      const u = new URL(url);
      urlFilter = `*${u.host}${u.pathname}*`;
    } catch {}
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [{
          id: ruleId,
          priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }] },
          condition: { urlFilter, resourceTypes: ['xmlhttprequest', 'other'] },
        }],
      });
    } catch {}
  }
  try {
    // 尝试序列：Range(206→content-range) → HEAD(200→content-length) → GET(200→content-length)
    const attempts = [
      { headers: { Range: 'bytes=0-0' } },
      { method: 'HEAD' },
      {},
    ];
    for (const init of attempts) {
      try {
        const resp = await fetch(url, init);
        if (resp.status === 206) {
          const cr = resp.headers.get('content-range'); // bytes 0-0/123456
          const m = cr && cr.match(/\/(\d+)$/);
          if (m) return parseInt(m[1]);
        } else if (resp.status === 200) {
          const len = resp.headers.get('content-length');
          if (len) return parseInt(len);
        }
        // 其他状态（403 防盗链/非视频）：换下一个尝试
      } catch (e) {
        log('warn', `[嗅探] 大小探测失败 ${url.substring(0, 60)}: ${e.message}`);
      }
    }
  } finally {
    if (ruleId) {
      try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }); } catch {}
    }
  }
  return null;
}

// 补齐 sniffStore 里 mp4 条目的 size（GET_M3U8S 时调用，popup 打开/刷新时展示）
export async function fillSizes(store) {
  if (!store || !store.videos) return;
  const need = store.videos.filter(e => e.format === 'mp4' && e.size === undefined);
  // 并发上限 3，避免一次拉太多
  for (let i = 0; i < need.length; i += 3) {
    const chunk = need.slice(i, i + 3);
    await Promise.all(chunk.map(async e => {
      const size = await fetchSize(e.url, e.referer);
      if (size) e.size = size;
      else e.size = null; // 请求失败：显示"—"（标记已尝试，不重复请求）
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
