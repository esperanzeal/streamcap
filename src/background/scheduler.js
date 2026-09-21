// scheduler.js — 队列/调度/暂停/取消（v5：薄层，核心调度在 pool.js）
//
// v5 与旧版的区别：
//   · 任务不再排进"某个 tab 的队列"（旧 state.tabQueues），而是排进全局 state.readyQueue；
//     旧结构下"任务排在哪个 tab 上"决定它何时能跑 —— 某 tab 被占时挂在该 tab 的任务全部
//     冻结（即使全局有空槽也调度不到），这是"占着 tab 不放、后续任务永远等不到"的根因。
//   · 派发交给 pool.pump()：有空槽 + 有就绪任务 → 取承载页 tab（同源复用/按需新建）→ 注入；
//   · maybeDispatch 保留原名（main.js/stalled.js 等 47 处调用点零改动），内部即 pump()；
//   · 任务结束统一走 pool.onTaskSettled()（释放槽 + 归还 tab + 继续调度）。
import { state, persist, broadcast, taskLabel } from './state.js';
import { log } from './log.js';
import { detectFormat } from './formats.js';
import { queueTask, queueTaskFront, unqueueTask, pump, onTaskSettled, slotsFree, releaseTab } from './pool.js';

/**
 * 弱指纹：origin + pathname + resolution（忽略 query —— 签名 URL 的时效参数每次不同）。
 * 共用同一实现：enqueue 去重（下方）＋ main.js retryExisting 的"是否允许用新 URL 刷新任务"。
 * - 纳入分辨率：同 pathname 靠 query 区分不同视频的站点（`/play?vid=A` ↔ `?vid=B`）不应被
 *   误判为同一视频——误报比漏报严重（"续传"会下错内容），分辨率能挡掉一部分。
 * - 同 pathname + 同分辨率的**不同视频**仍可能同指纹 → 续传入口必须展示原任务信息、
 *   且只对"有进度（done>0）"的失败任务提供（见 popup 侧）。
 */
export function urlKey(u, res) {
  try { const x = new URL(u); return x.origin + x.pathname + '|' + (res || ''); } catch { return u + '|' + (res || ''); }
}

// 入队（新建任务）。tabId 仅作为"首选的承载页"记在任务上，不再决定排队位置。
export function enqueue(tabId, url, referer, resolution, pageUrl, pageTitle, force = false) {
  const { downloads } = state;
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
  // 无 .mp4 后缀的签名 URL 也能正确标 mp4），兜底按 URL 后缀判断
  const sniffed = state.sniffStore[tabId]?.videos?.find(v => v.url === url);
  const taskFormat = sniffed?.format || detectFormat(url);
  downloads[id] = {
    id, url, referer, resolution,
    // pageUrl 兜底链：调用方传入 → 同 tab 嗅探记录（webRequest 记录/主动上报）→ referer。
    // v5：它就是"该任务的承载页"——pool.acquireTabFor 用它复用/新建 tab。
    pageUrl: pageUrl || (state.sniffStore[tabId] && state.sniffStore[tabId].pageUrl) || referer || '',
    pageTitle: pageTitle || '',
    status: 'queued', pct: 0, done: 0, total: 0,
    speed: '', error: null, createdAt: Date.now(), tabId,
    format: taskFormat, // 传给 content 分流下载
    fileName: '',
    dupIndex: dupIndex > 1 ? dupIndex : undefined,
    consecutiveFails: 0,
  };
  queueTask(id); // ★ v5：入全局就绪队列（顺序由 sortMode 决定，与 tab 无关）
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: downloads[id] });
  log('info', `[入队] ${taskLabel(id)} ${url.substring(0, 60)}`);
  maybeDispatch();
  return { ok: true, downloadId: id };
}

// 读取并发任务数（0=无上限）。注意：必须用 undefined 判断，不能用 ||（0 会被吞）
export async function getMaxConcurrent() {
  const s = await chrome.storage.local.get('vgp_settings');
  const v = s.vgp_settings && s.vgp_settings.maxConcurrent;
  return (v === undefined || v === null) ? 4 : v;
}

// 把设置里的并发数同步进调度槽位（pool 读 state.slotCount）
async function syncSlotCount() {
  state.slotCount = await getMaxConcurrent();
}

// 调度入口（保留旧名：47 处调用点无需改动）
export async function maybeDispatch() {
  await syncSlotCount();
  pump();
}

// ============ 优先下载 ============
// 用户拍板的策略：有空槽 → 直接提到队首立即跑；满槽 → 与"运行中已下载分片最少
// （沉没成本最低）"的任务替换。
// 被替换任务：发 CANCEL 让 content 退出旧循环 → 释放槽 → **8s 后再回队首**
// （必须留这个间隔：content 有 runningDownloads 防重入，旧循环没退干净时新 START 会被忽略，
//   任务会假活占槽 —— 旧版用 停止中态+stopPendingAt+replacedFlag 三件套解决，v5 用延迟替代）。
// ★ 顺序铁律：**先插队，再 pump()**。pump 是"防重入 + 取队首"的：一旦有 pump 在跑，
//   后面的 pump() 会被直接忽略。若先 pump 再插队，那次 pump 会立刻取走队列里原本的第一个
//   任务、占满刚让出的槽，用户在尾部的插队 + 第二次 pump() 双双失效 ——
//   真机现象就是「点了 ⚡ 优先，跑起来的却是别的任务，目标任务还在排队」。
export async function prioritizeDownload(downloadId) {
  const d = state.downloads[downloadId];
  if (!d) return { ok: false, error: '任务不存在' };
  if (d.status !== 'queued') return { ok: false, error: `该任务当前是「${d.status}」，只有排队中的任务才能优先` };
  log('info', `[优先] ${taskLabel(downloadId)} 收到优先下载请求`);

  await syncSlotCount();
  // ① 先把它插到队首：此后任何一次 pump() 取到的第一个任务都是它
  queueTaskFront(downloadId);

  // ② 有空槽 → 立即派发
  if (slotsFree() > 0) {
    pump();
    log('info', `[优先] ${taskLabel(downloadId)} 有空闲并发槽，立即派发`);
    return { ok: true };
  }

  // ③ 满槽：挑 done 最少（沉没成本最低）的运行中任务让位
  const runIds = Object.keys(state.running).map(Number).filter(id => id !== downloadId);
  const victim = runIds
    .map(id => state.downloads[id])
    .filter(Boolean)
    .sort((a, b) => (a.done || 0) - (b.done || 0))[0];
  if (!victim) {
    // 极端情况：槽满但拿不出可替换的任务 → 至少保住插队位置，等自然出槽
    pump();
    return { ok: false, error: '当前没有可让位的下载中任务，已把它排到队列最前' };
  }

  victim.status = 'queued';
  victim.error = `被优先下载替换（已下载 ${victim.done || 0} 片已保留，稍后自动续传）`;
  unqueueTask(victim.id);
  chrome.tabs.sendMessage(victim.tabId, { type: 'CANCEL_DOWNLOAD', downloadId: victim.id, reason: 'manual_pause' }).catch(() => {});
  // 只释放并发槽，**暂不归还承载页**（tabActive 也保持占位）：victim 的旧 content 循环还没退
  //（CANCEL 未确认），此刻放开这一页会被 acquireTabFor 的"扫已打开同源页"分支分给别的任务 →
  // 那一刻同页两个下载循环；victim 8s 后回来还会另建承载页（标签页堆叠）。
  // → 8s 后（与回队首同一时刻）再一起放开。
  delete state.running[victim.id];
  pump(); // 队首 = 用户点的任务 → 正好吃到刚让出的这个槽
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: victim });
  setTimeout(() => {
    const v = state.downloads[victim.id];
    if (!v) return;
    // 先归还承载页：不管 victim 之后是否继续跑，这一页都不该被它继续占着（否则页与槽双泄漏）
    if (state.tabActive[v.tabId] === v.id) state.tabActive[v.tabId] = null;
    releaseTab(v.tabId);
    if (v.status !== 'queued') return; // 期间被删除/取消/手动干预
    queueTaskFront(v.id);
    pump();
  }, 8000); // v5：旧 content 循环可能卡在不可 abort 的 await（如大 blob 落盘），3s 不够
  log('warn', `[优先] ${taskLabel(downloadId)} 顶替 ${taskLabel(victim.id)}（该任务进度 ${victim.done || 0} 片，8s 后回队首）`);
  return { ok: true };
}

// ============ 暂停 / 继续 / 取消 ============
// 全部暂停：所有活跃/排队任务 → paused（保留分片），供用户手动重新分配并发
export async function pauseAll() {
  const tasks = Object.values(state.downloads).filter(d =>
    d.status === 'downloading' || d.status === 'queued'
  );
  for (const d of tasks) pauseDownload(d.id);
  maybeDispatch();
}

// 全部继续：所有暂停任务重新入队；手动恢复 = 新的尝试周期（重置失败/刷新计数）
export async function resumeAll() {
  const tasks = Object.values(state.downloads).filter(d => d.status === 'paused');
  for (const d of tasks) {
    d.status = 'queued';
    d.error = null;
    d.consecutiveFails = 0;
    d.reloadCount = 0; // 手动恢复 = 新的尝试周期
    queueTask(d.id);
  }
  persist();
  tasks.forEach(d => broadcast({ type: 'DOWNLOAD_UPDATE', download: d }));
  maybeDispatch();
}

export function pauseDownload(downloadId) {
  const d = state.downloads[downloadId];
  if (!d) return;
  d.status = 'paused';
  d.error = '已暂停，点击继续恢复';
  unqueueTask(downloadId); // ★ v5：从全局队列摘掉
  onTaskSettled(d);        // 在跑则释放槽 + 归还 tab
  // 暂停：分片保留在 OPFS，可随时续传
  chrome.tabs.sendMessage(d.tabId, { type: 'CANCEL_DOWNLOAD', downloadId, reason: 'manual_pause' }).catch(() => {});
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
}

export function cancelDownload(downloadId) {
  const d = state.downloads[downloadId];
  if (!d) return;
  d.status = 'cancelled';
  unqueueTask(downloadId);
  onTaskSettled(d);
  // 取消：分片同样保留在 OPFS（浏览器退出时自动清理），可续传
  chrome.tabs.sendMessage(d.tabId, { type: 'CANCEL_DOWNLOAD', downloadId, reason: 'manual_cancel' }).catch(() => {});
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
}
