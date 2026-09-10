// log.js — StreamCap 日志（按日期存 storage.local，原子写入防竞态丢写）
// v4：原 get→push→set 非原子，高并发下丢关键日志（如"发送中止信号"）。
// 改为串行队列：每次写入等上一次完成，保证同一天内日志不丢、不覆盖。

let logQueue = Promise.resolve(); // 串行化队列，杜绝并发 get→push→set 竞态

// 日志留存策略：与任务持久化（vgp_downloads）共用 storage.local（MV3 默认 10MB），
// 日志按天累积无上限会挤占配额 → 任务写入失败 → 重启丢任务。
// 只保留最近 LOG_RETAIN_DAYS 天，每小时最多清理一次。
// 节流时间存 storage.session：MV3 SW 空闲约 30s 就被回收，若只放内存变量，
// 每次重启后的首条日志都会触发一次全量 storage.local 扫描。
const LOG_RETAIN_DAYS = 7;
const PRUNE_INTERVAL_MS = 3600 * 1000;
let lastPruneAt = 0;     // 内存缓存（避免每条日志都读 session）
let pruneLoaded = false; // 是否已从 storage.session 载入过节流时间
function pruneOldLogs() {
  if (!pruneLoaded) {
    pruneLoaded = true;
    chrome.storage.session.get('vgp_log_prune_at', s => {
      lastPruneAt = (s && s.vgp_log_prune_at) || 0;
      doPrune();
    });
    return;
  }
  doPrune();
}
function doPrune() {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  chrome.storage.session.set({ vgp_log_prune_at: now });
  const d = new Date();
  d.setDate(d.getDate() - (LOG_RETAIN_DAYS - 1));
  const cutoff = 'vgp_logs_' +
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
  chrome.storage.local.get(null, data => {
    // key 形如 vgp_logs_YYYY-MM-DD，字典序即时间序，直接字符串比较
    const stale = Object.keys(data).filter(k => k.startsWith('vgp_logs_') && k < cutoff);
    if (stale.length) chrome.storage.local.remove(stale);
  });
}

function todayKey() {
  const d = new Date();
  return 'vgp_logs_' +
    d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0'); // 本地日期；toISOString() 是 UTC，东八区凌晨会落前一天
}

export function log(level, msg) {
  try {
    const now = new Date();
    const key = todayKey();
    const line = `[${now.toLocaleTimeString()}] [${level.toUpperCase()}] ${msg}`;
    pruneOldLogs(); // 机会性清理过期日志（内部有 1 小时节流）
    // 串行追加：前一条写入完成后才读-改-写，同一 key 不会并发覆盖
    logQueue = logQueue.then(() => new Promise(resolve => {
      chrome.storage.local.get(key, data => {
        const arr = data[key] || [];
        arr.push(line);
        if (arr.length > 5000) arr.splice(0, arr.length - 5000);
        chrome.storage.local.set({ [key]: arr }, () => {
          // 配额写满时不再静默：降级到 console（devtools 可查），并把本次日志丢弃
          if (chrome.runtime.lastError) {
            try { console.warn('[VGP] 日志写入失败（存储配额？）:', chrome.runtime.lastError.message); } catch { /* ignore */ }
          }
          resolve();
        });
      });
    })).catch(() => {}); // 单条失败不影响队列
  } catch { /* 日志失败不影响主流程 */ }
}

// 读取某天的日志（manager/logger 页用）
export function getLogs(dateStr, callback) {
  const key = 'vgp_logs_' + dateStr;
  chrome.storage.local.get(key, data => callback(data[key] || []));
}

// 清空某天的日志
export function clearLogs(dateStr, callback) {
  chrome.storage.local.remove('vgp_logs_' + dateStr, () => callback && callback());
}

// 清空所有日志（枚举 storage.local 中全部 vgp_logs_* key）
export function clearAllLogs(callback) {
  chrome.storage.local.get(null, data => {
    const keys = Object.keys(data).filter(k => k.startsWith('vgp_logs_'));
    if (keys.length === 0) { callback && callback(); return; }
    chrome.storage.local.remove(keys, () => callback && callback());
  });
}
