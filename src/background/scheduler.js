// scheduler.js — StreamCap 队列/调度/暂停/取消
import { state, persist, broadcast, taskLabel } from './state.js';
import { log } from './log.js';

export function enqueue(tabId, url, referer, resolution, pageUrl, pageTitle, force = false) {
  const { downloads, tabQueues } = state;
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
  const id = state.nextId++;
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
  const d = state.downloads[downloadId];
  if (!d) return;
  d.status = 'downloading';
  d.error = null; // 下载恢复时清除历史错误提示
  if (!d.done) d.pct = 0; // 续传时保留已有进度
  d.lastProgressAt = Date.now(); // 派发即记"最后活跃"：启动/解析阶段计入宽限期，防误判停滞
  d.lastDone = 0; // 派发清零：progress done 从 0 开始计数，防旧值干扰停滞判定
  d.lastDoneAt = Date.now(); // done 增长的初始基准：派发即记，覆盖 m3u8 获取/解析/跳过批次的启动期
  d.stalledAt = null; // 清除历史停滞标记
  state.tabActive[tabId] = downloadId;
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
        files: ['src/content/log.js', 'src/content/opfs.js', 'src/content/hls.js', 'src/content/downloader.js', 'src/content/merge.js', 'src/content/sniffer.js', 'src/content/main.js'],
      });
      await chrome.tabs.sendMessage(tabId, payload);
    } catch (err2) {
      d.status = 'failed';
      d.error = '注入失败: ' + err2.message;
      state.tabActive[tabId] = null;
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      maybeDispatch();
    }
  }
}

// 优先下载：把 queued 任务提到队首立即派发；并发已满时暂停"权重最低"
// （已下载分片数最少 = 沉没成本最低）的 downloading 任务腾出并发槽。
export async function prioritizeDownload(downloadId) {
  const d = state.downloads[downloadId];
  if (!d || d.status !== 'queued') return { ok: false, error: '任务不在队列中' };
  log('info', `[优先] ${taskLabel(downloadId)} 收到优先下载请求`);

  const max = await getMaxConcurrent();
  const unlimited = max === 0;

  // 收集需要被替换的任务（可能多个），替换 = 标 queued 放回队列队首（不暂停，进度保留 OPFS 续传）
  const victims = [];

  // 1. 首选：优先任务所在 tab 的 active 任务。
  //    maybeDispatch 有"每个 tab 至多 1 个任务"限制——若该 tab 已有任务在下载，
  //    优先任务永远排不进（maybeDispatch 会跳过该 tab），所以必须先把它替换掉让 tab 空闲。
  const tabActiveId = state.tabActive[d.tabId];
  if (tabActiveId && state.downloads[tabActiveId] && tabActiveId !== downloadId) {
    victims.push(state.downloads[tabActiveId]);
  }

  // 2. tab 空闲后若并发仍满（全局槽不足），再替换全局"权重最低"（done 最少）的 downloading 任务腾槽
  const activeCount = Object.keys(state.tabActive).filter(t => state.tabActive[t]).length;
  const slotsAfterTabFree = (unlimited ? Infinity : max) - (activeCount - victims.length);
  if (slotsAfterTabFree <= 0) {
    const downloading = Object.values(state.downloads)
      .filter(x => x.status === 'downloading' && !victims.includes(x));
    if (downloading.length > 0) {
      downloading.sort((a, b) => (a.done || 0) - (b.done || 0));
      victims.push(downloading[0]);
    }
  }

  // 替换所有 victim：先进 stopping（不参与调度），等 content 确认旧循环退出后再回队列队首。
  // 不能直接标 queued——否则 maybeDispatch 看到 queued+tab空闲+槽刚释放，会立即把 victim 重新
  // 派发，但旧循环还在（CANCEL 未到），新 START 被 runningDownloads 防重入忽略 → victim 假活占槽
  // （用户日志里"被替换的任务刚被暂停就被调度自动派发"就是这个竞态）。
  for (const victim of victims) {
    victim.status = 'stopping';
    victim.error = '被优先下载替换，稍后自动续传';
    victim.stopPendingAt = Date.now(); // 超时兜底：content 无响应时强制回队首
    victim.replacedFlag = true; // 标记：停止确认后回队首，不计 consecutiveFails（区别于停滞重排）
    state.tabActive[victim.tabId] = null; // 释放并发槽
    // 通知 content 停止旧下载循环（分片保留可续传）
    chrome.tabs.sendMessage(victim.tabId, { type: 'CANCEL_DOWNLOAD', downloadId: victim.id, reason: 'manual_pause' }).catch(() => {});
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: victim });
    log('warn', `[优先] ${taskLabel(downloadId)} 替换 ${taskLabel(victim.id)}（进度 ${victim.done || 0} 片），等待停止确认后回队列队首`);
  }

  // 优先任务：标记 priorityAt（maybeDispatch 排序时排最前）+ 提到本 tab 队列队首
  d.priorityAt = Date.now();
  d.stalledAt = null; // 清除停滞标记，不排队尾
  const q = state.tabQueues[d.tabId];
  if (q) {
    const i = q.indexOf(downloadId);
    if (i >= 0) q.splice(i, 1);
    q.unshift(downloadId);
  }
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
  log('info', `[优先] ${taskLabel(downloadId)} 已标记优先排到队首${victims.length ? `（替换 ${victims.length} 个任务）` : '（并发有空槽，直接等待派发）'}`);
  maybeDispatch();
  return { ok: true };
}

// 读取并发任务数（0=无上限）。注意：必须用 undefined 判断，不能用 ||（0 会被吞）
async function getMaxConcurrent() {
  const s = await chrome.storage.local.get('vgp_settings');
  const v = s.vgp_settings && s.vgp_settings.maxConcurrent;
  return (v === undefined || v === null) ? 4 : v;
}

// 全局并发调度：最多同时跑 maxConcurrent 个任务（0=无上限），每个 tab 至多 1 个
// 按任务创建时间排序推进（FIFO 优先级）
// ★ 串行化：prioritizeDownload 触发的调度、被替换任务确认触发的调度可能并发执行，
//   都读同一份 tabActive/tabQueues，先后派发互相覆盖（优先任务被后到的调度顶掉）。
//   用 promise 链保证同一时刻只有一个 maybeDispatch 在跑。
let dispatchChain = Promise.resolve();
export function maybeDispatch() {
  const run = async () => {
    const max = await getMaxConcurrent();
    const unlimited = max === 0;
    const activeCount = Object.keys(state.tabActive).filter(t => state.tabActive[t]).length;
    if (!unlimited && activeCount >= max) return;

    // 收集所有可派发的候选（排队中且所在 tab 空闲），按创建时间排序
    // 停滞任务（stalledAt）按停滞时刻排到队尾最后执行，不占用优先调度位
    const candidates = [];
    for (const tid of Object.keys(state.tabQueues)) {
      const tabId = Number(tid);
      if (state.tabActive[tabId]) continue; // 该 tab 已有活动任务
      for (const did of state.tabQueues[tabId]) {
        const d = state.downloads[did];
        if (d && d.status === 'queued') candidates.push({
          tabId, did,
          sortKey: d.stalledAt || d.createdAt || 0,
          priorityAt: d.priorityAt, // 优先下载标记：有值则排最前
        });
      }
    }
    // 排序：优先任务（priorityAt）永远排最前（多个按优先时间），其余按 FIFO
    candidates.sort((a, b) => {
      const ap = a.priorityAt ? 0 : 1;
      const bp = b.priorityAt ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.sortKey - b.sortKey;
    });
    log('debug', `[调度] 候选: ${candidates.map(c => `#${c.did}${c.priorityAt ? '(优先)' : ''}`).join(', ')}`);

    let slots = unlimited ? Infinity : (max - activeCount);
    for (const c of candidates) {
      if (slots <= 0) break;
      if (state.tabActive[c.tabId]) continue; // 前面派发已占用该 tab
      const q = state.tabQueues[c.tabId];
      const idx = q.indexOf(c.did);
      if (idx < 0) continue;
      q.splice(idx, 1);
      dispatchTab(c.tabId, c.did);
      slots--;
      log('info', `[调度] 派发 ${taskLabel(c.did)} → tab${c.tabId}（并发 ${max}，活跃 ${activeCount + 1}）`);
    }
  };
  dispatchChain = dispatchChain.then(run).catch(() => {});
  return dispatchChain;
}

// 全部暂停：所有活跃/排队任务 → paused（保留分片），供用户手动重新分配并发
export async function pauseAll() {
  const tasks = Object.values(state.downloads).filter(d =>
    d.status === 'downloading' || d.status === 'retrying' || d.status === 'queued' || d.status === 'stopping'
  );
  for (const d of tasks) pauseDownload(d.id);
  maybeDispatch();
}

// 全部继续：所有暂停任务重新入队，由并发限制决定启动数量
// 手动恢复 = 新的尝试周期：重置连续失败计数，与单任务"继续"(ENQUEUE retryId)行为对齐
export async function resumeAll() {
  const tasks = Object.values(state.downloads).filter(d => d.status === 'paused');
  for (const d of tasks) {
    d.status = 'queued';
    d.error = null;
    d.consecutiveFails = 0;
    d.retryCount = 0;
    d.stalledAt = null; // 手动恢复 = 新的尝试周期，回到正常 FIFO 位置
    if (!state.tabQueues[d.tabId]) state.tabQueues[d.tabId] = [];
    if (!state.tabQueues[d.tabId].includes(d.id)) state.tabQueues[d.tabId].push(d.id);
  }
  persist();
  tasks.forEach(d => broadcast({ type: 'DOWNLOAD_UPDATE', download: d }));
  maybeDispatch();
}

export function pauseDownload(downloadId) {
  const d = state.downloads[downloadId];
  if (!d) return;
  const tabId = d.tabId;
  if (d.status === 'queued') {
    const q = state.tabQueues[tabId] || [];
    const i = q.indexOf(downloadId);
    if (i >= 0) q.splice(i, 1);
    d.status = 'paused';
  } else if (d.status === 'downloading' || d.status === 'retrying') {
    d.status = 'paused';
    state.tabActive[tabId] = null;
    // 暂停：分片保留在 OPFS，可随时续传
    chrome.tabs.sendMessage(tabId, { type: 'CANCEL_DOWNLOAD', downloadId, reason: 'manual_pause' }).catch(() => {});
    maybeDispatch();
  } else if (d.status === 'stopping') {
    // 停止确认中的任务被暂停：直接标 paused 释放槽
    // （content 旧循环收到 CANCEL 后退出；迟到 ERROR 命中 paused 保护分支不覆盖）
    d.status = 'paused';
    state.tabActive[tabId] = null;
    chrome.tabs.sendMessage(tabId, { type: 'CANCEL_DOWNLOAD', downloadId, reason: 'manual_pause' }).catch(() => {});
    maybeDispatch();
  }
  d.error = '已暂停，点击继续恢复';
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
}

export function cancelDownload(downloadId) {
  const d = state.downloads[downloadId];
  if (!d) return;
  const tabId = d.tabId;
  if (d.status === 'queued') {
    d.status = 'cancelled';
    const q = state.tabQueues[tabId] || [];
    const i = q.indexOf(downloadId);
    if (i >= 0) q.splice(i, 1);
  } else if (d.status === 'downloading' || d.status === 'retrying') {
    d.status = 'cancelled';
    state.tabActive[tabId] = null;
    // 取消：分片同样保留在 OPFS（浏览器退出时自动清理），可续传
    chrome.tabs.sendMessage(tabId, { type: 'CANCEL_DOWNLOAD', downloadId, reason: 'manual_cancel' }).catch(() => {});
    maybeDispatch();
  } else if (d.status === 'stopping') {
    // 停止确认中的任务被用户取消：终止停止流程，直接标 cancelled 释放槽
    // （content 旧循环会收到 CANCEL 后退出；若已退出则迟到 ERROR 命中 cancelled 保护分支）
    d.status = 'cancelled';
    state.tabActive[tabId] = null;
    chrome.tabs.sendMessage(tabId, { type: 'CANCEL_DOWNLOAD', downloadId, reason: 'manual_cancel' }).catch(() => {});
    maybeDispatch();
  }
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
}
