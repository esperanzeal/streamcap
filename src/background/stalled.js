// stalled.js — StreamCap 保活 alarm + 停滞判定/心跳探测/stopping 兜底
import { state, persist, broadcast, taskLabel } from './state.js';
import { maybeDispatch } from './scheduler.js';
import { log } from './log.js';

const KEEPALIVE_ALARM = 'vgp_keepalive';
const CLEANUP_ALARM = 'vgp_cleanup';

export function ensureKeepaliveAlarm() {
  chrome.alarms.get(KEEPALIVE_ALARM, a => {
    if (!a) {
      // periodInMinutes: 1 = Chrome 116 允许的最小周期；SW 空闲 30s 被杀后，
      // 最迟 1 分钟内被唤醒重建队列，避免 queued 任务无人调度。
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1, delayInMinutes: 1 });
    }
  });
  // 定期 OPFS 孤儿分片清理（每 30 分钟），避免仅靠 SW 启动一次清理导致长期累积
  chrome.alarms.get(CLEANUP_ALARM, a => {
    if (!a) {
      chrome.alarms.create(CLEANUP_ALARM, { periodInMinutes: 30, delayInMinutes: 5 });
    }
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CLEANUP_ALARM) {
    // 定期清理：通知所有打开的 tab 删除孤儿 OPFS 分片
    const activeIds = Object.values(state.downloads).map(d => d.id);
    chrome.tabs.query({}, tabs => {
      for (const t of tabs) {
        chrome.tabs.sendMessage(t.id, { type: 'CLEANUP_OPFS', activeDownloadIds: activeIds }).catch(() => {});
      }
    });
    return;
  }

  if (alarm.name !== KEEPALIVE_ALARM) return;
  // 心跳兜底：SW 刚被唤醒时，检查 downloading 任务是否还活着。
  // 若 content 已死（页面被冻结/关闭），标为可续传暂停并让出并发槽。
  const pingers = Object.values(state.downloads)
    .filter(d => d.status === 'downloading')
    .map(d => pingDeadTask(d, '页面无响应（后台冻结/关闭），可点继续续传'));
  Promise.allSettled(pingers).then(() => {
    maybeDispatch(); // 队列里若有 queued 任务，趁机派发
  });

  // 无进度超时判定：下载中任务若已下载分片数长时间无增长，说明下载循环卡死
  // （fetch 挂起/页面冻结后消息循环还活着但下载不推进）。把任务标为可续传暂停、
  // 释放并发槽、记录 stalledAt 排到队尾——恢复调度后它排最后执行，不反复占槽。
  // 判定依据是 done（已下载分片数）增长，而非收到消息：content 的节流上报/心跳
  // 是独立定时器，循环卡死时照样在发，导致 lastProgressAt/lastPing 永远新鲜，
  // 任务永远踢不出去。lastDoneAt 只在 done 真正增长时刷新（见 main.js PROGRESS 处理）。
  const now = Date.now();
  const DONE_TIMEOUT = 90000; // 90s 无进度增长（done 不变）→ 判停滞踢出
  const stalled = Object.values(state.downloads).filter(d => {
    if (d.status !== 'downloading') return false;
    // 真卡死（fetch 挂起/循环死）时 done 永远不涨；慢下载/重试阶段 done 会涨（慢但涨）。
    const doneStalled = now - (d.lastDoneAt || d.createdAt || 0) > DONE_TIMEOUT;
    return doneStalled;
  });
  for (const d of stalled) {
    // tabActive 归属校验：只有当前仍由本任务占用并发槽时才释放，避免误清该 tab 其他任务的槽
    if (state.tabActive[d.tabId] !== d.id) continue;
    // 两阶段停止：先发 CANCEL 通知 content 停止下载循环，任务进入 stopping 状态
    // （占槽但不算 downloading、不参与重派），等 content 上报 DOWNLOAD_ERROR 确认
    // 旧循环已退出后，才转 queued 重新入队由调度器重派。避免"不等确认就重派"
    // 导致：新 START 撞上旧循环被忽略 / 迟到 DOWNLOAD_ERROR 双计数 / 状态抖动。
    d.status = 'stopping';
    d.error = '无进度，等待停止确认后自动重排';
    d.stopPendingAt = Date.now(); // 超时兜底：content 无响应时强制转 queued
    // 通知 content 停止下载循环（防卡死循环继续空转/继续占资源）
    chrome.tabs.sendMessage(d.tabId, { type: 'CANCEL_DOWNLOAD', downloadId: d.id, reason: 'stalled' }).catch(() => {});
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    log('warn', `[停滞] ${taskLabel(d.id)} 无进度超过 ${DONE_TIMEOUT / 1000}s，已发送停止信号，等待确认后自动重排`);
  }
  // stopping 超时兜底：content 已死（页面关闭/冻结无响应）→ 收不到 DOWNLOAD_ERROR 确认，
  // 30s 后强制转 queued 重派（此时旧循环必然已随页面销毁，无竞态）
  const now2 = Date.now();
  const stuck = Object.values(state.downloads).filter(d => d.status === 'stopping' && d.stopPendingAt && now2 - d.stopPendingAt > 30000);
  for (const d of stuck) {
    // 释放并发槽：stopping 一直占着槽（等待确认），超时兜底转 queued 时必须释放，
    // 否则 maybeDispatch 因 tabActive[tabId] 非空永久跳过该 tab，任务卡死永不重派
    state.tabActive[d.tabId] = null;
    // ★ 被优先下载替换的任务：超时兜底同样回队列（不计连续失败），priority 保持原值
    //   与确认路径行为一致，避免 content 无响应时被误按停滞重排（排队尾+累计 fails）。
    if (d.replacedFlag) {
      delete d.replacedFlag;
      d.status = 'queued';
      d.error = null;
      if (!state.tabQueues[d.tabId]) state.tabQueues[d.tabId] = [];
      const q = state.tabQueues[d.tabId];
      const qi = q.indexOf(d.id);
      if (qi >= 0) q.splice(qi, 1);
      q.unshift(d.id);
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      log('warn', `[优先] ${taskLabel(d.id)} 停止确认超时（content 无响应），回队列（priority=${d.priority}）`);
      continue;
    }
    // 与确认路径一致：超时兜底也累计 consecutiveFails（≤3 次自动重派，超过标 failed 放弃）——
    // 否则 content 死透的任务会无限"超时重排→重派→再超时"循环，永不放弃
    const act = Object.values(state.downloads)
      .filter(x => !['completed', 'failed', 'cancelled'].includes(x.status) && x.id !== d.id);
    const fails = (d.consecutiveFails || 0) + 1;
    d.consecutiveFails = fails;
    if (fails <= 3) {
      d.status = 'queued';
      d.error = `停止确认超时，自动重排队尾（${fails}/3）`;
      d.priority = Math.max(...act.map(x => x.priority ?? 0)) + 1; // 排到队尾
      if (!state.tabQueues[d.tabId]) state.tabQueues[d.tabId] = [];
      if (!state.tabQueues[d.tabId].includes(d.id)) state.tabQueues[d.tabId].push(d.id);
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      log('warn', `[停滞] ${taskLabel(d.id)} 停止确认超时（content 无响应），自动重排队尾（${fails}/3，priority=${d.priority}）`);
    } else {
      d.status = 'failed';
      d.error = `连续 ${fails} 次无进度，自动放弃（分片保留，可手动重试）`;
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      log('warn', `[停滞] ${taskLabel(d.id)} 连续 ${fails} 次无进度（超时兜底），标为失败`);
    }
  }
  if (stalled.length > 0 || stuck.length > 0) maybeDispatch();
});

// 心跳探测：downloading 任务若 content script 已死（页面导航/刷新/冻结后无感知），
// 会永远卡 downloading 且占着并发槽。ping 无响应 → 标为可续传暂停。
// 带 tabActive 归属校验：ping 超时窗口内用户可能"暂停→继续"换过任务，
// 只有当前仍由本任务占用并发槽时才标记暂停，避免误伤刚恢复的任务。
// 并行探测 + 每任务超时：冻结的 tab 若消息不返回，不能卡住后续任务的探测。
// 导出给 main.js 恢复逻辑使用（SW 重启后对 downloading 任务逐个 ping）。
export function pingDeadTask(d, pauseReason) {
  const withTimeout = (p, ms) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ping timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
  return withTimeout(chrome.tabs.sendMessage(d.tabId, { type: 'PING' }), 2000)
    .catch(() => {
      const cur = state.downloads[d.id];
      // 最近 120s 内收到过 content 心跳 → content 还活着，只是 PING 消息延迟/后台节流，不误伤
      if (cur && cur.lastPing && Date.now() - cur.lastPing < 120000) return;
      if (cur && cur.status === 'downloading' && state.tabActive[cur.tabId] === cur.id) {
        cur.status = 'paused';
        cur.error = pauseReason;
        state.tabActive[cur.tabId] = null;
        // 通知 content 停止下载（与 pauseDownload 对齐，防循环继续写 OPFS）
        chrome.tabs.sendMessage(cur.tabId, { type: 'CANCEL_DOWNLOAD', downloadId: cur.id, reason: 'heartbeat' }).catch(() => {});
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: cur });
        log('warn', `[心跳] ${taskLabel(cur.id)} content 无响应，标为可续传暂停`);
        maybeDispatch();
      }
    });
}
