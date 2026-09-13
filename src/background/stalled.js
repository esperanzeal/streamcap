// stalled.js — StreamCap 保活 alarm + 停滞判定/心跳探测/页面停摆刷新复活
import { state, persist, broadcast, taskLabel } from './state.js';
import { maybeDispatch } from './scheduler.js';
import { queueTaskFront } from './pool.js';
import { log } from './log.js';
import { findHostForTask, migrateTaskToTab } from './host.js';

const KEEPALIVE_ALARM = 'vgp_keepalive';
const CLEANUP_ALARM = 'vgp_cleanup';

// ============ 宿主 tab 存活检测 + 快速失败 ============
// 原则（用户确认）：失败先丢 fail 队列，别让死 tab 的任务反复重试/重排空转浪费时间、
// 占用并发槽拖累其他任务。识别到宿主 tab 已死（关闭/冻结无响应）→ 直接 failed。
function pingContent(tabId) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, r => resolve(!chrome.runtime.lastError && r && r.ok === true));
    } catch { resolve(false); }
  });
}
// 判定宿主 tab 是否真死：tab 已关闭（tabs.get 失败）或 content 无响应
//（PING 2s 不通，且最近 60s 无心跳——心跳 10s 一次，60s 无 = content 消息循环已停）。
// PING 不通但心跳新鲜：可能只是后台节流消息延迟，保守不算死（交给心跳路径处理）。
async function hostTabDead(d) {
  if (!d.tabId) return true;
  let tab;
  try { tab = await chrome.tabs.get(d.tabId); } catch { return true; }
  // ★ Memory Saver 丢弃的 tab：页面已冻结、content 不运行，下载必然无法推进
  //   → 直接判死（此前 PING 超时后 60s 心跳豁免可能让它多等一分钟才判死）
  if (tab.discarded) return true;
  const alive = await pingContent(d.tabId);
  if (alive) return false;
  return !(d.lastPing && Date.now() - d.lastPing < 60000);
}
// 快速失败：直接 failed 丢 fail 队列并释放并发槽（分片保留，手动重试走接管续传）
function failTaskQuick(d, reason) {
  d.status = 'failed';
  d.error = `${reason}（分片保留，可手动重试自动续传）`;
  state.tabActive[d.tabId] = null;
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
  log('warn', `[停滞] ${taskLabel(d.id)} ${reason}，标为失败不再重试`);
}

// 死宿主自动接管（停滞/超时共用，自动路径）：
// 宿主 tab 已死 → 先立即让位（释放并发槽，找宿主可能要逐个 PING/探测耗时数秒，
// 不能让停滞任务继续占槽拖累其他任务）→ 再找**已开启**的活同源宿主
// （openNewTab=false，无人值守不开新页）；有 → 迁移等待续传（resetCounters=false
// 保留停滞计数 → 反复停滞最终 failed，有界）；无 → failed 丢 fail 队列。
async function tryAutoAdopt(d, deadReason) {
  // ① 立即让位：释放并发槽 + 中间态（不入任何队列，宿主确定后再 migrate 入队）
  if (state.tabActive[d.tabId] === d.id) state.tabActive[d.tabId] = null;
  d.status = 'queued';
  d.error = `${deadReason}，正在寻找同源标签页接管...`;
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
  maybeDispatch(); // 空出的并发槽立刻让给其他任务

  // ② 慢慢找宿主（探测不阻塞调度）
  const hostId = await findHostForTask(d, { origId: d.tabId, openNewTab: false });
  if (hostId !== null) {
    migrateTaskToTab(d, hostId, false); // 保留计数：换宿主尝试有界
    d.error = `${deadReason}，已迁移到同源标签页等待续传`;
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    log('warn', `[停滞] ${taskLabel(d.id)} ${deadReason}，迁移到 tab${hostId} 等待续传（计数保留）`);
    maybeDispatch();
    return true;
  }
  failTaskQuick(d, `${deadReason}，且无同源可用页面`);
  return false;
}

// 页面停摆/被回收 → 刷新该 tab 并重新注入任务（用户拍板：降速异常就刷新重新加载）。
// 为什么刷新有效：OPFS 分片按 origin 存盘、不随页面销毁 → 刷新后按 resumeFrom 继续续传；
// 而浏览器对标签的节流（后台降级 / Memory Saver 丢弃）会随页面重建解除
// （真机实测：被节流的任务重建页面后恢复正常速度，重启后 8 并发可健康跑数小时）。
// 与"死宿主"的区别：这里页面还活着（PING 通、心跳新鲜），只是没在跑。
// 有界：同一任务最多刷新 MAX_RELOAD 次；有真实进展时 main.js 会把 reloadCount 清零。
const MAX_RELOAD = 3;
async function reloadTaskTab(d, reason) {
  if (d.status === 'exporting') return; // 导出中的 blob 随页面销毁会丢 → 绝不刷新
  const tabId = d.tabId;
  const n = (d.reloadCount || 0) + 1;
  if (n > MAX_RELOAD) {
    failTaskQuick(d, `${reason}，已刷新页面 ${MAX_RELOAD} 次仍无进展`);
    return;
  }
  d.reloadCount = n;
  // 让位：刷新期间不占并发槽（页面随即被销毁，content 循环自然消失）
  if (state.tabActive[tabId] === d.id) state.tabActive[tabId] = null;
  d.status = 'queued'; // 回队列；done/pct 保留 → 续传（不是从头下）
  d.error = `${reason}，正在刷新页面重新续传（${n}/${MAX_RELOAD}）`;
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
  maybeDispatch(); // 空出的并发槽先让给其他任务
  log('warn', `[节流] ${taskLabel(d.id)} ${reason} → 刷新 tab${tabId} 重新续传（${n}/${MAX_RELOAD}）`);
  try {
    await chrome.tabs.reload(tabId);
  } catch {
    failTaskQuick(d, `${reason}，且页面已关闭无法刷新`);
    return;
  }
  // 等 content 重新注入（≤20s，与 findHostForTask 打开新页后的就绪轮询同规格）
  let ready = false;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await pingContent(tabId)) { ready = true; break; }
  }
  if (!ready) {
    failTaskQuick(d, `${reason}，刷新后页面仍无响应`);
    return;
  }
  // 页面 URL 未变（同源）→ 放回该 tab 队首优先续传。
  // 签名过期不在这里处理：页面刷新后 content 会重新嗅探写入 sniffStore，
  // 下载流程也会重新拉取清单 → 新签名自然生效。
  queueTaskFront(d.id);
  maybeDispatch();
}


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

chrome.alarms.onAlarm.addListener(async (alarm) => {
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
  // v5：queued 任务不再绑定某个 tab（tab 只是承载页）→ 承载页关闭不必标失败，
  //   调度器下一轮 pump 会给它复用/新建承载页。只有任务连来源页都没有、
  //   根本无法建立承载页时，才算真的无法继续（提示用户去原视频页重新嗅探）。
  const orphans = Object.values(state.downloads).filter(d =>
    d.status === "queued" && !d.pageUrl && !d.referer
  );
  for (const d of orphans) {
    d.status = "failed";
    d.error = "缺少来源页面信息，无法建立承载页（请在原视频页重新嗅探后重试）";
    persist();
    broadcast({ type: "DOWNLOAD_UPDATE", download: d });
  }

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
  const DONE_TIMEOUT = 90000; // 90s 既无进度增长、也无任何请求活动 → 判停滞踢出
  const stalled = Object.values(state.downloads).filter(d => {
    if (d.status !== 'downloading') return false;
    // 判定依据 = 最近一次**真实活动**：done 增长（lastDoneAt）或任意分片/分块请求尝试
    // （lastActivityAt，由 content 的 reportActivity 在每次网络尝试时刷新）。
    // 真卡死（fetch 挂起、无任何回调）→ 两者都不动 → 仍会在 90s 后被抓；
    // 慢下载 / 坏分片重试中（每 ≤20s 一次尝试）→ 有活动 → 不再被误判为卡死。
    // ★ 仍不能用 lastProgressAt：15s 节流上报是 setInterval，循环卡死时照样在发。
    const lastAlive = Math.max(d.lastDoneAt || 0, d.lastActivityAt || 0, d.createdAt || 0);
    return now - lastAlive > DONE_TIMEOUT;
  });
  for (const d of stalled) {
    // tabActive 归属校验：只有当前仍由本任务占用并发槽时才释放，避免误清该 tab 其他任务的槽
    if (state.tabActive[d.tabId] !== d.id) continue;
    // ① 页面被 Memory Saver 丢弃（tab 还在、页面已被卸载）→ 刷新即可复活（OPFS 分片不丢）
    let tabInfo = null;
    try { tabInfo = await chrome.tabs.get(d.tabId); } catch { tabInfo = null; }
    if (tabInfo && tabInfo.discarded) {
      await reloadTaskTab(d, '页面已被浏览器回收');
      continue;
    }
    // ② 页面真死（tab 已关闭 / PING 不通且心跳也停）→ 自动接管：找已开启的活同源宿主
    //    等待续传（无人值守不开新页）；找不到才 failed（用户拍板）
    if (await hostTabDead(d)) {
      await tryAutoAdopt(d, '页面已关闭或无响应');
      continue;
    }
    //③ 页面活着但"停摆"：PING 通、心跳新鲜，可是 done 与请求活动双陈旧（DONE_TIMEOUT 90s 无任何进展）
    //    —— 典型表现是浏览器对标签节流（实测：被节流的页面重建后恢复正常速度；
    //    重启浏览器 + 新建页后 8 并发健康跑数小时）。
    //    旧逻辑在这里发 CANCEL 走 stopping→重排，等于把任务放回**同一个卡住的页面**反复重来；
    //    改为**刷新该页面 → 等 content 重新就绪 → 重新注入任务**：
    //    OPFS 分片按 origin 存盘、不随页面销毁，刷新后按 resumeFrom 继续，进度不丢。
    await reloadTaskTab(d, '页面停摆（疑似被浏览器节流）');
  }
  if (stalled.length > 0) maybeDispatch();
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
