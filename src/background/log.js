// log.js — StreamCap 日志（按日期存 storage.local，原子写入防竞态丢写）
// v4：原 get→push→set 非原子，高并发下丢关键日志（如"发送中止信号"）。
// 改为串行队列：每次写入等上一次完成，保证同一天内日志不丢、不覆盖。

let logQueue = Promise.resolve(); // 串行化队列，杜绝并发 get→push→set 竞态

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
    // 串行追加：前一条写入完成后才读-改-写，同一 key 不会并发覆盖
    logQueue = logQueue.then(() => new Promise(resolve => {
      chrome.storage.local.get(key, data => {
        const arr = data[key] || [];
        arr.push(line);
        if (arr.length > 5000) arr.splice(0, arr.length - 5000);
        chrome.storage.local.set({ [key]: arr }, () => resolve());
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
