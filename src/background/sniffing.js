// sniffing.js — StreamCap 嗅探（webRequest + video 扫描兜底 + tab 事件 + 右键菜单）
import { state, persist, broadcast, taskLabel } from './state.js';
import { maybeDispatch } from './scheduler.js';
import { queueTask, onTaskSettled } from './pool.js';
import { log } from './log.js';
import { detectFormat } from './formats.js';

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
// 且部分 CDN 允许同源页面 fetch（播放分片就靠它）——background 的 fetch/DNR
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
      // 仅成功拿到数值才写入；失败保持 undefined → 下次打开 popup 会重试
      //（原实现写 null 后固定显示 "—" 且通过 size===undefined 判断不再重试）
      if (typeof size === 'number' && size > 0) e.size = size;
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

// ============ 无后缀 CDN 的 CORS 兜底（已移除） ============
// 曾用 webRequest blocking 注入兜底无扩展名 CDN（/stream?t=）的 CORS 头，但 MV3 下
// webRequestBlocking 仅对强制安装（policy）的扩展可用——开发者模式加载时报
// "'webRequestBlocking' requires manifest version of 2 or lower."，该 listener
// 从未生效（且若注册抛错会中断本文件顶层，导致后面的 tabs.onRemoved/onUpdated
// 监听器不注册 → 关页清理失效）。CORS 现改由 manifest 的 declarativeNetRequest
// 静态规则（cors_rules.json）稳定注入，不依赖 SW/blocking。
// 能力边界：无后缀 CDN（URL 无媒体扩展名）DNR 按 urlFilter 覆盖不到，不支持。

chrome.tabs.onRemoved.addListener((tabId) => {
  delete state.sniffStore[tabId];
  const active = state.tabActive[tabId];
  if (active && state.downloads[active]) {
    const d = state.downloads[active];
    // ★ 承载页被关 ≠ 任务失败。旧逻辑直接判 failed('页面已关闭')，同属"没有承载页兜底"时代：
    //   那时页面没了任务就真的跑不完，只能判死。现在交还调度就够了 —— acquireTabFor 会复用
    //   其它同源页、或**新建一个**（也是用户明确要的行为：找不到宿主就自动开新页）。
    //   exporting 特殊：blob 随页面销毁而失效 → 回队列后重新合并导出（分片已保留）。
    if (d.status === 'downloading' || d.status === 'retrying' || d.status === 'exporting') {
      const wasExporting = d.status === 'exporting';
      d.status = 'queued';
      d.error = wasExporting ? '页面关闭打断了导出，正在自动重新合并导出（分片已保留）' : null;
      onTaskSettled(d); // 释放并发槽 + 归还承载页（内部 pump 一次）
      queueTask(d.id);  // 交还调度：pump 会 acquireTabFor 复用/新建同源承载页
      log('warn', `[页面] ${taskLabel(d.id)} 承载页被关闭 → 交还调度，自动复用/新建同源承载页`);
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    }
  }
  // v5：queued 任务不再绑定某个 tab（tab 只是承载页）→ tab 关闭不需要把它们标失败，
  //     调度器下一轮 pump 会给它们复用/新建承载页。
  delete state.tabActive[tabId];
  delete state.tabPool[tabId];
  maybeDispatch();
});

// 页面导航/刷新：content script 即将卸载，下载会中断，但任务会永远卡 downloading
// （onRemoved 只在关闭时触发，刷新/跳转不触发）。这里把进行中任务标为可续传暂停，
// 释放 tabActive，让调度器能派发其他任务；用户点"继续"即可续传。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // ★ 页面加载完成：若该页承载的任务在导航期间被打断（导出中 → blob 已失效），现在重做。
  //   必须等 complete —— loading 阶段派发会因为 content 未就绪而失败。
  if (changeInfo.status === 'complete') {
    const pend = Object.values(state.downloads).find(x => x.tabId === tabId && x.restartOnNav);
    if (pend) {
      delete pend.restartOnNav;
      pend.status = 'queued';
      pend.error = '页面刷新/跳转打断了导出，正在重新合并导出（分片已保留）';
      queueTask(pend.id);
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: pend });
      log('warn', `[页面导航] 页面已就绪 → 重新驱动 ${taskLabel(pend.id)} 重新合并导出`);
      maybeDispatch();
    }
    return;
  }
  if (changeInfo.status !== 'loading') return;
  const active = state.tabActive[tabId];
  if (!active || !state.downloads[active]) return;
  const d = state.downloads[active];
  // ★ 页面导航/刷新 → 一律"打标记 + 等页面就绪后自动重新驱动"，不再标 paused 等用户点"继续"。
  //   旧行为是"tab 死了任务就没救"时代的产物：那时刷新后没法自己找承载页，只能停下来等人。
  //   现在 acquireTabFor 会自动找/建同源承载页 → 页面就绪后重派即可，用户不需要干预。
  //   导出中的任务尤其必须这样：页面销毁会让 blob 失效 → Chrome 下载项 NETWORK_FAILED、文件不落盘
  //   （真机日志：两个任务"合并完成"却没落盘）。
  if (d.status === 'downloading' || d.status === 'retrying' || d.status === 'exporting') {
    d.restartOnNav = true;
    state.tabActive[tabId] = null;
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    log('warn', `[页面导航] ${taskLabel(active)} 页面被刷新/跳转（当时 ${d.status}）→ 待页面就绪后自动重新驱动`);
    return;
  }
});
