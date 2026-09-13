// signals.js — StreamCap Chrome 下载结果信号同步
// DOWNLOAD_BLOB 触发的下载任务，其结果决定扩展任务最终状态：
// complete → 真正完成（文件已存盘）→ 通知 content revoke blob + 清理分片
// interrupted → 失败（blob 保留，用户可在下载管理器重试，重试成功后 complete 分支转完成）
// 注意：SW 空闲重启后 downloads 对象是异步加载的，信号可能先于加载到达。
// 若加载未完成就处理 complete 会因 d 不存在而丢信号（任务永远卡 exporting → 重下）。
// 因此：未加载完成时先把信号缓存起来，加载完成后重放（见 main.js 恢复逻辑）。
import { state, persist, broadcast, taskLabel } from './state.js';
import { maybeDispatch } from './scheduler.js';
import { onTaskSettled, queueTask } from './pool.js';
import { log } from './log.js';

// 导出重做上限：blob 失效（NETWORK_FAILED）时用"重新合并导出"代替"重试同一个 blob"，
// 但页面被反复刷新时不能无限重做 —— 超过上限就按老规矩标 failed（分片保留，可手动重试）。
const EXPORT_REDO_MAX = 2;

export let loaded = false;
// ES module 的 import binding 是只读的，main.js 不能直接 `loaded = true`（会抛 TypeError），
// 必须通过 setter 修改。main.js 恢复逻辑加载完 downloads 后调用。
export function markLoaded() { loaded = true; }
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
      onTaskSettled(d); // v5：释放槽 + 归还承载页 + 继续调度（原先只清 tabActive → 槽位假满，后续任务派发不出去）
      persist();
      broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
      log('info', `[下载器] Chrome 下载项 #${delta.id} 完成 → ${taskLabel(rec.downloadId)} 标为已完成`);
      // 通知 content：revoke blob + 清理分片（标签页不自动关——删除已完成任务时才关，见 main.js DELETE_DOWNLOAD）
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

      // ★ NETWORK_FAILED 对 blob: URL 只意味着一件事：**blob 已失效**（创建它的文档被销毁，
      //   或已被 revoke）。真机日志：页面刷新打断导出 → #662 中断 → 旧逻辑用**同一个 blob**
      //   自动重试 → 立刻又中断（#664）→ 任务标 failed，而文件根本没落盘。
      //   所以这里不再重试同一个 blob，改为**放回队列重新注入**：分片还在（FINALIZE 只在真正
      //   complete 时才清理）→ content 会跳过已落盘分片，只需重新合并并再次导出。
      //   上限 EXPORT_REDO_MAX，避免页面被反复刷新时无限重做。
      if (errCode === 'NETWORK_FAILED' && (d.exportRedos || 0) < EXPORT_REDO_MAX) {
        d.exportRedos = (d.exportRedos || 0) + 1;
        d.exportedAt = null;   // 清掉导出占位，否则重做会被幂等窗口拦下
        d.status = 'queued';
        d.error = `导出中断(${errCode}，blob 已失效)，正在重新合并导出（${d.exportRedos}/${EXPORT_REDO_MAX}）`;
        delete m[delta.id];    // 这个下载项已经死了，先摘掉映射
        chrome.storage.session.set({ blob_map: m });
        onTaskSettled(d);      // 释放并发槽 + 归还承载页
        queueTask(d.id);       // 放回就绪队列：重派时会重建承载页并重新注入
        persist();
        broadcast({ type: 'DOWNLOAD_UPDATE', download: d });
        log('warn', `[下载器] ${taskLabel(rec.downloadId)} 导出中断(${errCode}) → 重新合并导出（${d.exportRedos}/${EXPORT_REDO_MAX}）`);
        maybeDispatch();
        return;
      }

      // 非 blob 失效类中断（FILE_FAILED / ABORTED 等）：blob 可能还有效 → 保留一次瞬时重试。
      // NETWORK_FAILED 一律不走这里（未超上限的在上面已重做，超上限的直接落到下面标 failed）
      if (retries < 1 && rec.blobUrl && errCode !== 'NETWORK_FAILED') {
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
            d.error = `Chrome 下载中断(${errCode})，重试失败: ${chrome.runtime.lastError?.message || '未知'}。大文件可直接用页面右下角「🗜️ 合并导出」流式保存（分片都在，不会丢）`;
            d.speed = '';
      onTaskSettled(d); // v5：释放槽 + 归还承载页 + 继续调度（原先只清 tabActive → 槽位假满，后续任务派发不出去）
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
      d.error = `Chrome 下载中断(${errCode})，可在下载管理器点「重试」重新合并导出；大文件（易 OOM）直接用页面右下角「🗜️ 合并导出」流式保存（分片都在，不会丢）`;
      d.speed = '';
      onTaskSettled(d); // v5：释放槽 + 归还承载页 + 继续调度（原先只清 tabActive → 槽位假满，后续任务派发不出去）
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
