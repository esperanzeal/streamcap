// main.js — StreamCap background 入口（MV3 ES module）
// import 各模块时副作用即生效（webRequest/alarms/downloads 监听器注册）。
import { state, persist, broadcast, taskLabel } from './state.js';
import { log, getLogs, clearLogs, clearAllLogs } from './log.js';
import { enqueue, urlKey, maybeDispatch, pauseAll, resumeAll, pauseDownload, cancelDownload, prioritizeDownload } from './scheduler.js';
import { storeVideos, openManager, fillSizes } from './sniffing.js';
import { handleDownloadSignal, markLoaded, pendingDownloadSignals } from './signals.js';
import { ensureKeepaliveAlarm, pingDeadTask } from './stalled.js';

import { pingTabLive, findHostForTask, migrateTaskToTab } from './host.js';
import { queueTask, onTaskSettled, resortQueue } from './pool.js';

// ============ 任务重试（手动路径） ============
// 宿主选择统一在 host.js findHostForTask：
//   无卡史 + 原 tab 活 → 原地；否则负载均衡选活同源宿主（分散、满负荷排队等待不 fail）；
//   无活宿主 → 手动路径自动开同源页承接。forceHostTab（页面续传）= 直接绑当前活跃页。
// 用宿主页最新嗅探到的"同一视频"URL 刷新任务签名（签名/时效参数每次不同，旧 URL 会 403）。
// sniffStore 由 content 在页面加载/播放时重新抓取，其 query 才是当前有效的。
// 找不到同指纹条目、或指纹不同（弱指纹含分辨率）= 保持原 URL（保守：宁可失败也不混内容）。
function refreshUrlFromSniff(d, hostTabId) {
  const vids = state.sniffStore[hostTabId]?.videos || [];
  if (!vids.length) return;
  const mine = urlKey(d.url, d.resolution);
  // ★ 取数组里**最靠前**的同指纹条目：storeVideos 用 unshift（按完整 URL 去重），越前 = 嗅探越新，
  //   页面上每次播放/刷新都会把新签名排到最前。
  //   不能排除 `v.url === d.url` 的条目——若最新那条恰好就是 d.url（如 popup 续传刚刷新过），
  //   排除它会让 find 越过最新、取到更旧的签名覆盖回来（把好签名降级成旧的 → 又 403）。
  const hit = vids.find(v => v.url && urlKey(v.url, v.resolution || d.resolution) === mine);
  if (!hit || hit.url === d.url) return; // 已是最新签名：无需变更
  log('info', `[重试] ${taskLabel(d.id)} 用宿主页最新嗅探 URL 刷新签名`);
  d.url = hit.url;
}

async function retryExisting(msg, sendResponse) {
  const d = state.downloads[msg.retryId];
  if (!d) { sendResponse({ ok: false, error: '任务不存在' }); return; }
  // 状态守卫：正在下载/重试/导出/停止确认中的任务不接受重试请求（防双击/断线重发把 downloading 打回 queued）
  if (d.status === 'downloading' || d.status === 'retrying' || d.status === 'exporting') {
    sendResponse({ ok: false, error: `任务正在${d.status === 'exporting' ? '导出' : '下载'}，无需重试` });
    return;
  }
  if (d.status === 'completed') {
    // 已完成任务重试 = 重新下载：分片已清理，进度归零
    d.done = 0; d.pct = 0; d.total = 0; d.fileName = '';
  }

  // ★ 续传必须用"调用方带来的新 URL"：签名 URL 会过期，若仍用任务里的旧 d.url，就会拿
  //   过期签名再请求一次 403 → 续传必然失败（而 popup/README 引导的正是"重新嗅探 → 续传"）。
  //   分片按 downloadId 复用、与 URL 无关，所以换 URL 不影响断点续传。
  //   仅当弱指纹一致（同一视频）才替换；不同视频宁可沿用旧 URL 而失败，也不下错内容。
  if (msg.url && msg.url !== d.url) {
    if (urlKey(msg.url, msg.resolution || d.resolution) === urlKey(d.url, d.resolution)) {
      log('info', `[重试] ${taskLabel(d.id)} 刷新为调用方提供的新 URL（旧签名可能已过期）`);
      d.url = msg.url;
      if (msg.referer) d.referer = msg.referer;
      if (msg.pageUrl) d.pageUrl = msg.pageUrl;
      if (msg.pageTitle) d.pageTitle = msg.pageTitle;
    } else {
      log('warn', `[重试] ${taskLabel(d.id)} 传入 URL 与原任务不是同一视频（指纹不同），沿用原 URL`);
    }
  }

  // 即时反馈：接管可能耗时（逐个 PING/探测、自动开页轮询）→ 任务卡立刻显示"接管中"，
  // 用户不会以为按钮没反应而重复点击（后续成功/失败会再 broadcast 覆盖该文案）
  d.error = '正在寻找同源标签页接管...';
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });

  // 宿主查找的页面依据：msg.pageUrl（调用方实时提供，popup/页面续传=用户当前页）
  // → 任务持久化 pageUrl → referer（旧数据兜底）
  const pageUrlHint = msg.pageUrl || d.pageUrl || d.referer || '';

  let hostTabId = null;
  // 页面嗅探续传（popup forceHostTab）：用户就在当前活跃页操作，页面必然活着，
  // 直接绑它续传——不走接管链（探测/负载均衡对刚刷新的页面是多余绕路，且可能
  // 绑到其他同源 tab 而非用户正在操作的这一个）
  if (msg.forceHostTab && msg.tabId !== undefined && msg.tabId !== null && await pingTabLive(msg.tabId)) {
    hostTabId = msg.tabId;
  }
  // 其余手动重试：统一宿主选择（findHostForTask：原地→负载均衡活宿主→自动开新页）
  if (hostTabId === null) {
    hostTabId = await findHostForTask(d, {
      origId: msg.tabId ?? d.tabId,
      pageUrlHint: pageUrlHint,
      openNewTab: true, // 手动路径：失败是少数，无宿主时自动开同源页承接
    });
  }

  // 宿主已定：manager「重试」这类调用方不带新 URL（也就没有刷新签名的机会），
  // 用宿主页最新嗅探结果里的"同一视频"URL 兜底刷新。宿主页可能是本流程刚打开的，
  // content 加载后即重新嗅探 → sniffStore 里的签名就是当前有效的。
  if (hostTabId !== null) refreshUrlFromSniff(d, hostTabId);

  if (hostTabId === null) {
    // ★ 失败原因必须落到任务卡：manager 单任务/批量重试现在立即回 pending、
    //   丢弃后续响应——若不写回，卡片会永久停在"正在寻找同源标签页接管..."
    //   （语义错误 + 用户看不到真实原因，等于另一种静默失败）
    const reason = pageUrlHint
      ? '找不到可用的同源页面（候选均无法拉取媒体），请稍后重试或在原视频网站页面重试'
      : '任务缺少来源页面信息，请打开原视频网站页面后到下载管理点「重试」（续传可保留进度）';
    d.error = reason;
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    sendResponse({ ok: false, error: reason });
    return;
  }

  // 迁移到宿主 tab 并入队（queued → 并发有空位才跑）；手动重试 = 新尝试周期（计数清零）
  migrateTaskToTab(d, hostTabId, true);
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
  maybeDispatch();
  sendResponse({ ok: true, downloadId: d.id });
  log('info', `[重试] ${taskLabel(d.id)} 由 tab${d.tabId} 接管续传（分片保留，跳过已下载批次）`);
}
// ============ 删除已完成任务 → 关闭对应来源标签页 ============
// 判据：tab 仍存在 + 该 tab 无存活任务。completed/failed/cancelled 不算存活
//（failed 任务后续可走"重试智能接管"自动开/接管标签页续传，不依赖原 tab 活着）。
// v5 状态集（停摆状态已被移除：改为刷新承载页，见 stalled.js reloadTaskTab）
const TAB_ALIVE_STATUS = new Set(['queued', 'paused', 'downloading', 'retrying', 'exporting']);
// ★ 重复导出去重窗口（防 E:\Downloads 重复落盘）：同一任务在此窗口内的第二次 DOWNLOAD_BLOB
//   一律拒绝。窗口取 10 分钟 —— 足以覆盖"承载页刷新→任务重派→重新下载→重新合并"的往返，
//   又不会挡住用户几小时后主动重试导出（那种情况状态早已是 failed，不会命中本判据）。
const EXPORT_DEDUP_MS = 10 * 60 * 1000;
async function closeTabIfIdle(tabId) {
  if (tabId === undefined || tabId === null) return;
  try {
    await chrome.tabs.get(tabId); // tab 已不存在会 throw → 跳过
    // v5：队列不再按 tab 分组 → 直接看有没有任务的承载页仍是这个 tab
    const hasAlive = Object.values(state.downloads).some(
      dl => dl.tabId === tabId && TAB_ALIVE_STATUS.has(dl.status)
    );
    if (hasAlive) return; // 该 tab 还有存活任务（其他排队/下载/暂停任务靠它的 content 执行），不能关
    if (state.tabActive[tabId]) return; // 双保险：调度槽仍被占用
    await chrome.tabs.remove(tabId);
    log('info', `[清理] 已删除完成任务，关闭来源标签页 tab${tabId} 释放内存`);
  } catch { /* tab 已关闭等：静默 */ }
}

// ============ 消息路由 ============

// ★ 中断类文案（content 侧 reportDownloadError 在 AbortError 时给出的默认文案）。
//   "已取消" 是**默认值** —— 调用方没记录 reason 时（外部打断、AbortSignal 异常）它也这么报，
//   所以既不能当成"用户取消"忽略掉（会造成假活），也不能当成"下载失败"（会烧光重试上限）。
const INTERRUPT_TEXTS = new Set([
  '已取消', '已暂停', '已暂停(无进度)', '已暂停(页面无响应)', '已暂停(页面刷新)',
]);
// 中断重试上限（远大于 MAX_RETRY=3）：中断不是失败，只是这一轮循环被打断。
// 每轮都会换一块承载页，这个上限只是防"同一问题无限兜圈"的保险丝。
const MAX_INTERRUPTS = 12;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 嗅探查询（popup 打开/刷新时补齐 mp4 直链的文件大小）
  if (msg.type === 'GET_M3U8S') {
    chrome.tabs.query({ active: true, currentWindow: true }, async tabs => {
      const tabId = tabs[0]?.id;
      // ★ popup 打开即实时刷新：页面懒加载/动态注入视频时，嗅探缓存可能还没写入
      //   pageTitle/videos（用户反映首次打开只有 URL 末段名，要点刷新才有标题）。
      //   直接向页面 content 要一次实时扫描（与"刷新按钮"同一路径：SCAN_VIDEOS
      //   → storeVideos 合并，保留已有记录字段、空 pageTitle 不覆盖）。
      if (tabId) {
        try {
          const live = await chrome.tabs.sendMessage(tabId, { type: 'SCAN_VIDEOS' });
          if (live && !chrome.runtime.lastError && (live.urls?.length || live.pageTitle)) {
            if (!state.sniffStore[tabId]) state.sniffStore[tabId] = { videos: [], pageUrl: '', pageTitle: '' };
            if (live.pageUrl && !state.sniffStore[tabId].pageUrl) state.sniffStore[tabId].pageUrl = live.pageUrl;
            storeVideos(tabId, live.urls || [], live.pageTitle || '');
          }
        } catch { /* content 无响应（扩展页/浏览器内部页）：直接用缓存 */ }
      }
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
      if (msg.forceHostTab) {
        // 页面嗅探续传：只做一次 PING 就绑定，很快 → 保持同步返回结果（popup 需即时反馈）
        retryExisting(msg, sendResponse);
      } else {
        // manager 单任务重试：可能耗时（逐个探测/自动开新页 ≤30s+）→ 立即回 pending
        // 不让 UI 干等（也避免用户以为没反应而重复点击）；结果经任务卡状态更新呈现
        sendResponse({ ok: true, pending: true });
        retryExisting(msg, () => {});
      }
      return true; // 异步响应
    } else {
      // 新下载：用当前 active tab
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const tabId = tabs[0]?.id;
        if (!tabId) { sendResponse({ ok: false, error: '无法获取标签页' }); return; }
        const r = enqueue(tabId, msg.url, msg.referer, msg.resolution, msg.pageUrl, msg.pageTitle, msg.force === true);
        if (!r.ok && r.duplicate) {
          // 重复（弱指纹命中）：回传原任务详情，由发起方（popup/页面）弹确认框展示给用户判断
          sendResponse({
            ok: false, duplicate: true, url: msg.url,
            existingId: r.existingId, existingStatus: r.existingStatus, existingPct: r.existingPct,
            existingUrl: r.existingUrl, existingResolution: r.existingResolution,
            existingCreatedAt: r.existingCreatedAt, existingDone: r.existingDone,
          });
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

  // 队列排序模式（manager 切换；队列的物理顺序 = 派发顺序，见 pool.js）
  if (msg.type === 'SET_SORT_MODE') {
    state.sortMode = msg.value === 'progress' ? 'progress' : 'fifo';
    resortQueue(); // 已排好的队列按新策略重建 —— 否则旧顺序会一直沿用下去
    log('info', `[排序] 队列排序切换为 ${state.sortMode === 'progress' ? '按进度（先收尾）' : '按创建时间'}（队列已重排）`);
    maybeDispatch();
    sendResponse({ ok: true, value: state.sortMode });
    return true;
  }
  if (msg.type === 'GET_SORT_MODE') {
    sendResponse({ value: state.sortMode || 'fifo' });
    return true;
  }

  if (msg.type === 'DELETE_DOWNLOAD') {
    const d = state.downloads[msg.downloadId];
    if (d) {
      // 终态任务（完成/失败/取消）删除 → 顺带关来源标签页（失败页大概率已死，
      //   留着无用；完成的留着做同源宿主池直到用户清理——Q4 统一处理）
      const wasFinal = d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled';
      if (d.status === 'downloading') cancelDownload(msg.downloadId);
      delete state.downloads[msg.downloadId];
      persist();
      // 通知该任务所在页面清理其分片（任务已删，分片视为孤儿）
      chrome.tabs.sendMessage(d.tabId, { type: 'CLEANUP_OPFS', activeDownloadIds: Object.values(state.downloads).map(x => x.id) }).catch(() => {});
      broadcast({ type: 'DOWNLOAD_REMOVED', downloadId: msg.downloadId });
      // 终态删除 → 来源 tab 无存活任务才关（closeTabIfIdle 内部有保护）
      if (wasFinal) closeTabIfIdle(d.tabId);
    }
    sendResponse({ ok: true });
    return true;
  }

  // 优先下载：queued 任务提到队首立即派发，并发满时替换权重最低的下载中任务
  if (msg.type === 'PRIORITIZE_DOWNLOAD') {
    prioritizeDownload(msg.downloadId).then(r => sendResponse(r || { ok: true }));
    return true;
  }

  // 全部重试：逐个走接管链（探测/开页可能耗时几十秒）→ 立即回 pending，
  // 不让 manager 干等；每个任务的状态变化会 broadcast 更新到任务卡
  if (msg.type === 'RETRY_FAILED') {
    const targets = Object.values(state.downloads).filter(d => d.status === 'failed' || d.status === 'cancelled');
    if (targets.length === 0) { sendResponse({ ok: true, count: 0 }); return true; }
    sendResponse({ ok: true, pending: true, total: targets.length });
    // ★ 全部重试必须逐个走接管链：失败任务的宿主 tab 基本已死（这就是它失败的原因），
    //   原地放回原 tab 队列必然再次失败（"页面已关闭"）。逐个复用 ENQUEUE retryId 的
    //   完整接管逻辑：原 tab PING → 负载均衡选同源宿主（自动分散，不堆叠）→ 续传。
    //   串行执行保证负载均衡决策准确（并行会同时看到相同负载 → 又堆叠）。
    (async () => {
      let okCount = 0;
      for (const d of targets) {
        const r = await new Promise(resolve => {
          retryExisting(
            { retryId: d.id, tabId: d.tabId, pageUrl: d.pageUrl, pageTitle: d.pageTitle },
            resp => resolve(resp || {})
          );
        });
        if (r && r.ok) okCount++;
      }
      log('info', `[重试] 全部重试：${targets.length} 个失败/取消任务，成功接管续传 ${okCount} 个`);
      maybeDispatch();
    })();
    return true; // 已即时响应（pending），无需再回
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

  // ★★ 清空本扩展产生的**所有**数据：各站点 OPFS（分片 + 断点元数据）+ 任务列表 + 日志 + session 映射。
  //   关键约束：OPFS 按 origin 隔离，扩展无法从自己那边删除别的站点的文件 —— 只能逐个页面清：
  //     ① 已打开的所有标签页 → 让各自的 content 清自己那个 origin
  //     ② 任务/嗅探记录里出现过、但当前没打开的 origin → 临时开后台页去清，清完立即关（最多 6 个）
  //   判据只认 content 侧的 `vgp_` 前缀 → 不碰站点自身数据；设置 vgp_settings 不在清理范围。
  if (msg.type === 'CLEAR_ALL_CACHE') {
    (async () => {
      const report = { tabs: 0, removed: 0, bytes: 0, opened: 0, failed: 0 };
      const askTab = async (tabId) => {
        try {
          const r = await chrome.tabs.sendMessage(tabId, { type: 'CLEAR_VGP_CACHE' });
          if (r && r.ok) { report.tabs++; report.removed += r.removed || 0; report.bytes += r.bytes || 0; }
          else report.failed++;
        } catch { report.failed++; } // 无 content 的页面（chrome:// 等）→ 跳过
      };

      // ① 已打开的标签页
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) if (t.id !== undefined) await askTab(t.id);

      // ② 记录里出现过、当前没打开的 origin —— 补清（否则它们的分片会永远留着）
      const want = new Set();
      const addOrigin = (u) => { try { const o = new URL(u || ''); if (o.protocol === 'http:' || o.protocol === 'https:') want.add(o.origin); } catch { /* ignore */ } };
      for (const d of Object.values(state.downloads)) { addOrigin(d.pageUrl); addOrigin(d.referer); addOrigin(d.url); }
      for (const s of Object.values(state.sniffStore)) addOrigin(s && s.pageUrl);
      const openOrigins = new Set();
      for (const t of tabs) { try { openOrigins.add(new URL(t.url).origin); } catch { /* ignore */ } }

      const MAX_OPEN = 6; // 上限：不为了清理开一大堆页面
      let openedN = 0;
      for (const origin of want) {
        if (openedN >= MAX_OPEN) break;
        if (openOrigins.has(origin)) continue; // ① 里已清过
        openedN++;
        let tab = null;
        try {
          tab = await chrome.tabs.create({ url: origin, active: false });
          let ready = false;
          for (let i = 0; i < 16; i++) { // 等 content 就绪，最多 8s
            await new Promise(r => setTimeout(r, 500));
            try { const p = await chrome.tabs.sendMessage(tab.id, { type: 'PING' }); if (p && p.ok) { ready = true; break; } } catch { /* retry */ }
          }
          if (ready) { await askTab(tab.id); report.opened++; } else report.failed++;
        } catch { report.failed++; }
        finally { if (tab && tab.id !== undefined) { try { await chrome.tabs.remove(tab.id); } catch { /* ignore */ } } }
      }

      // ③ 任务列表 + 日志 + session 映射 + 内存状态
      state.downloads = {}; state.readyQueue = []; state.running = {}; state.tabActive = {}; state.tabPool = {};
      try { await chrome.storage.local.remove('vgp_downloads'); } catch { /* ignore */ }
      try { await chrome.storage.session.remove(['blob_map', 'sw_marker', 'vgp_log_prune_at']); } catch { /* ignore */ }
      // ★ 必须等 clearAllLogs 真正完成再写这条日志：两者都是异步的（get→remove 与 get→push→set），
      //   不等的话新写的这一条会被 remove 抹掉 —— 表现就是「清完缓存后日志里看不到清理记录」。
      await new Promise((res) => clearAllLogs(() => res()));
      log('warn', `[清理] 已清空扩展缓存：OPFS ${report.removed} 项（${(report.bytes / 1024 / 1024).toFixed(1)}MB）/ 涉及页面 ${report.tabs} 个，补清历史站点 ${report.opened} 个，失败 ${report.failed}`);
      broadcast({ type: 'CACHE_CLEARED' });
      sendResponse(Object.assign({ ok: true }, report));
    })();
    return true;
  }

  // content script 请求：用 chrome.downloads 触发 blob 下载
  // 不立即标完成——等 chrome.downloads.onChanged 的 complete/interrupted 信号
  if (msg.type === 'DOWNLOAD_BLOB') {
    const { downloadId, blobUrl, filename } = msg;
    const tabId = sender.tab?.id;
    // ★★ 幂等保护（真机反馈：E:\Downloads 大量文件重复落盘）：
    //   同一个任务只允许导出一次。重复的 DOWNLOAD_BLOB（承载页被刷新后重跑一轮、
    //   跨页双跑、SW 消息重放）会让 Chrome 再写一个文件 —— conflictAction:'uniquify'
    //   遇到同名不覆盖、而是另存为 "xxx (1).mp4"，所以用户看到的是同名文件成对出现。
    const prev = state.downloads[downloadId];
    if (prev && prev.exportedAt && Date.now() - prev.exportedAt < EXPORT_DEDUP_MS) {
      log('warn', `[导出] ${taskLabel(downloadId)} ${Math.round((Date.now() - prev.exportedAt) / 1000)}s 前已导出过 → 忽略重复的 DOWNLOAD_BLOB（防重复落盘）`);
      // 让 content 释放这份多余的 blob 并清掉分片（它已经没用了）
      chrome.tabs.sendMessage(tabId, { type: 'FINALIZE_DOWNLOAD', downloadId, blobUrl }).catch(() => {});
      // ★ 必须回 ok:true + duplicate 标记，**不能回 ok:false**：
      //   content 侧 exportBlob 的判定是 `if (!resp || !resp.ok) → 回退 a.click()`，
      //   回 ok:false 会让第二个实例改用 a.click() 再落一份文件 —— 那等于把这个防重复
      //   修复反过来变成"再多落一份"。content 看到 duplicate 就只释放 blob、不做任何回退。
      sendResponse({ ok: true, duplicate: true, note: '该任务刚已导出过，已忽略本次重复导出（防重复落盘）' });
      return true;
    }
    // ★ 竞态铁律：占位必须**同步**打上，绝不能等 chrome.downloads.download 的回调。
    //   真机日志实证：同一任务同一秒创建了两个下载项（#653 / #654）—— 两条 DOWNLOAD_BLOB
    //   几乎同时到达，第一条的回调还没跑完，双方都通过了上面的检查（TOCTOU）→ 各写一个文件。
    //   （content 侧也可能存在两个实例，见 downloader.js 的重复注入守卫，所以这里必须仲裁。）
    if (prev) { prev.exportedAt = Date.now(); persist(); }
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
          // ★ 回滚同步占位：这次导出没成功，必须放行后续重试（否则 10 分钟内都导不出来）
          d.exportedAt = null;
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
        // ★ expectedSize：content 报上来的 blob 字节数。Chrome 下载完成时用它校验**实际
        //   落盘字节数**（见 signals.js）—— 这是唯一能发现"文件被截断/只写了一半"的兜底。
        m[itemId] = { downloadId, tabId, blobUrl, filename, expectedSize: msg.size || 0 };
        chrome.storage.session.set({ blob_map: m });
      });
      // 任务进入"导出中"：等待 Chrome 下载结果信号
      const d = state.downloads[downloadId];
      if (d) {
        d.exportedAt = Date.now(); // ★ 记下导出时刻：EXPORT_DEDUP_MS 窗口内再来的 DOWNLOAD_BLOB 一律拒绝
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
      // ★ 轻量活动上报（content 每次分片/分块请求尝试后都会发一次）：只刷新"最近有活动"，
      //   绝不能落到下面的 pct/done 赋值——它的 msg.done 是 undefined，会把进度写成 undefined。
      if (msg.activity && msg.done === undefined) {
        d.lastActivityAt = Date.now();
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
      // done 增长检测：进度真正推进才刷新 lastDoneAt（停滞判定的依据之一）。
      // 用旧 d.done 比较（在覆盖之前），msg.done > d.done 才算增长。
      const progressed = typeof msg.done === 'number' && msg.done > (d.done || 0);
      d.pct = msg.pct; d.done = msg.done; d.total = msg.total;
      d.speed = msg.speed || '';
      d.lastProgressAt = Date.now();
      d.lastActivityAt = Date.now(); // 带 done 的上报同样是活动证据（与 lastDoneAt 分开记，语义不同）
      // 有真实进展 → 重置"刷新复活"与"中断重试"计数（任务确实在推进，之前的打断翻篇）
      if (progressed) { d.lastDoneAt = Date.now(); d.reloadCount = 0; d.interruptRetries = 0; }
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

  // 页面 a.click() 回退路径完成通知：文件很可能已进下载目录（Chrome 下载器之外的
  // 路径扩展无法追踪）→ 标为已完成并附提示，而不是 failed（旧行为误导用户重复下载）
  if (msg.type === 'DOWNLOAD_FALLBACK_DONE') {
    const d = state.downloads[msg.downloadId];
    if (d) {
      d.status = 'completed';
      d.pct = 100;
      d.fileName = msg.fileName || d.fileName || '';
      d.speed = '';
      d.error = msg.note || '已通过页面触发下载（请检查浏览器下载目录确认）';
      onTaskSettled(d); // v5：释放槽 + 归还承载页 + 继续调度（retrying 状态下 reap 不会替你清）
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      log('warn', `[导出] ${taskLabel(d.id)} ${d.error}`);
      maybeDispatch();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'DOWNLOAD_ERROR') {
    const d = state.downloads[msg.downloadId];
    if (d) {
      // ★ done 单调保护（与 PROGRESS 分支同一套规则）：content 每次运行都从 totalDone=0
      //   重新计数，若在"还没跳过任何已落盘批次"时被中止（停摆刷新重注入后立刻被 CANCEL、
      //   让位、暂停），上报的 done 就是 0 —— 无条件写入会把已有进度打成 0/2251 分片。
      //   真机现象：右下角 78.0% 但分片显示 0/2251，且"按进度"排序时被判成 0% 排到队尾。
      if (typeof msg.done === 'number' && msg.done > (d.done || 0)) d.done = msg.done;
      if (typeof msg.total === 'number' && msg.total > 0) d.total = msg.total;

      // ★ 只忽略"我们自己主动中断"的信号，依据是**任务状态已经被改过**（paused/cancelled/queued/
      //   终态），或调用方明确带了 reason（调度器发起的 abort，状态在发之前就改好了）。
      //   ⚠️ 以前这里还有 `error.includes('已取消')` 和 `reason && downloading` 两条，它们会造成"假活"：
      //   content 侧 errText 的**默认值**就是"已取消"，当调用方没记录 reason 时（外部中断、
      //   页面销毁、循环自己结束）它照样是"已取消" —— 那就把"循环已经结束"这个事实当噪声丢掉了，
      //   任务留在 downloading 却没有任何循环在跑，只能干等 4 分钟兜底。
      //   真机现象：「提示已取消，却还要等 4 分钟；手动刷新一下就动一点」。
      //   删掉这两条后，这类信号会正常走下面的重试/重派逻辑，立刻恢复。
      if (msg.reason === 'manual_cancel' ||
          d.status === 'paused' || d.status === 'cancelled' || d.status === 'queued' ||
          d.status === 'completed' || d.status === 'exporting' || d.status === 'failed') {
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        return;
      }

      // ★★ 中断类信号：content 的下载循环被"外部"打断，**不是"这个任务下不动"**。
      //   判据：带了 reason（我们主动中断的），或文案是"已取消/已暂停*"且没有 reason
      //   （外部打断，content 侧没记下来源 —— 只可能是 AbortSignal 那边出的问题）。
      //   ⚠️ 这类信号**绝不能计入 consecutiveFails**：它不是下载失败，而是这一轮的循环被打断，
      //   计进去会白白烧掉重试上限（真机：每轮 20s 被中断一次，3 轮就进失败队列）。
      //   处理方式：不计失败，但**必须换一块承载页**再试 —— 既避开"那一页有问题"，
      //   也避免在同一页上无限循环；上限用独立的 interruptRetries（比 3 宽得多）。
      if (!msg.permanent && (INTERRUPT_TEXTS.has(msg.error || '') || !!msg.reason)) {
        const n = (d.interruptRetries || 0) + 1;
        if (n > MAX_INTERRUPTS) {
          d.status = 'failed';
          d.error = `${msg.error || '任务被反复打断'}（已换承载页重试 ${MAX_INTERRUPTS} 次仍未成功）`;
          onTaskSettled(d);
          persist();
          broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
          log('warn', `[重试] ${taskLabel(d.id)} 反复被打断 ${n} 次，转入失败队列`);
          maybeDispatch();
          return;
        }
        d.interruptRetries = n;
        d.status = 'queued';
        d.error = null;
        // ★ 归还承载页 → 下一轮 acquireTabFor 会复用**别的**同源页或新建一个。
        //   同一页上反复被打断时必须换页，否则只是把同一个坑重踩一遍。
        onTaskSettled(d);
        queueTask(d.id);
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        log('warn', `[重试] ${taskLabel(d.id)} 下载循环被打断（${msg.reason || msg.error}）→ 换承载页续传（${n}/${MAX_INTERRUPTS}，不计失败）`);
        maybeDispatch();
        return;
      }

      // 永久错误（404 / blob 丢失 / m3u8 解析失败）：重试无意义，直接失败并释放并发槽
      if (msg.permanent) {
        d.status = 'failed';
        d.error = msg.error;
        d.consecutiveFails = (d.consecutiveFails || 0) + 1;
        onTaskSettled(d); // v5：释放槽 + 归还承载页 + 继续调度（retrying 状态下 reap 不会替你清）
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
        d.status = 'retrying';
        d.error = `第 ${d.consecutiveFails}/${MAX_RETRY} 次重试: ${msg.error}`;
        d.lastRetryAt = Date.now(); // ★ 记下进入重试态的时刻：退避 setTimeout 若随 SW 回收丢失，
                                    //   alarm 里的兜底判据靠它把任务捞回队列（否则永久停在"重试中"）
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        // ★ 让出并发槽：退避期间其他任务可插队，避免失败任务占坑
        onTaskSettled(d); // v5：释放槽 + 归还承载页 + 继续调度（retrying 状态下 reap 不会替你清）
        maybeDispatch();
        const delay = d.consecutiveFails * 3000; // 3s / 6s / 9s 退避
        log('info', `[重试] ${taskLabel(d.id)} 失败，${delay}ms 后重新排队（${d.consecutiveFails}/${MAX_RETRY}）`);
        setTimeout(() => {
          if (!state.downloads[d.id]) return; // 已被删除
          // 退避期间用户可能已暂停/取消/重新调度该任务：只有仍处于 retrying
          // （未被用户干预）才自动重派，避免双派发
          if (d.status !== 'retrying') return;
          // ★ 宿主页已关：不再"人工找同源宿主，找不到就判死"。
          //   直接把任务交还调度 —— pump 里的 acquireTabFor 会自动复用同源页或**新建一个**，
          //   所以"那一刻没开着同源页"不再是绝路（旧实现 openNewTab=false，找不到直接 failed）。
          //   死掉的 tabId 不用清理：acquireTabFor 会先试它、拿不到 tab 就继续走 ②③。
          chrome.tabs.get(d.tabId, t => {
            if (chrome.runtime.lastError || !t) {
              log('warn', `[重试] ${taskLabel(d.id)} 宿主页面已关闭 → 交还调度，自动重新建立承载页`);
            }
            d.status = 'queued';
            d.error = null;
            persist();
            broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
            // 回就绪队列（保留 createdAt → FIFO 原位置），由 maybeDispatch 统一调度
            queueTask(d.id);
            maybeDispatch();
          });
        }, delay);
      } else {
        d.status = 'failed';
        d.error = msg.error;
        onTaskSettled(d); // v5：释放槽 + 归还承载页 + 继续调度（retrying 状态下 reap 不会替你清）
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

    // ★ 重建内存队列/活跃表：SW 重启后全局 readyQueue/tabActive 已清空，
    //   若不重建，queued 任务永远不会被 maybeDispatch 派发（任务卡死等待队列）
    for (const d of list) {
      // 一致性自愈：done 与 pct 明显矛盾（done=0 但 pct>0）是历史脏数据 —— 旧版本在
      // DOWNLOAD_ERROR 里无条件写入了 content 的 totalDone=0，把进度打成 0/2251。
      // 用 pct 回填 done，否则进度条会一直显示 0/2251（真机反馈）。
      // 只修排队中的任务（downloading/exporting 由 content 实时上报覆盖，pct=99 的导出态也已排除）。
      // 真正续传靠 OPFS 里的 meta.completedBatches，与 done 无关，回填不影响下载行为。
      if (d.status === 'queued' && !(d.done > 0) && (d.pct > 0) && (d.total > 0)) {
        d.done = Math.round(d.pct / 100 * d.total);
        log('info', `[恢复] ${taskLabel(d.id)} 进度自愈：分片数回填为 ${d.done}/${d.total}（按 ${d.pct}% 推算）`);
      }
      if (d.status === 'queued') {
        queueTask(d.id);
      } else if (d.status === 'downloading' || d.status === 'exporting' || d.status === 'retrying') {
        state.running[d.id] = d.tabId; // ★ 必须同步重建：slotsFree() 靠 running 计数，漏了会并发超发（原有任务 + 新派满槽）
        state.tabActive[d.tabId] = d.id;
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
        .map(d => pingDeadTask(d, '页面已无响应'));
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
