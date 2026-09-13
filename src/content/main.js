// content main.js — 消息监听 + 初始化（content 入口，最后加载）
'use strict';
window.VGP = window.VGP || {};
(function (VGP) {
  // ★★ 重复注入守卫：与 downloader.js 同一原因（见那里的详细说明）。这里尤其关键 ——
  //    没有它，chrome.runtime.onMessage 会被注册**两次**，一条 START_DOWNLOAD 会被
  //    两个实例同时处理，直接导致同一任务两个下载循环、两次导出、磁盘重复文件。
  if (VGP.__mainLoaded) {
    try { console.warn('[VGP] content main 被重复注入，本次实例直接退出'); } catch { /* ignore */ }
    return;
  }
  VGP.__mainLoaded = true;
  const { log, startDownload, getAbortController, cancelReasons, cleanupOpfs, extractVideoSources, OPFS_PREFIX } = VGP;

  // 文件大小探测（popup 请求）：页面上下文发请求，浏览器自动带 Referer/Cookie，
  // 从 content-range 解析总大小（部分 CDN 防盗链校验 Referer，background 发会 403）
  async function probeSize(url) {
    try {
      const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
      if (r.status === 206) {
        const cr = r.headers.get('content-range');
        const m = cr && cr.match(/\/(\d+)$/);
        return { size: m ? parseInt(m[1]) : null };
      }
      if (r.status === 200) {
        const len = r.headers.get('content-length');
        return { size: len ? parseInt(len) : null };
      }
      return { size: null };
    } catch { return { size: null }; }
  }
  // 迁移前健康探测（background 重试接管用）：测本页面能否正常拉取该任务的媒体。
  // 走真实下载路径（同页面 context/cookie），Range 1KB 轻量请求，8s 超时——
  // 比 PING 可靠：页面活着但网络卡时 fetch 会挂/超时。
  async function probeUrl(url) {
    try {
      const t0 = performance.now();
      const r = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) return { ok: false, status: r.status };
      await r.arrayBuffer(); // Range 只回 1KB，读完即释放连接
      return { ok: true, ms: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, error: String((e && e.name) || e) };
    }
  }
  // 清理孤儿分片：删除不属于任何活跃任务的分片（扩展启动/定时清理时兜底）
  async function cleanupOrphans(activeDownloadIds) {
    const active = new Set(activeDownloadIds || []);
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
    return removed;
  }

  // ============ 消息处理 ============
  // ★ 监听器必须是【非 async】函数：async 返回值是 Promise，Chrome 只认严格 === true
  //   才保持消息通道；async + await 之后的 sendResponse 永远不会送达调用方
  //   （曾导致 FETCH_SIZE 大小探测与 PROBE_URL 健康探测全部失效）。
  //   异步分支改为调用 async helper + 同步 return true。
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'START_DOWNLOAD') {
      startDownload(msg.downloadId, msg.m3u8Url, msg.resumeFrom || 0, msg.concurrency || 4, msg.referer || '', msg.pageTitle || '', msg.format);
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
    // 文件大小探测（popup 请求）：页面上下文发请求，浏览器自动带 Referer/Cookie
    if (msg.type === 'FETCH_SIZE') {
      probeSize(msg.url).then(sendResponse);
      return true; // 异步响应（同步 return true 才保持通道）
    }
    // 清理孤儿分片：删除不属于任何活跃任务的分片（扩展启动/定时清理时兜底）
    if (msg.type === 'CLEANUP_OPFS') {
      cleanupOrphans(msg.activeDownloadIds).then(removed => sendResponse({ ok: true, removed }));
      return true; // 异步响应
    }
    // 迁移前健康探测（background 重试接管用）：测本页面能否正常拉取该任务的媒体
    if (msg.type === 'PROBE_URL') {
      probeUrl(msg.url).then(sendResponse);
      return true; // 异步响应
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
