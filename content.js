// content.js — StreamCap v3
// 4 路并行下载 + OPFS 断点续传 + 分批合并
(() => {
  'use strict';

  // ============ 日志（console + 按日期写入 storage.local） ============
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
      chrome.storage.local.get(key, data => {
        const arr = data[key] || [];
        arr.push(`[${now.toLocaleTimeString()}] [${level.toUpperCase()}] [页面] ${msg}`);
        if (arr.length > 5000) arr.splice(0, arr.length - 5000);
        chrome.storage.local.set({ [key]: arr });
      });
    } catch { /* 日志失败不影响主流程 */ }
  }

  // ============ AbortController 管理 ============
  const abortControllers = new Map(); // downloadId → AbortController

  function getAbortController(downloadId) {
    let ac = abortControllers.get(downloadId);
    if (!ac) { ac = new AbortController(); abortControllers.set(downloadId, ac); }
    return ac;
  }

  function removeAbortController(downloadId) {
    abortControllers.delete(downloadId);
  }

  // 清理某个 downloadId 的所有 OPFS 文件
  // 注意：当前不主动调用（所有停止流程都保留分片供续传，浏览器退出时自动清理）
  // 保留备用，未来如需"手动清理残留"功能可复用
  async function cleanupOpfs(downloadId) {
    const root = await navigator.storage.getDirectory();
    const prefix = OPFS_PREFIX + `dl_${downloadId}_`;
    const metaName = OPFS_PREFIX + `meta_${downloadId}.json`;
    try {
      for await (const [name] of root) {
        if (name.startsWith(prefix) || name === metaName) {
          try { await root.removeEntry(name); } catch {}
        }
      }
    } catch {}
  }

  // ============ OPFS 工具 ============
  const OPFS_PREFIX = 'vgp_';

  async function opfsWrite(name, data) {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(OPFS_PREFIX + name, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  }

  async function opfsRead(name) {
    const root = await navigator.storage.getDirectory();
    try {
      const fh = await root.getFileHandle(OPFS_PREFIX + name, { create: false });
      return await (await fh.getFile()).arrayBuffer();
    } catch { return null; }
  }

  async function opfsDelete(name) {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry(OPFS_PREFIX + name); } catch {}
  }

  async function opfsList(prefix) {
    const root = await navigator.storage.getDirectory();
    const names = [];
    for await (const [name] of root) {
      if (name.startsWith(OPFS_PREFIX + prefix)) names.push(name);
    }
    return names;
  }

  // ============ 断点续传元数据 ============
  async function saveMeta(downloadId, meta) {
    await opfsWrite(`meta_${downloadId}.json`, JSON.stringify(meta));
  }

  async function loadMeta(downloadId) {
    const buf = await opfsRead(`meta_${downloadId}.json`);
    return buf ? JSON.parse(new TextDecoder().decode(buf)) : null;
  }

  async function deleteMeta(downloadId) {
    await opfsDelete(`meta_${downloadId}.json`);
  }

  // ============ 重试 fetch（含 20s 超时，防 TCP 挂起卡死批次） ============
  async function fetchWithRetry(url, retries = 3, signal = null, extraHeaders = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const timeoutSignal = AbortSignal.timeout(20000); // 20s 无响应 → 超时按失败重试
      const sig = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        const resp = await fetch(url, { signal: sig, headers: extraHeaders });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp;
      } catch (err) {
        if (err.name === 'AbortError' && signal?.aborted) throw err; // 用户取消，直接抛
        if (err.name === 'AbortError') {
          // 超时（signal 未取消）：包装成普通错误按失败重试，不能被误判为用户取消
          err = new Error('下载超时（20s 无响应）');
        }
        if (attempt === retries) throw err;
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        log('warn', `重试 ${attempt}/${retries}，等待 ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  // ============ m3u8 解析 ============
  function resolveUrl(url, baseUrl) {
    try { return new URL(url, baseUrl).href; } catch {
      if (url.startsWith('http')) return url;
      return baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1) + url;
    }
  }

  function parseM3u8(text, baseUrl) {
    const lines = text.split('\n').map(l => l.trim());
    const segments = [], variantUrls = [];
    let isMaster = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line || line === '#EXTM3U') continue;
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        isMaster = true;
        for (let j = i + 1; j < lines.length; j++) {
          const n = lines[j];
          if (n && !n.startsWith('#')) { variantUrls.push(resolveUrl(n, baseUrl)); break; }
        }
      }
      if (line.startsWith('#')) continue;
      segments.push(resolveUrl(line, baseUrl));
    }
    return { segments, isMaster, variantUrls };
  }

  function selectBestVariant(text) {
    const lines = text.split('\n').map(l => l.trim());
    let bestBw = 0, bestUrl = null;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const m = lines[i].match(/BANDWIDTH=(\d+)/);
      const bw = m ? parseInt(m[1]) : 0;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j] && !lines[j].startsWith('#')) {
          if (bw > bestBw) { bestBw = bw; bestUrl = lines[j]; }
          break;
        }
      }
    }
    return bestUrl;
  }

  // ============ AES-128 解密 ============
  function parseKeyInfo(text, baseUrl) {
    const m = text.match(/#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"(?:,IV=(0x[0-9a-fA-F]+))?/);
    if (!m) return null;
    const keyUrl = resolveUrl(m[1], baseUrl);
    const ivHex = m[2] || null;
    const seqM = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
    const mediaSeq = seqM ? parseInt(seqM[1]) : 0;
    return { keyUrl, ivHex, mediaSeq };
  }

  async function fetchDecryptKey(keyUrl, signal) {
    const resp = await fetchWithRetry(keyUrl, 3, signal);
    return new Uint8Array(await resp.arrayBuffer());
  }

  async function decryptSegment(data, cryptoKey, iv) {
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv },
      cryptoKey,
      data
    );
    return new Uint8Array(decrypted);
  }

  function makeIV(ivHex, segIndex, mediaSeq) {
    if (ivHex) {
      const hex = ivHex.replace('0x', '').padStart(32, '0');
      const bytes = new Uint8Array(16);
      for (let i = 0; i < 16; i++) {
        bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    }
    const seq = mediaSeq + segIndex;
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setBigUint64(8, BigInt(seq), false);
    return bytes;
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
    // 日志任务标识：优先用任务名（如 ipzz196.mp4），没有时才回退到 id
    const taskLabel = pageTitle ? `${pageTitle}.mp4` : `#${downloadId}`;

    log('info', `[${taskLabel}] 开始下载: ${m3u8Url.substring(0, 60)}...`);
    if (resumeFrom > 0) log('info', `[${taskLabel}] 断点续传，跳过前 ${resumeFrom} 段`);
    startHeartbeat(downloadId); // 下载期间保活 SW，防止空闲被回收
    if (document.hidden) showHiddenBanner();

    let total, totalDone = resumeFrom;

    try {
      // 0. OPFS 配额预检
      const estimate = await navigator.storage.estimate();
      const freeMB = (estimate.quota - estimate.usage) / 1024 / 1024;
      const needEstimate = resumeFrom > 0 ? 500 : 2048; // 续传用保守估计
      if (freeMB < needEstimate) {
        log('warn', `[${taskLabel}] 磁盘剩余 ${freeMB.toFixed(0)}MB，可能不足`);
        reportProgress(downloadId, 0, 0, 0, `磁盘仅剩 ${freeMB.toFixed(0)}MB`);
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

      const keyInfo = parseKeyInfo(text, textBaseUrl);
      let cryptoKey = null;
      if (keyInfo) {
        log('info', `[${taskLabel}] AES-128 加密，获取密钥...`);
        const keyBytes = await fetchDecryptKey(keyInfo.keyUrl, signal);
        cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        log('success', `[${taskLabel}] 密钥就绪`);
      }

      total = parsed.segments.length;
      log('info', `[${taskLabel}] 共 ${total} 个分片`);

      // 3. 读取/创建断点元数据
      let meta = await loadMeta(downloadId);
      if (!meta || meta.totalSegments !== total) {
        // 新建元数据（或分片结构变了，重建）
        meta = { downloadId, totalSegments: total, completedBatches: [], batchSize: 80 };
        await saveMeta(downloadId, meta);
      } else if (resumeFrom > 0) {
        // 确保 meta 反映了之前的进度
        const expectedBatches = Math.ceil(resumeFrom / meta.batchSize);
        meta.completedBatches = [];
        for (let b = 0; b < expectedBatches; b++) meta.completedBatches.push(b);
        await saveMeta(downloadId, meta);
      }

      const BATCH_SIZE = meta.batchSize;
      const completed = new Set(meta.completedBatches);
      const totalBatches = Math.ceil(total / BATCH_SIZE);
      const CONCURRENCY = concurrency || 4;
      let totalBytes = 0;
      let totalDone = resumeFrom;
      let networkBytes = 0;
      const downloadStartTime = performance.now();

      // 4. 分批下载
      for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
        if (completed.has(batchIdx)) {
          // 已完成的 batch，只统计字节数
          const buf = await opfsRead(`dl_${downloadId}_batch_${batchIdx}.blob`);
          if (buf) {
            totalBytes += buf.byteLength;
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
              if (cryptoKey) {
                const iv = makeIV(keyInfo.ivHex, segStart + idx, keyInfo.mediaSeq);
                segData = await decryptSegment(segData, cryptoKey, iv);
              }
              batchChunks[idx] = segData;
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
          batchDone += mini.length;
          totalDone = segStart + batchDone;
          const elapsed = (performance.now() - downloadStartTime) / 1000;
          const speed = elapsed > 1 ? formatSpeed(networkBytes / elapsed) : '';
          const pct = Math.round((totalDone / total) * 100);
          reportProgress(downloadId, pct, totalDone, total, speed);
        }

        // 重试失败分片
        for (let i = 0; i < batchCount; i++) {
          if (batchChunks[i] !== null) continue;
          try {
            log('info', `[${taskLabel}] 重试分片 ${segStart + i + 1}`);
            const r = await fetchWithRetry(batchUrls[i], 5, signal, refHeaders);
            const rawBuf = await r.arrayBuffer();
            networkBytes += rawBuf.byteLength;
            let segData = new Uint8Array(rawBuf);
            if (cryptoKey) {
              const iv = makeIV(keyInfo.ivHex, segStart + i, keyInfo.mediaSeq);
              segData = await decryptSegment(segData, cryptoKey, iv);
            }
            batchChunks[i] = segData;
          } catch (err) {
            // 取消信号（AbortError）直接上抛，不能被包成普通错误 → 否则 background 无法识别"已取消"，会误触发自动重试
            if (err.name === 'AbortError') throw err;
            throw new Error(`分片 ${segStart + i + 1}/${total} 多次重试失败: ${err.message}`);
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
          setTimeout(() => { if (a.parentNode) a.parentNode.removeChild(a); }, 60000);
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
      removeAbortController(downloadId);
      runningDownloads.delete(downloadId);
      stopHeartbeat(downloadId);
      hideHiddenBanner();
      if (err.name === 'AbortError') {
        log('info', `[${taskLabel}] 下载被用户取消，分片已保留可续传`);
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', downloadId, error: '已取消', done: totalDone, total });
      } else {
        log('error', `[${taskLabel}] 下载失败: ${err.message}`);
        // 失败时保留 OPFS（下次可续传）
        chrome.runtime.sendMessage({
          type: 'DOWNLOAD_ERROR', downloadId, error: err.message,
          done: totalDone || resumeFrom, total,
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

  // ============ 页面级视频检测 ============
  function extractVideoSources() {
    const urls = [];
    document.querySelectorAll('video').forEach(v => {
      if (v.src && v.src.startsWith('http')) urls.push(v.src);
      if (v.currentSrc && v.currentSrc.startsWith('http')) urls.push(v.currentSrc);
      v.querySelectorAll('source').forEach(s => {
        if (s.src && s.src.startsWith('http')) urls.push(s.src);
      });
    });
    return [...new Set(urls)];
  }

  // ============ 消息处理 ============
  chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
    if (msg.type === 'START_DOWNLOAD') {
      startDownload(msg.downloadId, msg.m3u8Url, msg.resumeFrom || 0, msg.concurrency || 4, msg.referer || '', msg.pageTitle || '');
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'CANCEL_DOWNLOAD') {
      const ac = abortControllers.get(msg.downloadId);
      if (ac) {
        ac.abort();
        log('info', `[${msg.downloadId}] 发送中止信号`);
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
    // 清理孤儿分片：删除不属于任何活跃任务的分片（扩展启动时兜底清理）
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

  // ============ 合并导出浮层按钮 ============
  // OPFS 按 origin 隔离：分片存在"下载该视频的网站页面"的 OPFS 里，
  // 扩展页面读不到 → 必须在视频网站页面里触发合并（本页 content script 可读本页 OPFS）。
  // 点击后 showSaveFilePicker 选保存位置，流式逐批写盘：不占内存、不经过 Chrome 下载器。
  // 显示与否由 vgp_settings.mergeButton 开关控制（默认开）。
  function ensureMergeButton(show) {
    const existing = document.getElementById('vgp-merge-btn');
    if (show && !existing) {
      const btn = document.createElement('button');
      btn.id = 'vgp-merge-btn';
      btn.textContent = '🗜️ 合并导出';
      btn.title = 'StreamCap：把本网站缓存的下载分片直接合并保存到磁盘（不占内存）';
      btn.style.cssText = 'position:fixed;right:16px;bottom:60px;z-index:2147483647;background:#3b82f6;color:#fff;border:0;border-radius:8px;padding:10px 14px;font:13px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.45)';
      btn.addEventListener('click', onMergeClick);
      (document.body || document.documentElement).appendChild(btn);
    } else if (!show && existing) {
      existing.remove();
    }
  }

  async function initMergeButton() {
    const s = await chrome.storage.local.get('vgp_settings');
    ensureMergeButton((s.vgp_settings || {}).mergeButton !== false);
  }

  // 开关变化 → 已打开的页面实时显示/隐藏按钮
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.vgp_settings && changes.vgp_settings.newValue) {
      ensureMergeButton(changes.vgp_settings.newValue.mergeButton !== false);
    }
  });

  function taskDisplayName(d) {
    try {
      const base = d.url.split('/').pop().split('?')[0];
      if (base) return decodeURIComponent(base);
    } catch {}
    return '任务#' + d.id;
  }

  async function onMergeClick() {
    const root = await navigator.storage.getDirectory();
    const metaIds = new Set();
    for await (const [name] of root) {
      const m = name.match(/^vgp_meta_(\d+)\.json$/);
      if (m) metaIds.add(Number(m[1]));
    }
    if (!metaIds.size) {
      alert('本网站没有分片缓存。分片存在下载该视频的网站页面里（OPFS 按网站隔离），请到对应网站页面再试。');
      return;
    }
    const list = await new Promise(res => chrome.runtime.sendMessage({ type: 'GET_DOWNLOADS' }, r => res(r || [])));
    const tasks = (list || []).filter(d => metaIds.has(d.id));
    if (!tasks.length) {
      alert('找到分片但匹配不到任务（任务可能已被删除，分片将随清理回收）。');
      return;
    }
    let target = tasks[0];
    if (tasks.length > 1) {
      const pick = prompt('选择要合并的任务：\n' + tasks.map((d, i) => `${i + 1}. ${taskDisplayName(d)}`).join('\n'));
      const idx = parseInt(pick, 10) - 1;
      if (isNaN(idx) || !tasks[idx]) return;
      target = tasks[idx];
    }
    await mergeFromOpfs(target);
  }

  async function mergeFromOpfs(d) {
    // 0. 任务若还在下载，下载循环会持续改写分片文件 → 合并必冲突，先提示
    const fresh = await new Promise(res => chrome.runtime.sendMessage({ type: 'GET_DOWNLOADS' }, r => res(r || [])));
    const cur = (fresh || []).find(x => x.id === d.id);
    if (cur && ['downloading', 'queued', 'retrying'].includes(cur.status)) {
      if (!confirm(`任务「${taskDisplayName(d)}」正在下载中（${cur.status}），下载会持续改写分片文件，合并可能失败。\n\n建议：先到下载管理暂停该任务再回来合并。\n\n仍然继续合并吗？`)) return;
    }

    const root = await navigator.storage.getDirectory();
    let meta;
    try {
      meta = JSON.parse(await (await (await root.getFileHandle(OPFS_PREFIX + `meta_${d.id}.json`)).getFile()).text());
    } catch {
      alert('读取分片元数据失败，分片可能已被清理。');
      return;
    }
    const totalBatches = Math.ceil(meta.totalSegments / (meta.batchSize || 80));

    let handle;
    try {
      handle = await showSaveFilePicker({
        suggestedName: taskDisplayName(d).replace(/\.m3u8$/i, '.mp4'),
        types: [{ description: '视频文件', accept: { 'video/mp4': ['.mp4'], 'video/x-matroska': ['.mkv'] } }],
      });
    } catch (e) {
      if (e.name === 'AbortError') return;
      alert('选择保存位置失败: ' + e.message);
      return;
    }

    // 读批次文件，带重试：InvalidStateError（句柄快照失效/文件被并发改写）多为瞬时
    async function readBatch(i) {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const f = await (await root.getFileHandle(OPFS_PREFIX + `dl_${d.id}_batch_${i}.blob`)).getFile();
          return await f.arrayBuffer();
        } catch (e) {
          lastErr = e;
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      }
      throw lastErr;
    }

    // 扫描批次，确认完整 + 总大小
    const sizes = new Array(totalBatches);
    let totalBytes = 0;
    for (let i = 0; i < totalBatches; i++) {
      try {
        sizes[i] = (await readBatch(i)).byteLength;
        totalBytes += sizes[i];
      } catch { sizes[i] = -1; }
    }
    const missing = sizes.map((s, i) => s < 0 ? i : -1).filter(i => i >= 0);
    if (missing.length) {
      alert(`缺少 ${missing.length} 个批次（如 ${missing[0] + 1} 等）。先到下载管理对该任务点"继续/重试"补齐分片后再合并。`);
      return;
    }

    const writable = await handle.createWritable();
    let wrote = 0;
    let currentBatch = 0;
    const t0 = Date.now();
    const fmt = b => (b / 1024 / 1024 / 1024).toFixed(1) + 'GB';
    try {
      for (let i = 0; i < totalBatches; i++) {
        currentBatch = i;
        const buf = await readBatch(i);
        await writable.write(buf);
        wrote += buf.byteLength;
        if (i % 10 === 0 || i === totalBatches - 1) {
          const secs = Math.max(1, (Date.now() - t0) / 1000);
          log('info', `[合并] ${taskDisplayName(d)} ${fmt(wrote)}/${fmt(totalBytes)} 批次 ${i + 1}/${totalBatches} (${(wrote / 1024 / 1024 / secs).toFixed(0)}MB/s)`);
        }
      }
      await writable.close();
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      log('success', `[合并] ${taskDisplayName(d)} 合并完成 ${fmt(wrote)}，用时 ${secs} 秒`);
      alert(`✅ 合并完成：${fmt(wrote)}，用时 ${secs} 秒。分片保留在缓存中，确认文件无误后可到下载管理删除该任务以清理。`);
    } catch (e) {
      log('error', `[合并] ${taskDisplayName(d)} 失败（批次 ${currentBatch + 1}/${totalBatches}）: ${e.message}`);
      // 数据已基本写完但落盘确认失败：临时文件(.crswap)里可能就是完整成品
      if (totalBytes > 0 && wrote / totalBytes > 0.999) {
        alert(`⚠️ 合并数据已基本写满（${fmt(wrote)}/${fmt(totalBytes)}）但最后落盘确认失败：${e.message}\n\n目标文件夹里通常有一个 <文件名>.crswap 临时文件——检查它的大小，若接近 ${fmt(totalBytes)} 就直接改后缀为 .mp4 即可播放，无需重新合并。`);
      } else {
        alert(`合并失败（批次 ${currentBatch + 1}/${totalBatches}）: ${e.message}\n\n分片未动，可重新选择位置再来。若任务正在下载，请先暂停它再合并。`);
      }
      try { await writable.abort(); } catch {}
    }
  }

  // 页面就绪后注入按钮（受开关控制）
  const tryInject = () => {
    if (document.body) { initMergeButton(); return; }
    setTimeout(tryInject, 500);
  };
  tryInject();
})();
