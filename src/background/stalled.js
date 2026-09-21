// stalled.js — StreamCap 保活 alarm + 停滞判定/心跳探测/页面停摆刷新复活
import { state, persist, broadcast, taskLabel } from './state.js';
import { maybeDispatch } from './scheduler.js';
import { queueTask, queueTaskFront, onTaskSettled, isQueued } from './pool.js';
import { log } from './log.js';
import { findHostForTask, migrateTaskToTab } from './host.js';

const HOST_GRACE_MS = 90000; // 宿主/content 心跳宽限（原为 60s/120s 两套，已统一）
const DONE_TIMEOUT = 90000;    // 90s 内既无分片增长、也无任何请求活动 → 判停摆
const DONE_STALL_MS = 240000;  // 4 分钟只有请求活动、分片数一片不涨 → 同样判停摆（疑似被节流）
const MERGE_STALL_MS = 600000; // 10 分钟：分片已下完（正在合并/导出）时的停摆宽限 —— 超时仍会动手，避免合并真卡死无人管
const RETRY_STUCK_MS = 60000;  // retrying 持续超过 60s（最大退避只有 9s）→ 退避定时器已丢
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
//（PING 2s 不通，且最近 HOST_GRACE_MS(90s) 无心跳——心跳 10s 一次，90s 无 = content 消息循环已停）。
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
  return !(d.lastPing && Date.now() - d.lastPing < HOST_GRACE_MS);
}
// 快速失败：直接 failed 丢 fail 队列并释放并发槽（分片保留，手动重试走接管续传）
function failTaskQuick(d, reason) {
  d.status = 'failed';
  d.error = `${reason}（分片保留，可手动重试自动续传）`;
  onTaskSettled(d); // v5：统一收尾（释放槽 + 归还承载页 + 继续调度），与其它结束路径一致
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

  // ② 慢慢找宿主（探测不阻塞调度）。★ 整段兜底：内部 await 抛错（tab 恰在此刻关闭、
  //   探测异常）会把任务永久丢在"状态 queued 却不在 readyQueue"的中间态 ——
  //   既不占槽也不会被停滞判定看到（那里只看 downloading），真机表现就是完全静默地卡住。
  //   出错时放回队列，下一轮 alarm 会重新尝试，而不是把它留成幽灵任务。
  let hostId = null;
  try {
    hostId = await findHostForTask(d, { origId: d.tabId, openNewTab: false });
  } catch (e) {
    log('warn', `[停滞] ${taskLabel(d.id)} 寻找接管页面时出错：${e && e.message} → 放回队列稍后重试`);
    queueTask(d.id);
    maybeDispatch();
    return false;
  }
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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function originOf(u) { try { return new URL(u).origin; } catch { return ''; } }
// 等 content 重新就绪（每 500ms 探一次 PING，共 tries 次）
async function waitContent(tabId, tries) {
  for (let i = 0; i < tries; i++) {
    await sleep(500);
    if (await pingContent(tabId)) return true;
  }
  return false;
}
async function reloadTaskTab(d, reason) {
  if (d.status === 'exporting') return; // 导出中的 blob 随页面销毁会丢 → 绝不重载
  const tabId = d.tabId;
  const n = (d.reloadCount || 0) + 1;
  if (n > MAX_RELOAD) {
    failTaskQuick(d, `${reason}，已重新加载页面 ${MAX_RELOAD} 次仍无进展`);
    return;
  }
  d.reloadCount = n;
  // 让位：重载期间不占并发槽（页面随即被销毁，content 循环自然消失）
  if (state.tabActive[tabId] === d.id) state.tabActive[tabId] = null;
  d.status = 'queued'; // 回队列；done/pct 保留 → 续传（不是从头下）
  d.error = `${reason}，正在重新加载页面续传（${n}/${MAX_RELOAD}）`;
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
  maybeDispatch(); // 空出的并发槽先让给其他任务
  log('warn', `[节流] ${taskLabel(d.id)} ${reason} → 重新加载 tab${tabId} 续传（${n}/${MAX_RELOAD}）`);

  // ★★ 用 tabs.update({url}) 做**一次全新的 GET 导航**，而不是 tabs.reload()。
  //   真机现象：reload 的语义是"重新执行当前文档的加载" —— 若该文档由 POST 表单产生
  //   （有些站点"点播放"其实是提交表单），Chrome 会先弹「确认重新提交表单」；用户点继续后
  //   服务器对该 URL 返回 405（只接受 GET，或那次 POST 依赖一次性 token）→ 页面变错误页
  //   → content 不再注入 → 等就绪 20s 超时 → 任务被标失败。
  //   用户手动按 F5 不弹框，说明那一刻页面已是 GET 文档 —— 这恰好证明"强制 GET"是安全的：
  //   显式导航与手动刷新等效，且对 GET/POST 两种文档状态都不会再触发表单重提。
  const navUrl = /^https?:/i.test(d.pageUrl || '') ? d.pageUrl : '';
  let ready = false;
  try {
    if (navUrl) await chrome.tabs.update(tabId, { url: navUrl });
    else await chrome.tabs.reload(tabId); // 没有可用的来源页 URL 时退回旧行为
    ready = await waitContent(tabId, 40); // ≤20s，与 acquireTabFor 打开新页后的就绪轮询同规格
  } catch (e) {
    // ★ 兜底：导航/轮询期间抛错（tab 恰在此刻被关闭、SW 时间片被打断）不能让任务停在中间态
    //   ——状态 queued 却不在队列 = 不占槽、不调度、无日志（真机反馈的"完全没反应"）。
    //   放回队列，下一轮 alarm 会重新尝试。
    log('warn', `[节流] ${taskLabel(d.id)} 重载页面出错：${e && e.message} → 放回队列稍后重试`);
    queueTask(d.id);
    maybeDispatch();
    return;
  }
  // ★ 方案 B 兜底：原页面救不回来（405 / 错误页 / 只接受 POST）→ 把承载页导航到**站点根**。
  //   下载只要求"同一个 origin 的页面"（OPFS 按 origin 隔离、Referer 是 origin 级，任务用的
  //   是已保存的绝对 URL、不依赖页面状态），不需要正好是那个视频页 —— 站点首页足够承载。
  if (!ready && navUrl) {
    const org = originOf(navUrl);
    if (org) {
      log('warn', `[节流] ${taskLabel(d.id)} 原页面加载不出来 → 改用站点根 ${org}/ 作承载页（下载只需同源页面）`);
      try {
        await chrome.tabs.update(tabId, { url: org + '/' });
        ready = await waitContent(tabId, 40);
      } catch { /* ignore */ }
    }
  }
  if (!ready) {
    failTaskQuick(d, `${reason}，重载后页面仍无响应`);
    return;
  }
  // 页面同源即可承载（URL 可能已变成站点根）→ 放回队首优先续传。
  // 签名过期不在这里处理：页面加载后 content 会重新嗅探写入 sniffStore，
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

  const now = Date.now();

  // ============ 自愈：把卡在"没人管"状态的任务放回队列 ============
  // ★ 为什么必须有这一段（真机反馈"任务没进度、没有调度、日志也没记录"）：
  //   MV3 的 setTimeout 不可靠 —— 退避重派（main.js）与让位后回队首（scheduler.js）都靠它，
  //   SW 被回收时定时器随之丢失，任务就永远停在中间态：状态看着还是"排队中/重试中"，
  //   却不在 readyQueue → 既不会被派发，也不会被下面的停滞判定看到（那里只看 downloading）
  //   → 完全静默。用每分钟一次的 alarm 兜底，比另开一个 alarm 更省事也更可靠。
  // 幽灵 queued：状态是排队中却不在队列。（正在派发的有 running、主动让位等旧循环退出的
  //   有 tabActive，都会被后两个条件排除，不会误放回来。）
  const ghosts = Object.values(state.downloads).filter(d =>
    d.status === 'queued' && !isQueued(d.id) && !state.running[d.id] && !state.tabActive[d.tabId]
  );
  for (const d of ghosts) {
    queueTask(d.id);
    log('warn', `[调度] ${taskLabel(d.id)} 状态为排队中却不在队列（定时器丢失？）→ 放回队列重派`);
  }
  // 卡死的 retrying：最大退避只有 9s，超过 RETRY_STUCK_MS 还是 retrying 必然是定时器丢了
  const stuckRetry = Object.values(state.downloads).filter(d =>
    d.status === 'retrying' && !state.running[d.id] &&
    now - (d.lastRetryAt || d.lastProgressAt || d.createdAt || 0) > RETRY_STUCK_MS
  );
  for (const d of stuckRetry) {
    d.status = 'queued';
    d.error = null;
    queueTask(d.id);
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    log('warn', `[调度] ${taskLabel(d.id)} 停在重试态超过 ${RETRY_STUCK_MS / 1000}s（退避定时器丢失）→ 放回队列`);
  }
  if (ghosts.length || stuckRetry.length) maybeDispatch();

  // 无进度超时判定：下载中任务若已下载分片数长时间无增长，说明下载循环卡死
  // （fetch 挂起/页面冻结后消息循环还活着但下载不推进）。
  // 判定依据是 done（已下载分片数）增长，而非收到消息：content 的节流上报/心跳
  // 是独立定时器，循环卡死时照样在发，导致 lastProgressAt/lastPing 永远新鲜，
  // 任务永远踢不出去。lastDoneAt 只在 done 真正增长时刷新（见 main.js PROGRESS 处理）。
  const stalled = Object.values(state.downloads).filter(d => {
    if (d.status !== 'downloading') return false;
    // ★★ 分片已全部下载完（done 达到 total）→ 剩下的只是**合并/导出**，本来就不会再有分片增长。
    //   这类任务绝对不能按"停摆"处理：刷新页面会把正在进行的合并打断，页面重载后任务又被
    //   重新派发（分片还在，因为 FINALIZE_DOWNLOAD 没执行），于是**再合并、再导出一次** ——
    //   而 Chrome 的 conflictAction:'uniquify' 遇到同名不覆盖、另存为 "xxx (1).mp4"，
    //   真机表现就是「E:\Downloads 大量文件重复落盘」。合并阶段由 content 的
    //   reportActivity 保活（见 downloader.js），不再需要这里的超时兜底。
    if (d.total > 0 && (d.done || 0) >= d.total) {
      // ★ 分片已下完 = 只剩合并/导出，本来就不会再有分片增长，不能按 90s/4 分钟判停摆。
      //   但**不能无条件跳过**：合并真卡死（OPFS 读取挂起、连 activity 心跳都停）时必须有人
      //   管它，否则任务会永远卡在 downloading。所以给一个明显更长的宽限，超时仍按停摆处理。
      const lastMergeAlive = Math.max(d.lastDoneAt || 0, d.lastActivityAt || 0, d.createdAt || 0);
      return now - lastMergeAlive > MERGE_STALL_MS;
    }
    // 判定依据 = 最近一次**真实活动**：done 增长（lastDoneAt）或任意分片/分块请求尝试
    // （lastActivityAt，由 content 的 reportActivity 在每次网络尝试时刷新）。
    // 真卡死（fetch 挂起、无任何回调）→ 两者都不动 → 90s 后被抓；
    // 慢下载 / 坏分片重试中（每 ≤20s 一次尝试）→ 有活动 → 不被误判为卡死。
    // ★ 仍不能用 lastProgressAt：节流上报是 setInterval，循环卡死时照样在发。
    const lastAlive = Math.max(d.lastDoneAt || 0, d.lastActivityAt || 0, d.createdAt || 0);
    if (now - lastAlive > DONE_TIMEOUT) return true;
    // ★ 零进展判据（补"有活动"这个口子）：页面被浏览器节流时，分片请求会**持续尝试**、
    //   每次都刷新 lastActivityAt，但全部超时失败 → done 一片都不涨。只看"有没有活动"
    //   就永远抓不到它 —— 这正是"任务没进度、检测却不触发、日志也没记录"的形态。
    //   4 分钟一片没涨（正常慢速下载 4 分钟至少也要完成几片）→ 同样按停摆处理。
    const lastProgress = Math.max(d.lastDoneAt || 0, d.createdAt || 0);
    return now - lastProgress > DONE_STALL_MS;
  });
  for (const d of stalled) {
    // tabActive 归属校验：只有当前仍由本任务占用并发槽时才动它，避免误清该 tab 其他任务的槽。
    // ★ 但必须留日志：以前这里静默 continue，一旦归属对不上（SW 重启后的残留记录等），
    //   任务既不会被救、也查不到任何线索。
    if (state.tabActive[d.tabId] !== d.id) {
      log('warn', `[停滞] ${taskLabel(d.id)} 疑似停摆，但并发槽归属不是它（tab${d.tabId}）→ 本轮跳过`);
      continue;
    }
    // 停摆原因分开记：排查时能一眼区分"彻底没动静"与"被节流拖着空转"
    const idle = now - Math.max(d.lastDoneAt || 0, d.lastActivityAt || 0, d.createdAt || 0) > DONE_TIMEOUT;
    const stallReason = idle
      ? `页面停摆（${DONE_TIMEOUT / 1000}s 内无任何请求活动）`
      : `页面停摆（${Math.round(DONE_STALL_MS / 60000)} 分钟无分片进展，疑似被浏览器节流）`;
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
    //③ 页面活着但"停摆"：PING 通、心跳新鲜，可是分片长时间不涨。
    //    旧逻辑在这里发 CANCEL 走 停止中态→重排，等于把任务放回**同一个卡住的页面**反复重来；
    //    改为**刷新该页面 → 等 content 重新就绪 → 重新注入任务**：
    //    OPFS 分片按 origin 存盘、不随页面销毁，刷新后按 resumeFrom 继续，进度不丢。
    //    （实测：被节流的页面重建后恢复正常速度；重启浏览器 + 新建页后 8 并发健康跑数小时。）
    await reloadTaskTab(d, stallReason);
  }
  if (stalled.length > 0) maybeDispatch();

  // 心跳兜底：SW 刚被唤醒时，检查 downloading 任务是否还活着。
  // ★ 放在无进度停摆判定**之后**：pingDeadTask 会先把无响应任务标 paused 并清 tabActive，
  //   若先跑心跳，停摆检测会在 `if (state.tabActive[d.tabId] !== d.id) continue;` 处跳过，
  //   把本可"刷新复活"的任务提前吞掉（v5 防呆修复）。
  // 若 content 已死（页面被冻结/关闭），标为可续传暂停并让出并发槽。
  const pingers = Object.values(state.downloads)
    .filter(d => d.status === 'downloading')
    .map(d => pingDeadTask(d, '页面无响应（后台冻结/关闭），可点继续续传'));
  Promise.allSettled(pingers).then(() => {
    maybeDispatch(); // 队列里若有 queued 任务，趁机派发
  });
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
      // 最近 HOST_GRACE_MS(90s) 内收到过 content 心跳 → content 还活着，只是 PING 消息延迟/后台节流，不误伤
      if (cur && cur.lastPing && Date.now() - cur.lastPing < HOST_GRACE_MS) return;
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
