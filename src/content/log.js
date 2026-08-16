// content log.js — 页面侧日志（串行队列防竞态丢写）
// 注：与 background 的 log.js 同样用串行队列；content 与 background 是不同进程，
// 跨进程同时写同一 storage key 仍存在理论竞态（概率低，后续可统一走消息通道）。
'use strict';
window.VGP = window.VGP || {};
(function (VGP) {
  let logQueue = Promise.resolve();
  function log(level, msg) {
    try {
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log']('[VGP]', msg);
    } catch {}
    try {
      const now = new Date();
      // 用本地时区日期做 key：toISOString() 是 UTC 时间，东八区凌晨 0-8 点会落到前一天
      const key = 'vgp_logs_' +
        now.getFullYear() + '-' +
        String(now.getMonth() + 1).padStart(2, '0') + '-' +
        String(now.getDate()).padStart(2, '0'); // vgp_logs_YYYY-MM-DD（本地日期）
      const line = `[${now.toLocaleTimeString()}] [${level.toUpperCase()}] [页面] ${msg}`;
      logQueue = logQueue.then(() => new Promise(resolve => {
        chrome.storage.local.get(key, data => {
          const arr = data[key] || [];
          arr.push(line);
          if (arr.length > 5000) arr.splice(0, arr.length - 5000);
          chrome.storage.local.set({ [key]: arr }, () => resolve());
        });
      })).catch(() => {});
    } catch { /* 日志失败不影响主流程 */ }
  }
  VGP.log = log;
})(window.VGP);
