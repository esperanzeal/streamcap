// main.js — StreamCap background 入口（MV3 ES module）
// import 各模块时副作用即生效（webRequest/alarms/downloads 监听器注册）。
import { state, persist, broadcast, taskLabel } from './state.js';
import { log, getLogs, clearLogs, clearAllLogs } from './log.js';
import { enqueue, maybeDispatch, pauseAll, resumeAll, pauseDownload, cancelDownload, prioritizeDownload, requeueToFront, requeueStalled } from './scheduler.js';
import { storeVideos, openManager, fillSizes } from './sniffing.js';
import { handleDownloadSignal, markLoaded, pendingDownloadSignals } from './signals.js';
import { ensureKeepaliveAlarm, pingDeadTask } from './stalled.js';

// ============ 重试智能接管（跨标签页续传） ============
// 原则：正常任务零打扰——原 tab 活着就原地续传，不做任何多余操作。
// 失败任务重试时的宿主选择链（只为续传已下分片，绝不抢占正在执行的任务）：
//   原 tab(PING 存活) → 同源空闲 tab → 同源任意 tab → 自动开同源 tab(前台, 等 content 就绪)。
function pingTabLive(tabId) {
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

async function retryExisting(msg, sendResponse) {
  const d = state.downloads[msg.retryId];
  if (!d) { sendResponse({ ok: false, error: '任务不存在' }); return; }
  // 状态守卫：正在下载/重试/导出/停止确认中的任务不接受重试请求（防双击/断线重发把 downloading 打回 queued）
  if (d.status === 'downloading' || d.status === 'retrying' || d.status === 'exporting' || d.status === 'stopping') {
    sendResponse({ ok: false, error: `任务正在${d.status === 'exporting' ? '导出' : d.status === 'stopping' ? '停止确认' : '下载'}，无需重试` });
    return;
  }
  if (d.status === 'completed') {
    // 已完成任务重试 = 重新下载：分片已清理，进度归零
    d.done = 0; d.pct = 0; d.total = 0; d.fileName = '';
  }

  // 1) 原 tab（manager 传来的 tabId）存活 → 原地续传（与旧行为一致，零变化零打扰）
  const preferId = msg.tabId ?? d.tabId;
  let hostTabId = ((preferId !== undefined && preferId !== null) && await pingTabLive(preferId)) ? preferId : null;

  // 2) 原 tab 失效 → 找同源活 tab（同一网站 origin → 同 OPFS → 已下分片直接续传）
  if (hostTabId === null) {
    const pageOrigin = originOf(d.pageUrl || '');
    if (pageOrigin) {
      try {
        const tabs = await chrome.tabs.query({});
        const sameOrigin = tabs.filter(t => t.id !== undefined && t.url && originOf(t.url) === pageOrigin);
        // 空闲 tab 优先（立即跑）；忙的也能接管（入队等待，不抢占正在执行的任务）
        const idleTab = sameOrigin.find(t => !state.tabActive[t.id]);
        const busyTab = sameOrigin.find(t => state.tabActive[t.id] && state.tabActive[t.id] !== d.id);
        hostTabId = (idleTab || busyTab)?.id ?? null;
      } catch { /* tabs.query 失败 */ }
    }
  }

  // 3) 无同源 tab → 自动开一个同源 tab（前台避免后台节流），等 content 注入就绪
  if (hostTabId === null) {
    const pageUrl = d.pageUrl || d.referer || '';
    if (pageUrl) {
      try {
        const tab = await chrome.tabs.create({ url: pageUrl, active: true });
        for (let i = 0; i < 40; i++) { // 最多 20s：页面加载 + content script(document_end) 注入
          await sleep(500);
          if (await pingTabLive(tab.id)) { hostTabId = tab.id; break; }
        }
        // 超时未就绪：不迁移不派发（任务保持原状态），tab 留着用户可手动再点重试（此时已就绪，走同源接管）
      } catch { /* 开 tab 失败 */ }
    }
  }

  if (hostTabId === null) {
    sendResponse({ ok: false, error: '原标签页不可用且找不到同源页面（也无法自动打开），请先打开原视频网站页面再点重试' });
    return;
  }

  // 迁移到宿主 tab：从旧队列/槽摘除 → 绑新 tabId → 入队（queued，并发有空位才跑，不抢活跃任务）
  migrateTaskToTab(d, hostTabId);
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
  maybeDispatch();
  sendResponse({ ok: true, downloadId: d.id });
  log('info', `[重试] ${taskLabel(d.id)} 由 tab${d.tabId} 接管续传（分片保留，跳过已下载批次）`);
}

function migrateTaskToTab(d, hostTabId) {
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
  d.consecutiveFails = 0; // 手动重试 = 新的尝试周期（保留 createdAt 保持 FIFO 原位置）
}

// ============ 删除已完成任务 → 关闭对应来源标签页 ============
// 判据：tab 仍存在 + 该 tab 无存活任务。completed/failed/cancelled 不算存活
//（failed 任务后续可走"重试智能接管"自动开/接管标签页续传，不依赖原 tab 活着）。
const TAB_ALIVE_STATUS = new Set(['queued', 'paused', 'downloading', 'retrying', 'exporting', 'stopping']);
async function closeTabIfIdle(tabId) {
  if (tabId === undefined || tabId === null) return;
  try {
    await chrome.tabs.get(tabId); // tab 已不存在会 throw → 跳过
    const q = state.tabQueues[tabId] || [];
    const hasAlive = q.some(id => {
      const dl = state.downloads[id];
      return dl && TAB_ALIVE_STATUS.has(dl.status);
    });
    if (hasAlive) return; // 该 tab 还有存活任务（其他排队/下载/暂停任务靠它的 content 执行），不能关
    if (state.tabActive[tabId]) return; // 双保险：调度槽仍被占用
    await chrome.tabs.remove(tabId);
    log('info', `[清理] 已删除完成任务，关闭来源标签页 tab${tabId} 释放内存`);
  } catch { /* tab 已关闭等：静默 */ }
}

// ============ 消息路由 ============

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 嗅探查询（popup 打开/刷新时补齐 mp4 直链的文件大小）
  if (msg.type === 'GET_M3U8S') {
    chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
      const tabId = tabs[0]?.id;
      const store = state.sniffStore[tabId];
      if (store && tabId) await fillSizes(store, tabId); // 让页面 content 探测 mp4 大小
      sendResponse(store || { videos: [], pageUrl: '' });
    });
    return true;
  }

  // 清空嗅探
  if (msg.type === 'CLEAR_SNIFF') {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (state.sniffStore[tabs[0]?.id]) state.sniffStore[tabs[0]?.id].videos = [];
      sendResponse({ ok: true });
    });
    return true;
  }

  // 入队
  if (msg.type === 'ENQUEUE') {
    if (msg.retryId && state.downloads[msg.retryId]) {
      // 重试：智能接管宿主 tab（原 tab 存活零打扰；失效则同源接管或自动开 tab），
      // 同 downloadId 入队 → OPFS 断点续传跳过已下载批次，进度不浪费
      retryExisting(msg, sendResponse);
      return true; // 异步响应
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
    const d = state.downloads[msg.downloadId];
    if (d) {
      const wasCompleted = d.status === 'completed'; // 删除前记录（completed → 关来源标签页）
      if (d.status === 'downloading') cancelDownload(msg.downloadId);
      delete state.downloads[msg.downloadId];
      persist();
      // 通知该任务所在页面清理其分片（任务已删，分片视为孤儿）
      chrome.tabs.sendMessage(d.tabId, { type: 'CLEANUP_OPFS', activeDownloadIds: Object.values(state.downloads).map(x => x.id) }).catch(() => {});
      broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: msg.downloadId });
      // 删除已完成任务 → 同步关闭其来源标签页（该 tab 无其他存活任务时才关）
      if (wasCompleted) closeTabIfIdle(d.tabId);
    }
    sendResponse({ ok: true });
    return true;
  }

  // 优先下载：queued 任务提到队首立即派发，并发满时替换权重最低的下载中任务
  if (msg.type === 'PRIORITIZE_DOWNLOAD') {
    prioritizeDownload(msg.downloadId).then(r => sendResponse(r || { ok: true }));
    return true;
  }

  // 全部重试：仅针对失败/取消任务，原地重置状态重新入队（保留进度续传）
  // 手动暂停（paused）的任务不在范围内——用"全部继续"恢复
  if (msg.type === 'RETRY_FAILED') {
    const targets = Object.values(state.downloads).filter(d => d.status === 'failed' || d.status === 'cancelled');
    for (const d of targets) {
      d.status = 'queued';
      d.error = null;
      // 保留 done 进度 → OPFS 断点续传生效；仅 completed 类重下才归零（见 ENQUEUE retryId 分支）
      d.consecutiveFails = 0;
      d.retryCount = 0;
      if (!state.tabQueues[d.tabId]) state.tabQueues[d.tabId] = [];
      if (!state.tabQueues[d.tabId].includes(d.id)) state.tabQueues[d.tabId].push(d.id);
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
    sendResponse(Object.values(state.downloads));
    return true;
  }

  // 打开管理器
  if (msg.type === 'OPEN_MANAGER') {
    openManager();
    sendResponse({ ok: true });
    return true;
  }

  // 定位任务来源标签页（manager "📍 定位"按钮）：激活 tab + 聚焦所在窗口
  if (msg.type === 'LOCATE_TAB') {
    const tabId = msg.tabId;
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || !tab) {
        sendResponse({ ok: false, error: '原标签页已关闭' });
        return;
      }
      chrome.tabs.update(tabId, { active: true }, () => {
        if (!chrome.runtime.lastError && tab.windowId !== undefined) {
          chrome.windows.update(tab.windowId, { focused: true });
        }
        sendResponse({ ok: true });
      });
    });
    return true; // 异步响应
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
  if (msg.type === 'CLEAR_ALL_LOGS') {
    clearAllLogs(() => sendResponse({ ok: true }));
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
        const d = state.downloads[downloadId];
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
      const d = state.downloads[downloadId];
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
        if (!state.sniffStore[tabId]) state.sniffStore[tabId] = { videos: [], pageUrl: '', pageTitle: '' };
        if (!state.sniffStore[tabId].pageUrl && resp.pageUrl) state.sniffStore[tabId].pageUrl = resp.pageUrl;
        storeVideos(tabId, resp.urls, resp.pageTitle || '');
      }
      // 等扫描结果写入后再响应，popup 才不会读到旧数据
      sendResponse({ ok: true });
    });
    return true;
  }

  // content 进度上报
  if (msg.type === 'PROGRESS') {
    const d = state.downloads[msg.downloadId];
    if (d) {
      // 状态守卫：终态任务（已完成/已取消/已失败/导出中）忽略迟到的 PROGRESS，
      // 防止泄漏定时器或 SW 重启前 content 的残留消息覆盖终态、刷新进度条异常
      if (d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled' ||
          d.status === 'exporting') {
        return;
      }
      // ★ done 单调性保护：续传/重派时 content 的 totalDone 会从 0 重新涨，跳过已落盘批次时
      // 上报的 done 远小于 background 已记录的 done（如跳过 batch 上报 40 < 已记录 600），
      // 若直接覆盖会把进度条拉回旧位置 → 与后续新进度交替闪烁（旧位置↔新位置来回跳）。
      // 这里忽略 done 回退（不覆盖 d.done/d.pct），但仍刷新 lastProgressAt：
      // content 还在主动发 PROGRESS = 循环活着，不能被停滞判定误判为卡死。
      if (typeof msg.done === 'number' && typeof d.done === 'number' && msg.done < d.done) {
        d.lastProgressAt = Date.now();
        return;
      }
      // done 增长检测：进度真正推进才刷新 lastDoneAt（停滞判定的唯一依据）。
      // 用旧 d.done 比较（在覆盖之前），msg.done > d.done 才算增长。
      const progressed = typeof msg.done === 'number' && msg.done > (d.done || 0);
      d.pct = msg.pct; d.done = msg.done; d.total = msg.total;
      d.speed = msg.speed || '';
      d.lastProgressAt = Date.now();
      d.lastDone = msg.done;
      if (progressed) d.lastDoneAt = Date.now();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    }
    return;
  }

  // content 保活心跳：下载进行中每 10s 发一次，防止 SW 空闲 30s 被 Chrome 回收
  // 注意：心跳≠进度，只说明 content 消息循环活着；下载是否推进看 lastDoneAt
  if (msg.type === 'HEARTBEAT') {
    const d = state.downloads[msg.downloadId];
    if (d) d.lastPing = Date.now();
    return;
  }

  if (msg.type === 'DOWNLOAD_ERROR') {
    const d = state.downloads[msg.downloadId];
    if (d) {
      if (msg.done !== undefined) d.done = msg.done;
      if (msg.total !== undefined) d.total = msg.total;

      // 用户操作或调度器中止的任务（已取消/已暂停/已放回队列）：保留状态，不自动重试、不覆盖
      // 终态（completed/exporting/failed）也直接忽略迟到 ERROR：content 单循环只在结束时上报一次，
      // 但用户双击重试等操作可能造成 background 状态与 content 循环不同步，防止终态被回退重下
      // ★ stopping 确认：停滞判定发 CANCEL 后 content 旧循环退出的确认信号。
      //   此时才把任务转 queued 重新入队（重派只在旧循环确认退出后发生，杜绝竞态），
      //   并在此处累计 consecutiveFails（≤3 次自动重派，超过标 failed 放弃）。
      //   接受"已暂停"和"已取消"两种文案：content 侧 cancelReasons 若因异常丢失会报"已取消"，
      //   但 stopping 状态必然是调度器触发（用户手动取消时 status 已是 cancelled，不会是 stopping），
      //   所以两种文案都应走重排确认，否则任务卡在 stopping 占槽。
      //   reason 结构化枚举（review P0-1）：stopping 确认只认 reason（abort 类），文案兜底兼容旧消息
      if (d.status === 'stopping' && (msg.reason || (msg.error || '').includes('已暂停') || (msg.error || '').includes('已取消'))) {
        // ★ 被优先下载替换的任务：确认旧循环退出后回队首（不计连续失败）
        if (d.replacedFlag) {
          delete d.replacedFlag;
          requeueToFront(d);
          log('info', `[优先] ${taskLabel(d.id)} 停止确认，回队列等待续传（priority=${d.priority}）`);
          return;
        }
        // 停滞重排（≤3 次重排队尾，超过标 failed）——统一走 requeueStalled
        requeueStalled(d, false);
        return;
      }
      if (msg.reason === 'manual_cancel' || (msg.error || '').includes('已取消') ||
          d.status === 'paused' || d.status === 'cancelled' || d.status === 'queued' ||
          d.status === 'completed' || d.status === 'exporting' || d.status === 'failed' ||
          // 迟到的停滞确认（reason 存在 = abort 类）：任务已离开 stopping（SW 重启重派/downloading 或手动恢复），
          // 忽略避免白走一次 retrying 往返
          (msg.reason && d.status === 'downloading')) {
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        return;
      }

      // 永久错误（404 / blob 丢失 / m3u8 解析失败）：重试无意义，直接失败并释放并发槽
      if (msg.permanent) {
        d.status = 'failed';
        d.error = msg.error;
        d.consecutiveFails = (d.consecutiveFails || 0) + 1;
        state.tabActive[d.tabId] = null;
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
        state.tabActive[d.tabId] = null;
        maybeDispatch();
        const delay = d.consecutiveFails * 3000; // 3s / 6s / 9s 退避
        log('info', `[重试] ${taskLabel(d.id)} 失败，${delay}ms 后重新排队（${d.consecutiveFails}/${MAX_RETRY}）`);
        setTimeout(() => {
          if (!state.downloads[d.id]) return; // 已被删除
          // 退避期间用户可能已暂停/取消/重新调度该任务：只有仍处于 retrying
          // （未被用户干预）才自动重派，避免双派发
          if (d.status !== 'retrying') return;
          d.status = 'queued';
          d.error = null;
          persist();
          broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
          // 放回原 tab 队列（保留 createdAt → FIFO 原位置），由 maybeDispatch 统一调度
          if (!state.tabQueues[d.tabId]) state.tabQueues[d.tabId] = [];
          if (!state.tabQueues[d.tabId].includes(d.id)) state.tabQueues[d.tabId].push(d.id);
          maybeDispatch();
        }, delay);
      } else {
        d.status = 'failed';
        d.error = msg.error;
        state.tabActive[d.tabId] = null;
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        log('warn', `[重试] ${taskLabel(d.id)} 连续失败 ${fails + 1} 次，转入失败队列`);
        maybeDispatch();
      }
    }
    return;
  }
});

// ============ Manager 长连接 ============

chrome.runtime.onConnect.addListener(port => {
  if (port.name === 'manager') {
    state.managerPorts.push(port);
    // 推送当前状态
    port.postMessage({ type: 'INIT', downloads: Object.values(state.downloads) });
    port.onDisconnect.addListener(() => {
      state.managerPorts = state.managerPorts.filter(p => p !== port);
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
    state.downloads[d.id] = d;
  }
  if (list.length > 0) {
    state.nextId = Math.max(...list.map(d => d.id), Date.now()) + 1;
  }
  // 旧版本任务没有 priority 字段：按 createdAt 排序补序号（FIFO），并恢复 prioritySeq
  const needsPrio = list.filter(d => d.priority === undefined || d.priority === null);
  if (needsPrio.length > 0) {
    const sorted = [...list].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    sorted.forEach((d, i) => { if (d.priority === undefined || d.priority === null) d.priority = i + 1; });
  }
  state.prioritySeq = Math.max(0, ...list.map(d => d.priority ?? 0));
  state.priorityFloor = Math.min(0, ...list.map(d => d.priority ?? 0)); // 负向计数器延续（点过优先的任务）

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
        if (!state.tabQueues[d.tabId]) state.tabQueues[d.tabId] = [];
        if (!state.tabQueues[d.tabId].includes(d.id)) state.tabQueues[d.tabId].push(d.id);
      } else if (d.status === 'downloading' || d.status === 'exporting' || d.status === 'retrying') {
        state.tabActive[d.tabId] = d.id;
      } else if (d.status === 'stopping') {
        // ★ SW 重启后 content 旧循环状态不确定（CANCEL 可能已到或消息丢失），
        //   不能继续等确认——直接转 queued 重新入队（旧版 53da483 的处理）。
        //   若 content 还活着：runningDownloads 防重入 + done 单调性兜底，不会双循环。
        d.status = 'queued';
        d.error = null;
        d.stopPendingAt = null; // 清除：否则派发后超时判定可能误触发
        if (!state.tabQueues[d.tabId]) state.tabQueues[d.tabId] = [];
        if (!state.tabQueues[d.tabId].includes(d.id)) state.tabQueues[d.tabId].push(d.id);
      }
    }
    persist();
    log('info', `[恢复] ${s.sw_marker ? 'SW 空闲重启' : '浏览器重启'}，重建队列 queued=${list.filter(d => d.status === 'queued').length}，活跃=${Object.keys(state.tabActive).length}`);

    // downloads 加载完成：重放 SW 休眠期间缓存的下载信号（防止 complete 信号丢失）
    markLoaded();
    for (const sig of pendingDownloadSignals.splice(0)) handleDownloadSignal(sig);

    maybeDispatch();

    // 心跳兜底：downloading 任务若 content script 已死（页面导航/刷新/冻结后无感知），
    // 会永远卡 downloading 且占着并发槽。这里逐个 ping，无响应 → 标为可续传暂停。
    (async () => {
      const pingers = Object.values(state.downloads)
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
