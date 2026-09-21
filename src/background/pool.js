// pool.js — v5 调度核心：全局就绪队列 + 并发槽位 + tab 池
//
// 为什么要重构（旧结构的病根）：
//   旧结构 state.tabQueues 是 **tabId → [任务id]**，"任务排在哪个 tab 上"决定它何时能跑。
//   一旦某 tab 被占用，挂在该 tab 下的所有任务全部冻结——即使全局并发槽空着也调度不到，
//   这就是"某任务长期占 tab，后续任务永远等不到"的根因；而"点重试失败把任务全堆到一个 tab"
//   也是它（findHostForTask 优先复用同一个同源页）。
//
// v5 结构：
//   ① 任务只排在一个**全局就绪队列** state.readyQueue 里，位置由排序策略决定，与 tab 无关；
//   ② 每个 tab 同一时刻只跑一个任务（沿用 state.tabActive 的语义 → 50 处引用无需改动）；
//   ③ 槽位 = 用户设置的并发数（state.slotCount，0 = 无限）；运行中任务数满槽就不再派发；
//      任务结束 → 释放槽 → 立刻取下一个（"出一个进一个"，运行中位置固定不重排）；
//   ④ **tab 池**：按需创建、同源复用、空闲超时回收。并发 8 就用 8 个 tab 并行，
//      而不是把几十个任务塞进同一个 tab 排队。
import { state, persist, broadcast, taskLabel } from './state.js';
import { log } from './log.js';

const TAB_IDLE_KEEP_MS = 5 * 60 * 1000; // 空闲 tab 保留 5 分钟，之后回收（防标签页堆积）
const CONTENT_FILES = [
  'src/content/log.js', 'src/content/opfs.js', 'src/content/formats.js',
  'src/content/hls.js', 'src/content/downloader.js', 'src/content/merge.js',
  'src/content/sniffer.js', 'src/content/main.js',
];

function originOf(u) { try { return new URL(u).origin; } catch { return ''; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tabExists(tabId) {
  try { await chrome.tabs.get(tabId); return true; } catch { return false; }
}
function pingTab(tabId) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, { type: 'PING' }, r => resolve(!chrome.runtime.lastError && r && r.ok === true));
    } catch { resolve(false); }
  });
}

// ============ 就绪队列 ============
// ★ 队列的**物理顺序就是派发顺序**：入队时按 sortMode 决定插入位置，取用时不再重排。
//   曾经的写法是"入队 push 到队尾 + 取用时按 sortMode 整体重排"，两者冲突：
//   重排会覆盖任何显式插队（unshift 到队首 / queueTaskFront），
//   真机现象就是「点了 ⚡ 优先，跑起来的却是队列里原本最早的那个任务」——
//   fifo 模式下插队 100% 失效（progress 模式也只是碰巧看着像有用）。
export function queueTask(id) {
  if (state.readyQueue.includes(id)) return;
  const d = state.downloads[id];
  const mode = state.sortMode || 'fifo';
  if (mode === 'progress' && d) {
    // progress：进度百分比高的排前面（先收尾，尽快减少任务总量）→ 新任务(0%)自然落在队尾
    const r = progressRatio(d);
    let i = 0;
    while (i < state.readyQueue.length) {
      const o = state.downloads[state.readyQueue[i]];
      if (!o || progressRatio(o) < r) break;
      i++;
    }
    state.readyQueue.splice(i, 0, id);
    return;
  }
  // fifo：按创建时间插入 —— 新任务自然落队尾；重试/让位/暂停恢复回来的**老**任务插回它原来的
  // 位置（否则每次重试都被新加的任务挤到队尾，"先来先跑"就失效了）。
  // 显式插队走 queueTaskFront，不受这里影响。
  const c = (d && d.createdAt) || Date.now();
  let i = 0;
  while (i < state.readyQueue.length) {
    const o = state.downloads[state.readyQueue[i]];
    if (!o || (o.createdAt || 0) > c) break;
    i++;
  }
  state.readyQueue.splice(i, 0, id);
}
// 插到队首（用户点「优先」/ 重新注入 / 让位后的任务优先跑）。
// 因为取用不再重排，这里的 unshift 是**真的**生效——语义必须保持。
export function queueTaskFront(id) {
  const i = state.readyQueue.indexOf(id);
  if (i >= 0) state.readyQueue.splice(i, 1);
  state.readyQueue.unshift(id);
}
// 切换排序策略时按新规则重建队列顺序（旧队列是按旧策略排的）
export function resortQueue() {
  const createdAt = id => (state.downloads[id] && state.downloads[id].createdAt) || 0;
  if ((state.sortMode || 'fifo') === 'progress') {
    state.readyQueue.sort((a, b) =>
      progressRatio(state.downloads[b] || {}) - progressRatio(state.downloads[a] || {}) ||
      createdAt(a) - createdAt(b));
  } else {
    state.readyQueue.sort((a, b) => createdAt(a) - createdAt(b));
  }
}
export function unqueueTask(id) {
  const i = state.readyQueue.indexOf(id);
  if (i >= 0) state.readyQueue.splice(i, 1);
}
export function isQueued(id) { return state.readyQueue.includes(id); }

// 取下一个要跑的任务：**严格按 readyQueue 的物理顺序**（队首优先），只取状态仍为 queued 的。
// ★ 顺序策略在入队时已由 queueTask 按 sortMode 落实，这里绝不能再排序：
//   一排序，任何插队（⚡ 优先下载 / 刷新后续传）都会被 createdAt 覆盖掉 —— 这正是
//   "点了优先却没反应，跑起来的是原来最早那个任务"的根因。
// 进度比率（0~1）：必须按**百分比**而不是分片数比较 —— 各任务总片数不同，
// 直接比 done 会让「1000 片下了 500 片(50%)」排在「100 片下了 90 片(90%)」前面。
// ★ 取 done/total 与 pct 两者中的**较大值**（进度 = 已达到的最高水位）：
//   - 正常情况两者一致（1755/2251 ↔ 78%）→ 无影响；
//   - pct 落后于分片（PROGRESS 被节流/单调保护拦下）→ 用分片值，更准；
//   - done=0 而 pct=78（老任务被 DOWNLOAD_ERROR 把 done 打成 0 的历史脏数据，
//     或 total 还没解析出来）→ 用 pct，不再被误当成 0% 排到队尾。
//   只信 done/total 会在第二种/第三种情况下把有进度的任务压到队尾。
export function progressRatio(d) {
  const bySeg = d.total > 0 ? (d.done || 0) / d.total : 0;
  const byPct = (d.pct || 0) / 100;
  return bySeg > byPct ? bySeg : byPct;
}
export function pickNext(exclude) {
  const skip = exclude || null; // 本轮已尝试但拿不到承载页的任务：跳过后面的任务才有机会跑
  for (const id of state.readyQueue) {
    const d = state.downloads[id];
    if (!d || d.status !== 'queued') continue;
    if (skip && skip.has(id)) continue;
    return id;
  }
  return null;
}

// ============ 槽位 ============
export function runningCount() { return Object.keys(state.running).length; }
export function slotMax() { return state.slotCount === 0 ? Infinity : (state.slotCount || 4); }
export function slotsFree() { return slotMax() - runningCount(); }

// ============ tab 池 ============
export function poolEntry(tabId) { return state.tabPool[tabId] || null; }

export function releaseTab(tabId) {
  const e = state.tabPool[tabId];
  if (e) { e.taskId = null; e.lastUsedAt = Date.now(); }
}

// 取一个可承载该任务的 tab：
//   ① 任务自己的来源页（用户当前这个页面 / 重试场景）——不能要求它已在池里
//   ② 其它已打开的同源空闲页（复用，省一次页面加载）
//   ③ 新建 tab（打开任务来源页）——"并发几个槽就开几个 tab"就靠这里
// 失败返回 null（调用方把任务放回队列，稍后再试）。
async function getTab(tabId) {
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}
// 把某个已打开的 tab 登记为承载页并绑定任务
function bindTab(tabId, task, origin) {
  state.tabPool[tabId] = { origin: (state.tabPool[tabId] && state.tabPool[tabId].origin) || origin, taskId: task.id, lastUsedAt: Date.now() };
  return tabId;
}

export async function acquireTabFor(task) {
  const origin = originOf(task.pageUrl || task.referer || '');
  const sameOrigin = u => !origin || originOf(u || "") === origin;

  // ① 任务自己的来源页还开着且空闲 → 直接用它。
  //    ★ 不能要求"它必须已在 tabPool 里"：用户在页面上点「加入下载」时，那个页面
  //      从来不是扩展打开的，池里自然没有它 —— v5 首版漏了这点，于是明明人就在该页面，
  //      却又在后台新建了一个一模一样的标签页。
  const orig = task.tabId;
  if (orig !== undefined && orig !== null && !state.tabActive[orig]) {
    const t = await getTab(orig);
    if (t && sameOrigin(t.url)) {
      log("info", `[池] 复用任务来源页 tab${orig}`);
      return bindTab(orig, task, origin);
    }
  }
  // ②a 池内登记过的同源空闲页（origin 记录最准，且不依赖 tabs.query）
  for (const [tid, e] of Object.entries(state.tabPool)) {
    const id = Number(tid);
    if (e.taskId !== null) continue;
    if (state.tabActive[id]) continue;
    if (e.origin && origin && e.origin !== origin) continue;
    if (!(await tabExists(id))) { delete state.tabPool[id]; continue; }
    log("info", `[池] 复用池内同源页 tab${id}`);
    return bindTab(id, task, origin);
  }
  // ②b 其它已打开的同源空闲页（用户自己开的同站页面）
  try {
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id === undefined || t.id === null) continue;
      if (t.id === orig) continue;
      if (state.tabActive[t.id]) continue;
      if (!sameOrigin(t.url)) continue;
      log("info", `[池] 复用已打开的同源页 tab${t.id}`);
      return bindTab(t.id, task, origin);
    }
  } catch { /* tabs.query 失败：退到新建 */ }

  // ③ 新建 tab 承载（后台打开：不抢焦点——8 个并发时有 7 个必然是后台，
  //    浏览器对后台标签的节流由 stalled.js 的"停摆→刷新页面"兜底）
  const pageUrl = task.pageUrl || task.referer;
  if (!pageUrl) return null;
  let opened = null;
  try {
    opened = await chrome.tabs.create({ url: pageUrl, active: false });
    let ready = false;
    for (let i = 0; i < 40; i++) { // ≤20s：等页面加载 + content script 注入
      await sleep(500);
      if (await pingTab(opened.id)) { ready = true; break; }
    }
    if (!ready) { await chrome.tabs.remove(opened.id); return null; }
  } catch {
    if (opened) { try { await chrome.tabs.remove(opened.id); } catch { /* ignore */ } }
    return null;
  }
  state.tabPool[opened.id] = { origin: originOf(pageUrl), taskId: task.id, lastUsedAt: Date.now() };
  log('info', `[池] 新建承载页 tab${opened.id}（${origin}）`);
  return opened.id;
}

// 空闲回收：关掉"超过保留时长且无任务"的 tab（由 alarm 定期调用）
export async function sweepIdleTabs() {
  const now = Date.now();
  for (const [tid, e] of Object.entries(state.tabPool)) {
    const id = Number(tid);
    if (e.taskId !== null) continue;
    if (state.tabActive[id]) continue;
    if (now - (e.lastUsedAt || 0) < TAB_IDLE_KEEP_MS) continue;
    try { await chrome.tabs.remove(id); } catch { /* 已关闭 */ }
    delete state.tabPool[id];
    log('info', `[池] 回收空闲承载页 tab${id}（空闲超过 ${TAB_IDLE_KEEP_MS / 60000} 分钟）`);
  }
}

// ============ 派发 ============
// 把任务注入到指定 tab：占槽 + 状态切换 + 注入（失败则标失败并释放）
// 从旧 scheduler.dispatchTab 移植：预检同步占位、content 未注入时 executeScript 兜底。
async function startTaskInTab(d, tabId) {
  // ★ 状态守卫：pump 在 await acquireTabFor 期间（建承载页最长等 20s），用户可能已经暂停/取消/删除
  //   了这个任务。不检查的话下面会把已暂停的任务强行改回 downloading 并启动下载 ——
  //   真机现象就是"全部暂停"后总有一个任务继续跑，必须手动再点一次。
  if (!state.downloads[d.id] || d.status !== "queued") {
    if (tabId !== null && tabId !== undefined) releaseSlot(d, tabId);
    return;
  }
  state.tabActive[tabId] = d.id;   // 同步占位（第一个 await 之前）
  d.tabId = tabId;                 // 任务记住自己的承载页（结束时才能释放/复用）
  state.running[d.id] = tabId;
  // ★ 状态必须在这里（第一个 await 之前）就切到 downloading：pump 下一轮开头的 reap()
  //   会把"状态不是下载中却占着槽"的任务当成泄漏清掉，若等到 load 完再切就会被误清。
  d.status = "downloading";
  if (!state.tabPool[tabId]) state.tabPool[tabId] = { origin: '', taskId: d.id, lastUsedAt: Date.now() };
  state.tabPool[tabId].taskId = d.id;
  state.tabPool[tabId].lastUsedAt = Date.now();

  try {
    await chrome.tabs.get(tabId);
  } catch {
    releaseSlot(d, tabId);
    d.status = 'failed';
    d.error = '页面已关闭，无法下载';
    persist();
    broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    log('warn', `[调度] ${taskLabel(d.id)} 所在页面已关闭，标为失败`);
    return;
  }

  d.acquireFails = 0; // 成功建立承载页 → 清零失败计数
  // ★ 新一轮下载开始 → 清除上一轮的导出占位。否则「重新下载」一个 10 分钟内完成过的任务时，
  //   新一轮的导出会被幂等窗口拒绝 → 文件永远存不下来（这是加幂等保护时引入的连带风险）。
  d.exportedAt = null;
  d.status = 'downloading';
  d.error = null;
  if (!d.done) d.pct = 0; // 续传保留已有进度
  d.lastProgressAt = Date.now();
  d.lastDoneAt = Date.now();
  d.lastActivityAt = Date.now(); // 活动基准（分片请求尝试会刷新）
  persist();
  broadcast({ type: 'DOWNLOAD_UPDATE', download: d });

  const settings = await chrome.storage.local.get('vgp_settings');
  const concurrency = (settings.vgp_settings && settings.vgp_settings.concurrency) || 4;
  const payload = {
    type: 'START_DOWNLOAD',
    downloadId: d.id,
    m3u8Url: d.url,
    resumeFrom: d.done || 0,
    concurrency,
    referer: d.referer || '',
    pageTitle: d.pageTitle || '',
    format: d.format,
  };
  try {
    await chrome.tabs.sendMessage(tabId, payload);
  } catch {
    // content script 未注入（如刚打开的页面）→ 手动注入后重发。
    // ★ 第一道防线：注入前先探测 window.VGP 是否已经就绪。sendMessage 抛错不一定是
    //   "content 不存在"，也可能只是时序/页面正在加载 —— 此时再注入一遍会得到**第二个
    //   downloader 实例**（各自独立的 runningDownloads）→ 同一任务两个下载循环 → 两次导出
    //   → 磁盘重复文件（真机日志：同一秒两个下载项 #653/#654）。
    //   content 侧也有单例守卫兜底（downloader.js / main.js），这里是第一道。
    let injected = false;
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!(window.VGP && window.VGP.__mainLoaded && window.VGP.__downloaderLoaded),
      });
      injected = !!(r && r[0] && r[0].result);
    } catch { /* 探测失败 → 按未注入处理 */ }
    try {
      if (!injected) {
        log('warn', `[调度] ${taskLabel(d.id)} content 未就绪，注入后重发 START_DOWNLOAD`);
        await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
      } else {
        log('warn', `[调度] ${taskLabel(d.id)} content 已在但首次 START 未被接受，直接重发（不重复注入）`);
      }
      await chrome.tabs.sendMessage(tabId, payload);
    } catch (err2) {
      releaseSlot(d, tabId);
      d.status = 'failed';
      d.error = '注入失败: ' + err2.message;
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
    }
  }
}

// 任务结束（完成/失败/取消/暂停）统一收尾：释放槽 + 归还 tab + 继续调度

// 释放并发槽 + 归还承载页（**不触发调度**）。
// ★ 所有"任务结束 / 让位"路径的统一底座：以前这三行样板散落在 7 个文件 20 多处，
//   漏掉任何一处，槽位就会假满 → 后续任务永远派发不出去（真机实测：8 个任务跑完整个队列卡死）。
//   reap()/pump() 内部也复用它 —— 它们不能调 onTaskSettled，那会触发 pump 重入。
export function releaseSlot(d, tabId = d.tabId) {
  if (!d) return;
  delete state.running[d.id];
  if (state.tabActive[tabId] === d.id) state.tabActive[tabId] = null;
  releaseTab(tabId);
}

export function onTaskSettled(d) {
  if (!d) return;
  releaseSlot(d);
  pump();
}

// ============ 调度主循环 ============
// 与旧的 maybeDispatch 等价（保留旧名做别名，47 处调用点零改动），但语义简化为：
// "有空槽 + 有就绪任务 → 依次派发"，不再依赖"某个 tab 是否空闲"。
// 自愈：清理"已经不在运行、但槽位表里还占着"的任务（完成/失败/取消/暂停/回队列）。
// 必须有它兜底：任何一条结束路径漏调 onTaskSettled，槽位就会假满 → 后续任务永远派发不出去
//（真机实测过：8 个任务全部跑完后整个队列卡死，就是这个原因）。
// 注意 exporting 仍算"活着"：导出期间必须继续占着承载页，否则新任务会被派到正在导出的页面上。
function reap() {
  for (const [idStr, tabId] of Object.entries(state.running)) {
    const id = Number(idStr);
    const d = state.downloads[id];
    const alive = d && (d.status === "downloading" || d.status === "retrying" || d.status === "exporting");
    if (alive) continue;
    releaseSlot(d, Number(tabId));
  }
}

let pumping = false;
export function pump() {
  if (pumping) return; // 防重入（替代旧的 promise 链串行化）
  reap(); // 先自愈：清掉"已结束却还占着槽"的任务，否则槽位假满
  pumping = true;
  (async () => {
      const skipped = new Set(); // 本轮拿不到承载页的任务（防死循环 / 不阻塞队列）
    try {
      while (slotsFree() > 0) {
        const id = pickNext(skipped);
        if (id === null) break;
        const d = state.downloads[id];
        if (!d || d.status !== 'queued') { unqueueTask(id); continue; }
        unqueueTask(id); // 先出队，避免同一任务被重复派发
        const tabId = await acquireTabFor(d);
        if (tabId === null) {
          // 拿不到承载页（来源页打不开 / 加载超时）→ 放回队列。**不能 break**：
          // pickNext 每次都会先选中队首，队首一直失败就会把后面所有任务饿死。
          // 记失败次数，超限标失败（有界），否则本轮先跳过它。
          d.acquireFails = (d.acquireFails || 0) + 1;
          if (d.acquireFails >= 3) {
            d.status = "failed";
            d.error = "来源页无法打开（连续 3 次无法建立承载页），请确认该视频站可访问后重试";
            persist();
            broadcast({ type: "DOWNLOAD_UPDATE", download: d });
            log("warn", `[调度] ${taskLabel(id)} 连续 ${d.acquireFails} 次无法建立承载页，标为失败`);
            continue;
          }
          skipped.add(id);
          queueTask(id);
          log("warn", `[调度] ${taskLabel(id)} 暂无可用承载页（第 ${d.acquireFails} 次），本轮先跳过`);
          continue;
        }
        // ★ await 期间任务可能已被暂停/取消（"全部暂停"就是这种情况）→ 归还承载页，不派发
        if (d.status !== "queued") {
          releaseSlot(d, tabId);
          continue;
        }
        startTaskInTab(d, tabId);
      }
    } finally {
      pumping = false;
    }
  })();
}
