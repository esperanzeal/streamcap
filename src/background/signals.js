// signals.js — StreamCap Chrome 下载结果信号同步
// DOWNLOAD_BLOB 触发的下载任务，其结果决定扩展任务最终状态：
// complete → 真正完成（文件已存盘）→ 通知 content revoke blob + 清理分片
// interrupted → 失败（blob 保留，用户可在下载管理器重试，重试成功后 complete 分支转完成）
// 注意：SW 空闲重启后 downloads 对象是异步加载的，信号可能先于加载到达。
// 若加载未完成就处理 complete 会因 d 不存在而丢信号（任务永远卡 exporting → 重下）。
// 因此：未加载完成时先把信号缓存起来，加载完成后重放（见 main.js 恢复逻辑）。
import { state, persist, broadcast, taskLabel } from './state.js';
import { maybeDispatch } from './scheduler.js';
import { log } from './log.js';

export let loaded = false;
export const pendingDownloadSignals = [];

export function handleDownloadSignal(delta) {
  chrome.storage.session.get('blob_map', s => {
    const m = s.blob_map || {};
    const rec = m[delta.id];
    if (!rec) return;
    const d = state.downloads[rec.downloadId];
    if (delta.state.current === 'complete') {
      if (!d) {
        // 加载完成后仍找不到任务 = 任务已被用户删除，丢弃映射
        delete m[delta.id];
        chrome.storage.session.set({ blob_map: m });
        return;
      }
      delete m[delta.id];
      chrome.storage.session.set({ blob_map: m });
      d.status = 'completed';
      d.pct = 100;
      d.fileName = rec.filename;
      d.speed = '';
      d.consecutiveFails = 0;
      d.retryCount = 0;
      state.tabActive[rec.tabId] = null;
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      log('info', `[下载器] Chrome 下载项 #${delta.id} 完成 → ${taskLabel(rec.downloadId)} 标为已完成`);
      // 通知 content：revoke blob + 清理分片
      chrome.tabs.sendMessage(rec.tabId, { type: 'FINALIZE_DOWNLOAD', downloadId: rec.downloadId, blobUrl: rec.blobUrl }).catch(() => {});
      maybeDispatch();
    } else if (delta.state.current === 'interrupted') {
      if (!d) {
        delete m[delta.id];
        chrome.storage.session.set({ blob_map: m });
        return;
      }
      // 记录 Chrome 的中断原因（FILE_FAILED=磁盘/路径，NETWORK_FAILED=blob 读取，ABORTED 等）
      const errCode = delta.error?.current || 'unknown';
      const retries = rec.retries || 0;
      if (retries < 1 && rec.blobUrl) {
        // blob 还在（页面未关闭、未 revoke）：自动重试一次，瞬时故障直接救回
        rec.retries = retries + 1;
        chrome.storage.session.set({ blob_map: m });
        log('warn', `[下载器] Chrome 下载项 #${delta.id} 中断(${errCode}) → ${taskLabel(rec.downloadId)} 自动重试导出`);
        chrome.downloads.download({
          url: rec.blobUrl,
          filename: rec.filename,
          saveAs: false,
          conflictAction: 'uniquify',
        }, (itemId2) => {
          if (chrome.runtime.lastError || itemId2 === undefined) {
            // 重试也失败：blob 可能已失效或页面已关
            d.status = 'failed';
            d.error = `Chrome 下载中断(${errCode})，重试失败: ${chrome.runtime.lastError?.message || '未知'}`;
            d.speed = '';
            state.tabActive[rec.tabId] = null;
            persist();
            broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
            log('error', `[下载器] ${taskLabel(rec.downloadId)} 导出重试失败: ${chrome.runtime.lastError?.message || '未知'}`);
            maybeDispatch();
          } else {
            m[itemId2] = rec;
            chrome.storage.session.set({ blob_map: m });
            log('info', `[下载器] ${taskLabel(rec.downloadId)} 导出重试 → Chrome 下载项 #${itemId2}`);
          }
        });
        return;
      }
      d.status = 'failed';
      d.error = `Chrome 下载中断(${errCode})，可在下载管理器点重试或点重试重新合并`;
      d.speed = '';
      state.tabActive[rec.tabId] = null;
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      log('warn', `[下载器] Chrome 下载项 #${delta.id} 中断(${errCode}) → ${taskLabel(rec.downloadId)} 标为失败（blob 保留可重试）`);
      maybeDispatch();
    } else {
      log('debug', `[下载器] Chrome 下载项 #${delta.id} 状态变化: ${delta.state.current}（未处理）`);
    }
  });
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  if (!loaded) {
    pendingDownloadSignals.push(delta);
    return;
  }
  handleDownloadSignal(delta);
});
