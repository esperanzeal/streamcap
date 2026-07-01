// content.js — StreamCap v3
// 4 路并行下载 + OPFS 断点续传 + 分批合并
(() => {
  'use strict';

  // ============ 日志 ============
  const LOG_KEY = 'vgp_logs';
  function log(level, msg) {
    const entry = { time: new Date().toISOString(), level, msg };
    console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log']('[VGP]', msg);
    chrome.storage.local.get([LOG_KEY], r => {
      const logs = (r[LOG_KEY] || []).slice(-400);
      logs.push(entry);
      chrome.storage.local.set({ [LOG_KEY]: logs });
    });
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

  // ============ 重试 fetch ============
  async function fetchWithRetry(url, retries = 3, signal = null, extraHeaders = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      try {
        const resp = await fetch(url, { signal, headers: extraHeaders });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
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

  // ============ 核心：并行下载 + OPFS 持久化 ============
  async function startDownload(downloadId, m3u8Url, resumeFrom, concurrency, referer, pageTitle) {
    const ac = getAbortController(downloadId);
    const signal = ac.signal;

    log('info', `[${downloadId}] 开始下载: ${m3u8Url.substring(0, 60)}...`);
    if (resumeFrom > 0) log('info', `[${downloadId}] 断点续传，跳过前 ${resumeFrom} 段`);

    let total, totalDone = resumeFrom;

    try {
      // 0. OPFS 配额预检
      const estimate = await navigator.storage.estimate();
      const freeMB = (estimate.quota - estimate.usage) / 1024 / 1024;
      const needEstimate = resumeFrom > 0 ? 500 : 2048; // 续传用保守估计
      if (freeMB < needEstimate) {
        log('warn', `[${downloadId}] 磁盘剩余 ${freeMB.toFixed(0)}MB，可能不足`);
        reportProgress(downloadId, 0, 0, 0, `磁盘仅剩 ${freeMB.toFixed(0)}MB`);
      }

      const refHeaders = {};

      // 1. 获取 m3u8 文本
      let resp = await fetchWithRetry(m3u8Url, 3, signal, refHeaders);
      let text = await resp.text();
      log('info', `[${downloadId}] m3u8 获取成功 (${text.length}B)`);

      // 2. 解析 — textBaseUrl 始终跟踪 text 的来源 URL
      let textBaseUrl = m3u8Url;
      let parsed = parseM3u8(text, textBaseUrl);
      if (parsed.isMaster && parsed.variantUrls.length > 0) {
        const best = selectBestVariant(text);
        textBaseUrl = best ? resolveUrl(best, m3u8Url) : parsed.variantUrls[parsed.variantUrls.length - 1];
        log('info', `[${downloadId}] 选择子清单: ${textBaseUrl.substring(0, 60)}...`);
        resp = await fetchWithRetry(textBaseUrl, 3, signal, refHeaders);
        text = await resp.text();
        parsed = parseM3u8(text, textBaseUrl);
      }

      if (parsed.segments.length === 0) throw new Error('无分片');

      const keyInfo = parseKeyInfo(text, textBaseUrl);
      let cryptoKey = null;
      if (keyInfo) {
        log('info', `[${downloadId}] AES-128 加密，获取密钥...`);
        const keyBytes = await fetchDecryptKey(keyInfo.keyUrl, signal);
        cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        log('success', `[${downloadId}] 密钥就绪`);
      }

      total = parsed.segments.length;
      log('info', `[${downloadId}] 共 ${total} 个分片`);

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
            log('info', `[${downloadId}] 批次 ${batchIdx + 1}/${totalBatches} 已缓存，跳过`);
          } else {
            // 缓存丢失，重新下载
            completed.delete(batchIdx);
            log('warn', `[${downloadId}] 批次 ${batchIdx + 1} 缓存丢失，重新下载`);
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
              log('error', `[${downloadId}] 分片 ${segStart + idx + 1} 失败: ${err.message}`);
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
            log('info', `[${downloadId}] 重试分片 ${segStart + i + 1}`);
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

        log('info', `[${downloadId}] 批次 ${batchIdx + 1}/${totalBatches} 完成 (${(batchBlob.size / 1024 / 1024).toFixed(1)}MB)`);
      }

      // 5. 全部完成 → 合并导出
      log('info', `[${downloadId}] 下载完成，总大小 ${(totalBytes / 1024 / 1024).toFixed(1)}MB，开始合并...`);
      reportProgress(downloadId, 98, total, total, '合并中...');

      const allBlobs = [];
      for (let b = 0; b < totalBatches; b++) {
        const buf = await opfsRead(`dl_${downloadId}_batch_${b}.blob`);
        if (!buf) throw new Error(`批次 ${b} 缓存丢失`);
        allBlobs.push(new Blob([buf]));
      }

      const finalBlob = new Blob(allBlobs, { type: 'video/mp4' });
      log('success', `[${downloadId}] 合并完成: ${(finalBlob.size / 1024 / 1024).toFixed(1)}MB`);

      // 6. 触发下载
      const url = URL.createObjectURL(finalBlob);
      const filename = guessName(pageTitle || document.title, m3u8Url);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => {
        if (a.parentNode) a.parentNode.removeChild(a);
        URL.revokeObjectURL(url);
      }, 60000);

      // 7. 清理 OPFS
      for (let b = 0; b < totalBatches; b++) {
        await opfsDelete(`dl_${downloadId}_batch_${b}.blob`);
      }
      await deleteMeta(downloadId);

      removeAbortController(downloadId);
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_COMPLETE', downloadId, fileName: filename });
    } catch (err) {
      removeAbortController(downloadId);
      if (err.name === 'AbortError') {
        log('info', `[${downloadId}] 下载被用户取消`);
        await cleanupOpfs(downloadId); // 取消时清理 OPFS，不留垃圾
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', downloadId, error: '已取消', done: totalDone, total });
      } else {
        log('error', `[${downloadId}] 下载失败: ${err.message}`);
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

  function guessName(pageTitle, url) {
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
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
      sendResponse({ urls: extractVideoSources() });
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
})();
