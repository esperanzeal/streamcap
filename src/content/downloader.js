// content downloader.js — 核心下载循环（并行分片 + OPFS 断点续传 + 分批合并）
'use strict';
window.VGP = window.VGP || {};
(function (VGP) {
  const { log, fetchWithRetry, parseM3u8, selectBestVariant, resolveUrl,
    parseKeySegments, findKeyForSegment, fetchDecryptKey, decryptSegment, makeIV,
    opfsWrite, opfsRead, saveMeta, loadMeta } = VGP;

  // ============ AbortController 管理 ============
  const abortControllers = new Map(); // downloadId → AbortController
  // 取消来源（手动暂停/手动取消/停滞判定/心跳兜底/页面导航）→ 主循环 catch AbortError 时用不同文案
  const cancelReasons = new Map(); // downloadId → reason 字符串

  function getAbortController(downloadId) {
    let ac = abortControllers.get(downloadId);
    if (!ac) { ac = new AbortController(); abortControllers.set(downloadId, ac); }
    return ac;
  }

  function removeAbortController(downloadId) {
    abortControllers.delete(downloadId);
    cancelReasons.delete(downloadId);
  }

  // ============ 进度回报 ============
  function reportProgress(downloadId, pct, done, total, speed) {
    chrome.runtime.sendMessage({ type: 'PROGRESS', downloadId, pct, done, total, speed }).catch(() => {});
  }

  // ============ SW 保活心跳 ============
  // MV3：SW 空闲约 30s 被 Chrome 回收。下载跑在 content，回收不影响下载，
  // 但 SW 内存态（tabActive/tabQueues）会丢、队列没人调度。下载期间每 10s 发
  // 一次 HEARTBEAT，让 SW 持续有事件 → 不空闲 → 不被回收。
  const heartbeatTimers = new Map(); // downloadId → interval id
  function startHeartbeat(downloadId) {
    if (heartbeatTimers.has(downloadId)) return;
    const t = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'HEARTBEAT', downloadId }).catch(() => {});
    }, 10000);
    heartbeatTimers.set(downloadId, t);
  }
  function stopHeartbeat(downloadId) {
    const t = heartbeatTimers.get(downloadId);
    if (t) { clearInterval(t); heartbeatTimers.delete(downloadId); }
  }

  // ============ 后台标签页检测（防被 Chrome 节流拖慢） ============
  // 页面切到后台时，Chrome 会节流定时器/降低网络优先级 → 分片 20s 超时被拉长、
  // 下载龟速。检测到切后台时给用户提示（不打扰：一次性横幅）。
  let hiddenBanner = null;
  function showHiddenBanner() {
    if (hiddenBanner || !document.body) return;
    const div = document.createElement('div');
    div.id = 'vgp-hidden-banner';
    div.textContent = '⚠️ StreamCap：页面已切到后台，下载会被 Chrome 限速变慢。请保持此标签页在前台直到下载完成。';
    div.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#f59e0b;color:#111;font:12px system-ui,sans-serif;padding:6px 12px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.35)';
    document.body.appendChild(div);
    hiddenBanner = div;
  }
  function hideHiddenBanner() {
    if (hiddenBanner) { hiddenBanner.remove(); hiddenBanner = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // 只在有下载进行时提示，避免打扰无下载场景
      if (heartbeatTimers.size > 0) {
        showHiddenBanner();
        log('warn', '页面切到后台，Chrome 会节流下载（定时器/网络降级），请保持标签页在前台');
      }
    } else {
      hideHiddenBanner();
    }
  });

  // ============ 核心：并行下载 + OPFS 持久化 ============
  const runningDownloads = new Set(); // downloadId → 防重入（retry 双派发时只跑一个循环）
  async function startDownload(downloadId, m3u8Url, resumeFrom, concurrency, referer, pageTitle) {
    if (runningDownloads.has(downloadId)) {
      // 同一任务已有下载循环在跑（可能是 retry 双派发/重复 START），忽略本次
      log('warn', `[#${downloadId}] 收到重复 START，忽略（已有下载循环在跑）`);
      return;
    }
    runningDownloads.add(downloadId);
    const ac = getAbortController(downloadId);
    const signal = ac.signal;
    // 日志任务标识：优先用任务名（如 video.mp4），没有时才回退到 id
    const taskLabel = pageTitle ? `${pageTitle}.mp4` : `#${downloadId}`;

    log('info', `[${taskLabel}] 开始下载: ${m3u8Url.substring(0, 60)}...`);
    if (resumeFrom > 0) log('info', `[${taskLabel}] 断点续传，跳过前 ${resumeFrom} 段`);
    startHeartbeat(downloadId); // 下载期间保活 SW，防止空闲被回收
    if (document.hidden) showHiddenBanner();

    let total;
    let totalDone = 0; // 函数级真实进度（下载分片数）：先初始化为 0，批次元数据读取后按实际落盘批次修正

    try {
      // 0. OPFS 配额预检
      const estimate = await navigator.storage.estimate();
      const freeMB = (estimate.quota - estimate.usage) / 1024 / 1024;
      const needEstimate = resumeFrom > 0 ? 500 : 2048; // 续传用保守估计
      if (freeMB < needEstimate) {
        log('warn', `[${taskLabel}] 磁盘剩余 ${freeMB.toFixed(0)}MB，可能不足`);
        // 不发 PROGRESS：此时 total 尚未解析无法算真实 pct，且传 0 会把进度条打回 0（鬼打墙）。
        // 磁盘不足会在后续 OPFS 写入时体现为失败，走失败路径即可。
      }

      const refHeaders = {};

      // 1. 获取 m3u8 文本
      let resp = await fetchWithRetry(m3u8Url, 3, signal, refHeaders);
      let text = await resp.text();
      log('info', `[${taskLabel}] m3u8 获取成功 (${text.length}B)`);

      // 2. 解析 — textBaseUrl 始终跟踪 text 的来源 URL
      let textBaseUrl = m3u8Url;
      let parsed = parseM3u8(text, textBaseUrl);
      if (parsed.isMaster && parsed.variantUrls.length > 0) {
        const best = selectBestVariant(text);
        textBaseUrl = best ? resolveUrl(best, m3u8Url) : parsed.variantUrls[parsed.variantUrls.length - 1];
        log('info', `[${taskLabel}] 选择子清单: ${textBaseUrl.substring(0, 60)}...`);
        resp = await fetchWithRetry(textBaseUrl, 3, signal, refHeaders);
        text = await resp.text();
        parsed = parseM3u8(text, textBaseUrl);
      }

      if (parsed.segments.length === 0) throw new Error('无分片');

      const { keySegments, mediaSeq } = parseKeySegments(text, textBaseUrl);
      const keyCache = new Map(); // keyUrl → cryptoKey（懒加载，支持 key rotation）
      if (keySegments.length > 0) {
        log('info', `[${taskLabel}] AES-128 加密（${keySegments.length} 个 key 段），预取首个密钥...`);
        const firstKey = keySegments[0];
        const keyBytes = await fetchDecryptKey(firstKey.keyUrl, signal);
        keyCache.set(firstKey.keyUrl, await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']));
        if (keySegments.length > 1) log('info', `[${taskLabel}] 检测到 key rotation，其余密钥按需加载`);
        log('success', `[${taskLabel}] 密钥就绪`);
      }

      total = parsed.segments.length;
      log('info', `[${taskLabel}] 共 ${total} 个分片`);

      // 3. 读取/创建断点元数据
      let meta = await loadMeta(downloadId);
      if (!meta || meta.totalSegments !== total) {
        // 新建元数据（或分片结构变了，重建）
        meta = { downloadId, totalSegments: total, completedBatches: [], batchSize: 40 };
        await saveMeta(downloadId, meta);
      } else if (resumeFrom > 0) {
        // 确保 meta 反映了之前的进度。
        // ⚠️ 注意：resumeFrom 是 background 最后收到的 done（可能是批次下载中途的 mini 值），
        // 不能按分片数直接推算出已完成批次——批次是原子落盘的（40 片全部写完才 push
        // completedBatches），只有真正写过 OPFS 的批次才算完成。这里用 OPFS 实际校验：
        // 逐批读 dl_{id}_batch_{b}.blob，存在才标记。杜绝"假标记未落盘批次 → 合并缓存丢失"。
        const completedBatches = [];
        const root = await navigator.storage.getDirectory();
        const prefix = VGP.OPFS_PREFIX + `dl_${downloadId}_batch_`;
        for await (const [name] of root) {
          if (!name.startsWith(prefix)) continue;
          const b = parseInt(name.slice(prefix.length));
          if (!isNaN(b)) completedBatches.push(b);
        }
        completedBatches.sort((a, b) => a - b);
        meta.completedBatches = completedBatches;
        await saveMeta(downloadId, meta);
      }

      const BATCH_SIZE = meta.batchSize;
      const completed = new Set(meta.completedBatches);
      const totalBatches = Math.ceil(total / BATCH_SIZE);
      const CONCURRENCY = concurrency || 4;
      let totalBytes = 0;
      // totalDone 保持函数级初始值 0，由批次循环顺序推进（跳过落盘批次累加、下载批次 segStart+batchDone），
      // 天然单调。不要在这里用 (max(completed)+1)*40 预推——completed 可能不连续（中间批次缓存丢失），
      // 预推会虚高后再被循环覆盖 → 进度条先涨后掉（鬼打墙）。
      let networkBytes = 0;
      const downloadStartTime = performance.now();

      // 4. 分批下载
      // 批次进度节流上报：慢网/大文件时单批次可能耗时 >90s，background 的停滞判定
      // 依赖"done 增长"来刷新 lastDoneAt。这里每 15s 强制报一次当前已下载分片数，
      // 让 background 能区分"下载在推进只是慢"与"真卡死"（done 增长仍由批次循环上报）。
      let lastThrottleReport = 0;
      const throttleReport = () => {
        const now = Date.now();
        if (now - lastThrottleReport < 15000) return;
        lastThrottleReport = now;
        const elapsed = (performance.now() - downloadStartTime) / 1000;
        const speed = elapsed > 1 ? formatSpeed(networkBytes / elapsed) : '';
        const pct = Math.round((totalDone / total) * 100);
        reportProgress(downloadId, pct, totalDone, total, speed);
      };
      const throttleTimer = setInterval(throttleReport, 5000); // 每 5s 检查一次是否满 15s
      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        if (completed.has(batchIdx)) {
          // 已完成的 batch，只统计字节数（用文件大小，不读整个 blob——千批次下避免巨量 IO）
          let batchSize = 0;
          try {
            const root2 = await navigator.storage.getDirectory();
            const fh = await root2.getFileHandle(`${VGP.OPFS_PREFIX}dl_${downloadId}_batch_${batchIdx}.blob`);
            batchSize = (await fh.getFile()).size;
          } catch { batchSize = 0; }
          if (batchSize > 0) {
            totalBytes += batchSize;
            // 同步 totalDone：跳过已落盘批次 → 推进到该批结束位置（顺序处理，单调不减）
            totalDone = Math.min(batchIdx * BATCH_SIZE + BATCH_SIZE, total);
            // 事件驱动上报（非定时器）：后台标签节流下 setInterval 被降频，
            // 但这里在每次跳过批次后立即上报，保证 background 持续收到进度
            reportProgress(downloadId, Math.round(totalDone / total * 100), totalDone, total, '');
            log('info', `[${taskLabel}] 批次 ${batchIdx + 1}/${totalBatches} 已缓存，跳过`);
          } else {
            // 缓存丢失，重新下载
            completed.delete(batchIdx);
            log('warn', `[${taskLabel}] 批次 ${batchIdx + 1} 缓存丢失，重新下载`);
          }
        }

        if (completed.has(batchIdx)) continue;

        const segStart = batchIdx * BATCH_SIZE;
        const segEnd = Math.min(segStart + BATCH_SIZE, total);
        const batchUrls = parsed.segments.slice(segStart, segEnd);
        const batchCount = batchUrls.length;
        const batchChunks = new Array(batchCount);

        // 并行下载这一批
        let batchDone = 0;
        for (let i = 0; i < batchCount; i += CONCURRENCY) {
          const mini = batchUrls.slice(i, i + CONCURRENCY);
          const results = await Promise.allSettled(mini.map(async (url, bi) => {
            const idx = i + bi;
            try {
              const r = await fetchWithRetry(url, 3, signal, refHeaders);
              const rawBuf = await r.arrayBuffer();
              networkBytes += rawBuf.byteLength;
              let segData = new Uint8Array(rawBuf);
              if (keySegments.length > 0) {
                const ks = findKeyForSegment(keySegments, segStart + idx);
                if (ks) {
                  let ck = keyCache.get(ks.keyUrl);
                  if (!ck) {
                    const kb = await fetchDecryptKey(ks.keyUrl, signal);
                    ck = await crypto.subtle.importKey('raw', kb, { name: 'AES-CBC' }, false, ['decrypt']);
                    keyCache.set(ks.keyUrl, ck);
                  }
                  const iv = makeIV(ks.ivHex, segStart + idx, mediaSeq);
                  segData = await decryptSegment(segData, ck, iv);
                }
              }
              batchChunks[idx] = segData;
              batchDone++; // 只有成功下载的分片才计入进度——失败分片不虚涨（否则拔网线时进度照涨、停滞判定被虚涨的 done 刷新永不触发）
            } catch (err) {
              if (err.name === 'AbortError') {
                // 任务被暂停/取消中止，不是失败：降级为 info，避免误读为任务失败
                log('info', `[${taskLabel}] 分片 ${segStart + idx + 1} 已中止（暂停/取消）`);
              } else {
                log('error', `[${taskLabel}] 分片 ${segStart + idx + 1} 失败: ${err.message}`);
              }
              batchChunks[idx] = null;
            }
          }));
          totalDone = segStart + batchDone;
          const elapsed = (performance.now() - downloadStartTime) / 1000;
          const speed = elapsed > 1 ? formatSpeed(networkBytes / elapsed) : '';
          const pct = Math.round((totalDone / total) * 100);
          reportProgress(downloadId, pct, totalDone, total, speed);
        }

        // 重试失败分片：fetchWithRetry(5) 即"同一分片连续尝试 5 次"，5 次全失败 → 上报任务失败
        // 注意：重试阶段可能耗时很长（单片 20s×5+退避≈115s），期间 done 不变。
        // 必须每片尝试后发一次 PROGRESS 让 background 知道"还在干活"（done 不变也发），
        // 否则停滞判定（done 未增长 90s）会把坏分片重试误判为卡死 → 取消重派 → 鬼打墙。
        for (let i = 0; i < batchCount; i++) {
          if (batchChunks[i] !== null) continue;
          const segNum = segStart + i + 1;
          try {
            log('info', `[${taskLabel}] 重试分片 ${segNum}`);
            const r = await fetchWithRetry(batchUrls[i], 5, signal, refHeaders);
            const rawBuf = await r.arrayBuffer();
            networkBytes += rawBuf.byteLength;
            // 重试成功后：该分片计入成功进度（并行阶段失败时没计，这里补上）
            totalDone++;
            reportProgress(downloadId, Math.round(totalDone / total * 100), totalDone, total, '');
            let segData = new Uint8Array(rawBuf);
            if (keySegments.length > 0) {
              const ks = findKeyForSegment(keySegments, segStart + i);
              if (ks) {
                let ck = keyCache.get(ks.keyUrl);
                if (!ck) {
                  const kb = await fetchDecryptKey(ks.keyUrl, signal);
                  ck = await crypto.subtle.importKey('raw', kb, { name: 'AES-CBC' }, false, ['decrypt']);
                  keyCache.set(ks.keyUrl, ck);
                }
                const iv = makeIV(ks.ivHex, segStart + i, mediaSeq);
                segData = await decryptSegment(segData, ck, iv);
              }
            }
            batchChunks[i] = segData;
          } catch (err) {
            // 取消信号（AbortError）直接上抛，不能被包成普通错误 → 否则 background 无法识别"已取消"，会误触发自动重试
            if (err.name === 'AbortError') throw err;
            // 永久错误（404/源站删除）：重试无意义，直接上报任务失败（不重派）
            if (/HTTP 404|404/.test(err.message || '')) {
              throw new Error(`分片 ${segNum}/${total} 返回 404，源站分片不存在（永久错误）`);
            }
            // 网络类错误：分片 5 次尝试全失败 → 任务失败，由 background 决定重派
            throw new Error(`分片 ${segNum}/${total} 连续失败 5 次: ${err.message}`);
          }
        }

        // 写 OPFS（批次 Blob）
        const batchBlob = new Blob(batchChunks);
        await opfsWrite(`dl_${downloadId}_batch_${batchIdx}.blob`, batchBlob);
        totalBytes += batchBlob.size;

        // 更新元数据
        meta.completedBatches.push(batchIdx);
        completed.add(batchIdx);
        await saveMeta(downloadId, meta);

        // 释放内存
        batchChunks.length = 0;

        log('info', `[${taskLabel}] 批次 ${batchIdx + 1}/${totalBatches} 完成 (${(batchBlob.size / 1024 / 1024).toFixed(1)}MB)`);
      }

      // 5. 全部完成 → 合并导出
      clearInterval(throttleTimer); // 停止节流上报（进入合并/导出阶段，状态变为 exporting，不再受停滞判定管辖）
      log('info', `[${taskLabel}] 下载完成，总大小 ${(totalBytes / 1024 / 1024).toFixed(1)}MB，开始合并...`);
      reportProgress(downloadId, 98, total, total, '合并中...');

      const allBlobs = [];
      for (let b = 0; b < totalBatches; b++) {
        const buf = await opfsRead(`dl_${downloadId}_batch_${b}.blob`);
        if (!buf) throw new Error(`批次 ${b} 缓存丢失`);
        allBlobs.push(new Blob([buf]));
      }

      const finalBlob = new Blob(allBlobs, { type: 'video/mp4' });
      log('success', `[${taskLabel}] 合并完成: ${(finalBlob.size / 1024 / 1024).toFixed(1)}MB`);

      // 6. 触发下载：交给 background 用 chrome.downloads 触发（比 a.click() 稳定）
      const url = URL.createObjectURL(finalBlob);
      const filename = guessName(pageTitle || document.title);
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_BLOB', downloadId, blobUrl: url, filename }, (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          // 消息失败时 fallback 到页面内 a.click()
          log('warn', `[${taskLabel}] chrome.downloads 触发失败，回退 a.click()`);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          a.style.display = 'none';
          (document.body || document.documentElement).appendChild(a);
          a.click();
          // a.click() 降级路径：60s 后清理 a 元素 + revoke blob URL + 清理分片，
          // 并向 background 上报永久失败（blob 已交浏览器、无法确认保存结果，且分片已清理）——
          // 标 failed 释放并发槽，避免任务永久卡在 exporting/downloading 占槽。
          setTimeout(() => {
            if (a.parentNode) a.parentNode.removeChild(a);
            try { URL.revokeObjectURL(url); } catch {}
            VGP.cleanupOpfs(downloadId);
            log('info', `[${taskLabel}] a.click() 降级路径：blob 已释放、分片已清理`);
            chrome.runtime.sendMessage({
              type: 'DOWNLOAD_ERROR',
              downloadId,
              error: '已通过页面 a.click() 触发下载（无法确认保存结果），分片已清理，可重新下载',
              permanent: true
            }).catch(() => {});
          }, 60000);
        }
      });
      // 注意：这里不 revoke blob、不清理分片、不标完成——
      // 等 background 收到 Chrome 下载结果信号后发 FINALIZE_DOWNLOAD 再收尾，
      // 避免"扩展显示完成但 Chrome 下载失败"的状态不一致
      // （提示：下载完成前请保持视频页面打开，blob 数据在页面内存里）

      // 7. 下载循环结束
      removeAbortController(downloadId);
      runningDownloads.delete(downloadId);
      stopHeartbeat(downloadId);
      hideHiddenBanner();
    } catch (err) {
      // 所有退出路径都要清理节流上报定时器（成功路径在合并前已 clear，此处兜底异常/取消路径）
      try { clearInterval(throttleTimer); } catch {}
      // ★ 先读取取消来源：removeAbortController 会删掉 cancelReasons，必须在删除前读取，
      // 否则 reason 永远丢成 undefined → default 分支上报"已取消" → background 误判为
      // 用户手动取消（直接 return 不释放槽），停滞/心跳的自动重排确认失效，任务卡在
      // stopping 占槽，只能靠 30s 超时兜底反复重排。
      const cancelReason = cancelReasons.get(downloadId);
      removeAbortController(downloadId);
      runningDownloads.delete(downloadId);
      stopHeartbeat(downloadId);
      hideHiddenBanner();
      if (err.name === 'AbortError') {
        // 区分取消来源：调度器自动暂停（停滞/心跳/导航）≠ 用户手动暂停/取消
        const reason = cancelReason;
        let msg, errText;
        switch (reason) {
          case 'manual_pause':
            msg = '已暂停（手动），分片已保留可续传';
            errText = '已暂停';
            break;
          case 'manual_cancel':
            msg = '已取消（手动），分片已保留可续传';
            errText = '已取消';
            break;
          case 'stalled':
            msg = '已暂停（自动：长时间无进度），分片已保留可续传';
            errText = '已暂停(无进度)';
            break;
          case 'heartbeat':
            msg = '已暂停（自动：页面无响应），分片已保留可续传';
            errText = '已暂停(页面无响应)';
            break;
          case 'navigation':
            msg = '已暂停（自动：页面刷新/跳转），分片已保留可续传';
            errText = '已暂停(页面刷新)';
            break;
          default:
            msg = '下载被取消，分片已保留可续传';
            errText = '已取消';
        }
        log('info', `[${taskLabel}] ${msg}`);
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', downloadId, error: errText, done: totalDone, total });
      } else {
        log('error', `[${taskLabel}] 下载失败: ${err.message}`);
        // 永久错误（404/源站删除/无分片）→ permanent:true，background 直接判失败不重派
        const permanent = /404|永久错误|无分片/.test(err.message || '');
        // 失败时保留 OPFS（下次可续传）
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_ERROR', downloadId, error: err.message,
          done: totalDone || resumeFrom, total,
          permanent,
        });
      }
    }
  }

  function formatSpeed(bytesPerSec) {
    if (bytesPerSec < 0) return '';
    if (bytesPerSec > 1024 * 1024) return (bytesPerSec / 1024 / 1024).toFixed(1) + ' MB/s';
    if (bytesPerSec > 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
    return bytesPerSec.toFixed(0) + ' B/s';
  }

  function guessName(pageTitle) {
    if (pageTitle) {
      const cleaned = pageTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 120).trim();
      if (cleaned) return cleaned + '.mp4';
    }
    try {
      const parts = new URL(location.href).pathname.split('/');
      const id = parts.filter(Boolean).pop() || 'video';
      return `${id}.mp4`;
    } catch { return 'downloaded_video.mp4'; }
  }

  VGP.startDownload = startDownload;
  VGP.getAbortController = getAbortController;
  VGP.cancelReasons = cancelReasons;
  VGP.reportProgress = reportProgress;
})(window.VGP);
