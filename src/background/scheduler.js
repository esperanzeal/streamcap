// scheduler.js — StreamCap 队列/调度/暂停/取消
import { state, persist, broadcast, taskLabel } from './state.js';
import { log } from './log.js';
import { detectFormat } from './formats.js';

export function enqueue(tabId, url, referer, resolution, pageUrl, pageTitle, force = false) {
  const { downloads, tabQueues } = state;
  // 弱指纹：origin + pathname + resolution。
  // - 忽略 query：签名 URL 的时效参数每次不同（保留 query 会让"重新嗅探"漏检重复）。
  // - 纳入分辨率：同 pathname 靠 query 区分不同视频的站点（`/play?vid=A` ↔ `?vid=B`）
  //   不应被误判为同一视频——误报比漏报严重（"续传"会下错内容），分辨率能挡掉一部分。
  // - 即便如此，同 pathname + 同分辨率的**不同视频**仍可能同指纹 → 续传入口必须
  //   展示原任务信息、且只对"有进度（done>0）"的失败任务提供（见 popup 侧）。
  const urlKey = (u, res) => {
    try { const x = new URL(u); return x.origin + x.pathname + '|' + (res || ''); } catch { return u + '|' + (res || ''); }
  };
  // 重复检测：同一视频（弱指纹相同）已有未取消任务 → 除非 force 确认，否则拒绝入队
  const existing = Object.values(downloads).find(x => urlKey(x.url, x.resolution) === urlKey(url, resolution) && x.status !== 'cancelled');
  if (existing && !force) {
    // 一并回传原任务的关键信息：弱指纹可能把"同 pathname 的不同视频"判成同一视频，
    // 由调用方（popup）展示给用户判断，避免"续传"下错内容
    return {
      ok: false, duplicate: true,
      existingId: existing.id, existingStatus: existing.status, existingPct: existing.pct,
      existingUrl: existing.url, existingResolution: existing.resolution,
      existingCreatedAt: existing.createdAt, existingDone: existing.done,
    };
  }
  // force 双保险：2s 内同视频只允许 force 入队一次（防双击/重发绕过 UI 禁用产生重复任务）
  if (force && existing) {
    if (existing.createdAt && Date.now() - existing.createdAt < 2000) {
      return { ok: false, error: '该视频刚加入过，已忽略重复请求' };
    }
  }
  const id = state.nextId++;
  // 重复检测：同一视频已在任务列表中 → 新任务加序号（(2)、(3)...），提醒用户任务重复
  const dupIndex = Object.values(downloads).filter(x => urlKey(x.url, x.resolution) === urlKey(url, resolution)).length + 1;
  // 格式：优先用 sniffStore 嗅探到的（onHeadersReceived 按 Content-Type 识别过，
  // 部分站点等无 .mp4 后缀的签名 URL 也能正确标 mp4），兜底按 URL 后缀判断
  const sniffed = state.sniffStore[tabId]?.videos?.find(v => v.url === url);
  const taskFormat = sniffed?.format || detectFormat(url);
  downloads[id] = {
    id, url, referer, resolution,
    // pageUrl 兜底链：调用方传入 → 同 tab 嗅探记录（webRequest 记录/主动上报）→ referer。
    // 尽量让任务带上来源页面地址——失败后重试靠它找同源宿主/自动开原页续传。
    pageUrl: pageUrl || (state.sniffStore[tabId] && state.sniffStore[tabId].pageUrl) || referer || '',
    pageTitle: pageTitle || '',
    status: 'queued', pct: 0, done: 0, total: 0,
    speed: '', error: null, createdAt: Date.now(), tabId,
    priority: ++state.prioritySeq, // 创建序号 = FIFO 优先级（数字小 = 先下载）
    format: taskFormat, // 传给 content 分流下载
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
  // ★ 同步占位（必须在第一个 await 之前）：maybeDispatch 的 for 循环是同步的、
  //   且不 await dispatchTab——若 tabActive 等到 await chrome.tabs.get 之后才写，
  //   循环第二轮仍读到空值 → 同一 tab 被连发多个任务（违反"每 tab 至多 1 任务"）。
  state.tabActive[tabId] = downloadId;
  // tab 有效性预检：页面已关闭/无效的任务直接标 failed，不尝试注入——
  //   否则任务停留在 queued 永不派发，手动点开始才暴露"注入失败"。
  try {
    await chrome.tabs.get(tabId);
  } catch {
    state.tabActive[tabId] = null; // 预检失败：释放同步占位，不占并发槽
    d.status = 'failed';
    d.error = '页面已关闭，无法下载';
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    log('warn', `[调度] ${taskLabel(downloadId)} 所在页面已关闭，标为失败`);
    maybeDispatch();
    return;
  }
  d.status = 'downloading';
  d.error = null; // 下载恢复时清除历史错误提示
  if (!d.done) d.pct = 0; // 续传时保留已有进度
  d.lastProgressAt = Date.now(); // 派发即记"最后活跃"：启动/解析阶段计入宽限期，防误判停滞
  d.lastDone = 0; // 派发清零：progress done 从 0 开始计数，防旧值干扰停滞判定
  d.lastDoneAt = Date.now(); // done 增长的初始基准：派发即记，覆盖 m3u8 获取/解析/跳过批次的启动期
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
    format: d.format, // 入队时的格式（部分站点等 URL 无 .mp4 后缀时靠 Content-Type 识别）
  };

  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch (err) {
    // content script 未注入 → 尝试注入
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['src/content/log.js', 'src/content/opfs.js', 'src/content/formats.js', 'src/content/hls.js', 'src/content/downloader.js', 'src/content/merge.js', 'src/content/sniffer.js', 'src/content/main.js'],
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

  // 优先任务：priority 用负向计数器递减（--priorityFloor），O(1) 且必排最前，
  // 避免 Math.min 全量扫描和 priority 无界负增长
  d.priority = --state.priorityFloor;
  const q = state.tabQueues[d.tabId];
  if (q) {
    const i = q.indexOf(downloadId);
    if (i >= 0) q.splice(i, 1);
    q.unshift(downloadId);
  }
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
  log('info', `[优先] ${taskLabel(downloadId)} 已标记优先排到队首（priority=${d.priority}）${victims.length ? `，替换 ${victims.length} 个任务` : ''}`);
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

    // 收集所有可派发的候选（排队中且所在 tab 空闲）
    const candidates = [];
    for (const tid of Object.keys(state.tabQueues)) {
      const tabId = Number(tid);
      if (state.tabActive[tabId]) continue; // 该 tab 已有活动任务
      for (const did of state.tabQueues[tabId]) {
        const d = state.downloads[did];
        if (d && d.status === 'queued') candidates.push({
          tabId, did,
          priority: d.priority ?? Number.MAX_SAFE_INTEGER, // 统一优先级序号：小 = 先派发
        });
      }
    }
    // 排序：单一 priority 序号（创建 FIFO / 优先=减到最小 / 停滞重排=加到最大）
    candidates.sort((a, b) => a.priority - b.priority);
    log('debug', `[调度] 候选: ${candidates.map(c => `#${c.did}(${c.priority})`).join(', ')}`);

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
    d.stallCount = 0; // 手动恢复 = 新的尝试周期
    // 手动恢复 = 新的尝试周期，priority 保持原 FIFO 位置
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

// ============ 状态机公共操作（消除 main.js/stalled.js 复制粘贴，review P0-2） ============

// 被优先替换任务回队首：转 queued + unshift（priority 保持原值，优先任务必排最前）
export function requeueToFront(d) {
  d.status = 'queued';
  d.error = null;
  if (!state.tabQueues[d.tabId]) state.tabQueues[d.tabId] = [];
  const q = state.tabQueues[d.tabId];
  const qi = q.indexOf(d.id);
  if (qi >= 0) q.splice(qi, 1);
  q.unshift(d.id);
  // ★ 不能碰 tabActive：被替换任务标 stopping 时（prioritizeDownload）已释放自己槽，
  //   之后该 tab 的槽可能被优先任务或队列其他任务占用。再设 null 会清掉别人的槽 →
  //   并发计数少 1 → maybeDispatch 误判 tab 空闲 → 多派发/同 tab 双任务（review P0-2 抽取引入的回归）
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
  maybeDispatch();
}

// 停滞重排：累计 consecutiveFails（≤3 重排队尾 priority=++prioritySeq，超过标 failed 放弃）
// timeout=true 时文案标注"停止确认超时"（content 无响应兜底路径）
// 停滞重排：用独立 stallCount 控制"停滞→重排"循环次数。
// 原则（用户确认）：失败先丢 fail 队列，别让一个卡住的任务反复循环重试占用并发槽、
// 拖累其他任务（会把后续任务拖到签名 URL 过期）。停滞只自动重排 1 次
//（可能是瞬时卡顿，新循环可救回）；第 2 次停滞直接 failed——不再 3 次循环。
// timeout=true 时文案标注"停止确认超时"（content 无响应兜底路径，调用方已先判 tab 死活）
export function requeueStalled(d, timeout) {
  const stuck = (d.stallCount || 0) + 1;
  d.stallCount = stuck;
  if (stuck <= 1) {
    d.status = 'queued';
    d.error = timeout ? '停止确认超时，自动重排队尾（仅此 1 次）' : '无进度自动重排（仅此 1 次，再停滞将放弃）';
    d.priority = ++state.prioritySeq;
    if (!state.tabQueues[d.tabId]) state.tabQueues[d.tabId] = [];
    if (!state.tabQueues[d.tabId].includes(d.id)) state.tabQueues[d.tabId].push(d.id);
    state.tabActive[d.tabId] = null;
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    log('warn', `[停滞] ${taskLabel(d.id)} ${timeout ? '停止确认超时' : '停止已确认'}，自动重排队尾（1/1，priority=${d.priority}）`);
    maybeDispatch();
  } else {
    d.status = 'failed';
    d.error = `连续停滞 ${stuck} 次，自动放弃（分片保留，可手动重试自动续传）`;
    state.tabActive[d.tabId] = null;
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    log('warn', `[停滞] ${taskLabel(d.id)} 连续停滞 ${stuck} 次，标为失败不再循环重试`);
    maybeDispatch();
  }
}
