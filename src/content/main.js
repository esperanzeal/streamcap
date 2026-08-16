// content main.js — 消息监听 + 初始化（content 入口，最后加载）
'use strict';
window.VGP = window.VGP || {};
(function (VGP) {
  const { log, startDownload, getAbortController, cancelReasons, cleanupOpfs, extractVideoSources, OPFS_PREFIX } = VGP;

  // ============ 消息处理 ============
  chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    if (msg.type === 'START_DOWNLOAD') {
      startDownload(msg.downloadId, msg.m3u8Url, msg.resumeFrom || 0, msg.concurrency || 4, msg.referer || '', msg.pageTitle || '');
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'CANCEL_DOWNLOAD') {
      const ac = getAbortController(msg.downloadId);
      if (ac) {
        // 记录取消来源：调度器（停滞/心跳/导航）与用户手动操作区分开，日志不再一律写"下载被用户取消"
        const reason = msg.reason || 'manual_cancel';
        cancelReasons.set(msg.downloadId, reason);
        ac.abort();
        log('info', `[${msg.downloadId}] 发送中止信号（来源: ${reason}）`);
      }
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'SCAN_VIDEOS') {
      sendResponse({ urls: extractVideoSources(), pageUrl: location.href, pageTitle: document.title });
      return;
    }
    // 心跳探测：background 恢复时确认 content script 是否存活
    if (msg.type === 'PING') {
      sendResponse({ ok: true });
      return;
    }
    // Chrome 下载完成信号：revoke blob + 清理本任务分片（background 在下载 complete 后发送）
    if (msg.type === 'FINALIZE_DOWNLOAD') {
      if (msg.blobUrl) {
        try { URL.revokeObjectURL(msg.blobUrl); } catch {}
      }
      cleanupOpfs(msg.downloadId);
      log('success', `[${msg.downloadId}] Chrome 下载已确认完成，blob 已释放、分片已清理`);
      sendResponse({ ok: true });
      return;
    }
    // 文件大小探测（popup 请求）：页面上下文发 Range 请求，浏览器自动带 Referer/Cookie，
    // 从 content-range 解析总大小（部分站点等 CDN 防盗链校验 Referer，background 发会 403）
    if (msg.type === 'FETCH_SIZE') {
      try {
        const r = await fetch(msg.url, { headers: { Range: 'bytes=0-0' } });
        if (r.status === 206) {
          const cr = r.headers.get('content-range');
          const m = cr && cr.match(/\/(\d+)$/);
          sendResponse({ size: m ? parseInt(m[1]) : null });
        } else if (r.status === 200) {
          const len = r.headers.get('content-length');
          sendResponse({ size: len ? parseInt(len) : null });
        } else {
          sendResponse({ size: null });
        }
      } catch {
        sendResponse({ size: null });
      }
      return true; // 异步响应
    }
    // 清理孤儿分片：删除不属于任何活跃任务的分片（扩展启动/定时清理时兜底）
    if (msg.type === 'CLEANUP_OPFS') {
      const active = new Set(msg.activeDownloadIds || []);
      const root = await navigator.storage.getDirectory();
      let removed = 0;
      for await (const [name] of root) {
        if (!name.startsWith(OPFS_PREFIX)) continue;
        if (name.startsWith(OPFS_PREFIX + 'dl_')) {
          const m = name.match(/^vgp_dl_(\d+)_/);
          if (!m || !active.has(Number(m[1]))) {
            try { await root.removeEntry(name); removed++; } catch {}
          }
        } else if (name.startsWith(OPFS_PREFIX + 'meta_')) {
          const m = name.match(/^vgp_meta_(\d+)\.json$/);
          if (!m || !active.has(Number(m[1]))) {
            try { await root.removeEntry(name); removed++; } catch {}
          }
        }
      }
      // 只在实际删了东西时打日志，避免 SW 重启刷屏（每次都广播一次清理）
      if (removed > 0) log('info', `[清理] 删除孤儿分片 ${removed} 个`);
      sendResponse({ ok: true, removed });
      return;
    }
  });

  // ============ 初次扫描（500ms debounce） ============
  const scan = () => {
    const urls = extractVideoSources();
    if (urls.length > 0) {
      chrome.runtime.sendMessage({ type: 'REPORT_VIDEO', urls, pageTitle: document.title }).catch(() => {});
    }
  };
  let scanTimer = null;
  const debouncedScan = () => {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 500);
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(scan, 2000));
  } else {
    setTimeout(scan, 2000);
  }
  new MutationObserver(debouncedScan).observe(document.body || document.documentElement, {
    childList: true, subtree: true,
  });
})(window.VGP);
