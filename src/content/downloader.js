// content downloader.js — 核心下载循环（并行分片 + OPFS 断点续传 + 分批合并）
'use strict';
window.VGP = window.VGP || {};
(function (VGP) {
  // ★★ 重复注入守卫（「下载文件重复落盘」的根因）：background 的 startTaskInTab 在
  //    sendMessage 抛错时会用 scripting.executeScript 把同一批 content 文件**再注入一遍**
  //    （页面刚 reload / 就绪竞态时很常见）。没有守卫时页面上会出现**两个 downloader 实例**：
  //    各自的 runningDownloads 互不可见 → 同一任务两个下载循环并行 → 各自合并导出 →
  //    Chrome 创建两个下载项。真机日志实证：同一秒 #653 / #654，磁盘出现 "xxx (1).mp4"。
  if (VGP.__downloaderLoaded) {
    try { console.warn('[VGP] downloader 被重复注入，本次实例直接退出'); } catch { /* ignore */ }
    return;
  }
  VGP.__downloaderLoaded = true;
  const { log, fetchWithRetry, parseM3u8, selectBestVariant, resolveUrl,
    parseKeySegments, findKeyForSegment, fetchDecryptKey, decryptSegment, makeIV,
    opfsWrite, opfsRead, saveMeta, loadMeta, detectFormat } = VGP;

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

  // 轻量"活动"上报：分片/分块请求尝试过（成功、失败、超时都算）就发一次，让 background
  // 区分"在慢慢重试/慢下载"与"真卡死"——停滞判定只看 done 增长时，坏分片重试 115s 会被
  // 误判为卡死（CANCEL 打断重试 → 重排 → 再判 → failed）。只带 activity、不带 done：不碰进度字段。
  function reportActivity(downloadId) {
    chrome.runtime.sendMessage({ type: 'PROGRESS', downloadId, activity: 1 }).catch(() => {});
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
  async function startDownload(downloadId, m3u8Url, resumeFrom, concurrency, referer, pageTitle, format) {
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

    // ★ 阶段3 格式分流：MP4 直链走 Range 分块下载，DASH(mpd) 走分片下载（其余 m3u8 走下方分片下载）
    // 优先用 background 传入的 format（URL 无 .mp4 后缀时靠 Content-Type 识别），
    // 兜底用 URL 后缀判断
    const fmt = format || detectFormat(m3u8Url);
    if (fmt === 'mp4') {
      return downloadDirect(downloadId, m3u8Url, resumeFrom, concurrency, referer, pageTitle, signal);
    }
    if (fmt === 'dash') {
      return downloadDash(downloadId, m3u8Url, resumeFrom, concurrency, referer, pageTitle, signal);
    }

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
      let resp = await fetchWithRetry(m3u8Url, 3, signal, refHeaders, () => reportActivity(downloadId));
      let text = await resp.text();
      log('info', `[${taskLabel}] m3u8 获取成功 (${text.length}B)`);

      // 2. 解析 — textBaseUrl 始终跟踪 text 的来源 URL
      let textBaseUrl = m3u8Url;
      let parsed = parseM3u8(text, textBaseUrl);
      if (parsed.isMaster && parsed.variantUrls.length > 0) {
        const best = selectBestVariant(text);
        textBaseUrl = best ? resolveUrl(best, m3u8Url) : parsed.variantUrls[parsed.variantUrls.length - 1];
        log('info', `[${taskLabel}] 选择子清单: ${textBaseUrl.substring(0, 60)}...`);
        resp = await fetchWithRetry(textBaseUrl, 3, signal, refHeaders, () => reportActivity(downloadId));
        text = await resp.text();
        parsed = parseM3u8(text, textBaseUrl);
      }

      if (parsed.segments.length === 0) throw new Error('无分片');

      // fMP4（EXT-X-MAP）：init 段必须拼在所有分片之前，否则下载产物无法播放。
      // 体积小（几十~几百 KB），下载后驻留内存，合并时 prepend；续传时重新下载。
      // 失败按普通错误上报（可重试），不带永久失败关键词。
      let initBytes = null;
      if (parsed.mapUrl) {
        const r = await fetchWithRetry(parsed.mapUrl, 3, signal, refHeaders, () => reportActivity(downloadId));
        initBytes = new Uint8Array(await r.arrayBuffer());
        // 落盘（dl_{id}_map.bin）：手动「合并导出」只能读 OPFS，若不落盘其产物会缺 init 无法播放
        await opfsWrite(`dl_${downloadId}_map.bin`, initBytes);
        log('info', `[${taskLabel}] fMP4 init 段就绪 (${initBytes.byteLength}B，已落盘供合并导出)`);
      }

      const { keySegments, mediaSeq } = parseKeySegments(text, textBaseUrl);
      const keyCache = new Map(); // keyUrl → cryptoKey（懒加载，支持 key rotation）
      // ★ 只统计/预取真正带密钥的段：METHOD=NONE（明文）与不支持的 method 段
      //   keyUrl 为 null，直接取 keySegments[0] 会 fetchDecryptKey(null) → 请求 /null
      //   → HTTP 404 → 命中永久失败正则，把合法清单误判为永久失败。
      const encryptedSegs = keySegments.filter(k => k.keyUrl);
      if (encryptedSegs.length > 0) {
        log('info', `[${taskLabel}] AES-128 加密（${encryptedSegs.length} 个 key 段），预取首个密钥...`);
        const firstKey = encryptedSegs[0];
        const keyBytes = await fetchDecryptKey(firstKey.keyUrl, signal);
        keyCache.set(firstKey.keyUrl, await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']));
        if (encryptedSegs.length > 1) log('info', `[${taskLabel}] 检测到 key rotation，其余密钥按需加载`);
        log('success', `[${taskLabel}] 密钥就绪`);
      }

      total = parsed.segments.length;
      log('info', `[${taskLabel}] 共 ${total} 个分片`);

      // 3. 读取/创建断点元数据
      let meta = await loadMeta(downloadId);
      if (!meta || meta.totalSegments !== total) {
        // 新建元数据（或分片结构变了，重建）
        meta = { downloadId, totalSegments: total, completedBatches: [], batchSize: 40, kind: 'batch' };
        await saveMeta(downloadId, meta);
        if (VGP.refreshMergeButton) VGP.refreshMergeButton(); // meta 已落盘 → 合并导出按钮即时出现
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
      const throttleTimer = startThrottle(downloadId, () => {
        const elapsed = (performance.now() - downloadStartTime) / 1000;
        return { pct: Math.round(totalDone / total * 100), done: totalDone, total, speed: liveSpeed(downloadId) };
      });
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
              const r = await fetchWithRetry(url, 3, signal, refHeaders, () => reportActivity(downloadId));
              const rawBuf = await r.arrayBuffer();
              networkBytes += rawBuf.byteLength;
              trackBytes(downloadId, networkBytes); // 实时速度采样
              let segData = new Uint8Array(rawBuf);
              if (keySegments.length > 0) {
                const ks = findKeyForSegment(keySegments, segStart + idx);
                // ks.keyUrl 为空 = 该区段 METHOD=NONE 或不支持的加密方式 → 明文保留
                if (ks && ks.keyUrl) {
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
          const speed = liveSpeed(downloadId); // 实时速度
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
            const r = await fetchWithRetry(batchUrls[i], 5, signal, refHeaders, () => reportActivity(downloadId));
            const rawBuf = await r.arrayBuffer();
            networkBytes += rawBuf.byteLength;
            trackBytes(downloadId, networkBytes); // 实时速度采样
            // 重试成功后：该分片计入成功进度（并行阶段失败时没计，这里补上）
            totalDone++;
            reportProgress(downloadId, Math.round(totalDone / total * 100), totalDone, total, '');
            let segData = new Uint8Array(rawBuf);
            if (keySegments.length > 0) {
              const ks = findKeyForSegment(keySegments, segStart + i);
              // ks.keyUrl 为空 = 该区段 METHOD=NONE 或不支持的加密方式 → 明文保留
              if (ks && ks.keyUrl) {
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

      // ★ 用 OPFS 文件的 File 对象（磁盘支撑）组装 Blob，而不是把全部数据读回
      //   ArrayBuffer——大文件时后者会把整个视频堆进 JS 堆（P0-5：80GB 级必崩）
      const allBlobs = [];
      // fMP4：init 段（EXT-X-MAP）必须在所有分片之前，否则产物无法播放
      if (initBytes) allBlobs.push(new Blob([initBytes]));
      for (let b = 0; b < totalBatches; b++) {
        const f = await VGP.opfsGetFile(`dl_${downloadId}_batch_${b}.blob`);
        if (!f) throw new Error(`批次 ${b} 缓存丢失`);
        allBlobs.push(f);
      }

      const finalBlob = new Blob(allBlobs, { type: 'video/mp4' });
      log('success', `[${taskLabel}] 合并完成: ${(finalBlob.size / 1024 / 1024).toFixed(1)}MB`);

      // 6. 触发下载：交给 background 用 chrome.downloads 触发（比 a.click() 稳定）
      exportBlob(downloadId, finalBlob, pageTitle, taskLabel);
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
      // ★ reportDownloadError 内部先读取消来源再 removeAbortController（避免 reason 丢失）
      reportDownloadError(downloadId, err, taskLabel, { done: totalDone, total, resumeFrom });
    }
  }

  // ============ MP4 直链下载（Range 分块 + OPFS 断点续传 + 合并导出） ============
  // 阶段3：格式分流入口（startDownload 检测 mp4 URL 时调用）。
  // 16MB/块 Range 下载，块级断点续传（meta.completedBatches 复用），完成合并 → DOWNLOAD_BLOB。
  async function downloadDirect(downloadId, url, resumeFrom, concurrency, referer, pageTitle, signal) {
    const taskLabel = pageTitle ? `${pageTitle}.mp4` : `#${downloadId}`;
    let totalBlocks = 0;
    let totalDone = 0;
    let throttleTimer = null;
    try {
      // 1. 探测总大小（页面 fetch Range，浏览器自动带 Referer；页面需保持打开）
      let size = 0;
      let probeInfo = '';
      try {
        const r = await fetch(url, { headers: { Range: 'bytes=0-0' } });
        probeInfo = `HTTP ${r.status}`;
        if (r.status === 206) {
          const cr = r.headers.get('content-range');
          const m = cr && cr.match(/\/(\d+)$/);
          if (m) size = parseInt(m[1]);
        } else if (r.status === 200) {
          const len = r.headers.get('content-length');
          if (len) size = parseInt(len);
        }
      } catch (e) {
        probeInfo = '异常: ' + e.message;
      }
      log('info', `[${taskLabel}] MP4 大小探测 ${probeInfo}${size ? ` → ${(size / 1024 / 1024).toFixed(1)}MB` : '（无大小，降级流式）'}`);
      if (!size) {
        // 降级：服务器不支持 Range/无 content-length（chunked 流/签名接口）
        // → 流式整体下载（边读边写 OPFS，无精确进度、无断点续传，但能下载）
        return downloadStream(downloadId, url, signal, pageTitle, taskLabel);
      }

      // 2. 分块（16MB/块）
      const BLOCK_SIZE = 16 * 1024 * 1024;
      totalBlocks = Math.ceil(size / BLOCK_SIZE);

      // 3. 断点元数据（块级续传，复用 HLS meta 结构）
      let meta = await loadMeta(downloadId);
      if (!meta || meta.totalSegments !== totalBlocks) {
        meta = { downloadId, totalSegments: totalBlocks, completedBatches: [], batchSize: 1, kind: 'block' };
        await saveMeta(downloadId, meta);
        if (VGP.refreshMergeButton) VGP.refreshMergeButton(); // meta 已落盘 → 合并导出按钮即时出现
      }
      const completed = new Set(meta.completedBatches);
      const CONCURRENCY = concurrency || 4;
      let totalBytes = 0;
      const downloadStartTime = performance.now();
      throttleTimer = startThrottle(downloadId, () => ({ pct: Math.round(totalDone / totalBlocks * 100), done: totalDone, total: totalBlocks }));

      // 4. 下载每块（Range 请求，并行 CONCURRENCY）
      for (let blockIdx = 0; blockIdx < totalBlocks; blockIdx++) {
        if (completed.has(blockIdx)) {
          // 续传：统计已有块字节
          const buf = await opfsRead(`dl_${downloadId}_block_${blockIdx}.bin`);
          if (buf) {
            totalBytes += buf.byteLength;
            totalDone = blockIdx + 1;
            reportProgress(downloadId, Math.round(totalDone / totalBlocks * 100), totalDone, totalBlocks, '');
            continue;
          }
          completed.delete(blockIdx); // 缓存丢失，重新下载
        }
        const start = blockIdx * BLOCK_SIZE;
        const end = Math.min(start + BLOCK_SIZE, size) - 1;
        let data;
        try {
          const r = await fetchWithRetry(url, 3, signal, { Range: `bytes=${start}-${end}` }, () => reportActivity(downloadId));
          data = new Uint8Array(await r.arrayBuffer());
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          if (/404/.test(err.message || '')) throw new Error(`MP4 分块 ${blockIdx + 1}/${totalBlocks} 返回 404（永久错误）`);
          throw new Error(`MP4 分块 ${blockIdx + 1}/${totalBlocks} 下载失败: ${err.message}`);
        }
        await opfsWrite(`dl_${downloadId}_block_${blockIdx}.bin`, data);
        totalBytes += data.byteLength;
        meta.completedBatches.push(blockIdx);
        completed.add(blockIdx);
        await saveMeta(downloadId, meta);
        totalDone = blockIdx + 1;
        reportProgress(downloadId, Math.round(totalDone / totalBlocks * 100), totalDone, totalBlocks, '');
        log('info', `[${taskLabel}] 分块 ${blockIdx + 1}/${totalBlocks} 完成 (${(data.byteLength / 1024 / 1024).toFixed(1)}MB)`);
      }
      clearInterval(throttleTimer);

      // 5. 合并 → blob → DOWNLOAD_BLOB
      //    合并要逐块读 OPFS 组装 File 列表（大文件可达数分钟），期间**没有任何网络请求**，
      //    后台的停滞判定只看 done/请求活动 → 会以为任务卡死。这里每读若干块补一次 activity
      //    心跳，让 background 知道"还在合并"，绝不因合并慢而刷新页面（刷新会打断合并，
      //    页面重载后任务又被重派 → 重新下载 + 二次导出 → 磁盘出现 "xxx (1).mp4" 重复文件）。
      log('info', `[${taskLabel}] 分块全部完成，开始合并...`);
      reportProgress(downloadId, 98, totalBlocks, totalBlocks, '合并中...');
      const chunks = [];
      for (let b = 0; b < totalBlocks; b++) {
        if (b % 8 === 0) reportActivity(downloadId); // 合并心跳：只表示"还活着"，不涉及进度
        // 磁盘支撑的 File（不读回 JS 堆）——大文件合并的内存友好路径（P0-5）
        const f = await VGP.opfsGetFile(`dl_${downloadId}_block_${b}.bin`);
        if (!f) throw new Error(`分块 ${b} 缓存丢失`);
        chunks.push(f);
      }
      const finalBlob = new Blob(chunks, { type: 'video/mp4' });
      log('success', `[${taskLabel}] 合并完成: ${(finalBlob.size / 1024 / 1024).toFixed(1)}MB`);
      exportBlob(downloadId, finalBlob, pageTitle, taskLabel);
      removeAbortController(downloadId);
      runningDownloads.delete(downloadId);
      stopHeartbeat(downloadId);
      hideHiddenBanner();
    } catch (err) {
      try { clearInterval(throttleTimer); } catch {}
      reportDownloadError(downloadId, err, taskLabel, {
        done: totalDone, total: totalBlocks, resumeFrom,
      });
    }
  }

  // ============ MP4 流式整体下载（降级：服务器不支持 Range/无 content-length） ============
  // 边读边写 OPFS 单块，避免大文件占内存；无精确进度（total 未知），速度实时上报。
  async function downloadStream(downloadId, url, signal, pageTitle, taskLabel) {
    let received = 0;
    let lastReport = 0;
    try {
      const resp = await fetch(url, { signal });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(VGP.OPFS_PREFIX + `dl_${downloadId}_block_0.bin`, { create: true });
      const w = await fh.createWritable();
      const reader = resp.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await w.write(value);
        received += value.byteLength;
        // 每 8MB 报一次进度（total=0 表示未知，manager 显示"—"但有速度）
        if (received - lastReport > 8 * 1024 * 1024) {
          lastReport = received;
          reportProgress(downloadId, 0, received, 0, '');
        }
      }
      await w.close();
      log('success', `[${taskLabel}] 流式下载完成: ${(received / 1024 / 1024).toFixed(1)}MB`);

      // 合并 → blob → DOWNLOAD_BLOB
      reportProgress(downloadId, 98, received, 0, '合并中...');
      reportActivity(downloadId); // 合并心跳（流式路径：这一份是唯一一份数据，别被判停摆打断）
      // 用磁盘支撑的 File 组装 Blob（不读回 JS 堆）——与分块/batch/seg 路径一致
      const streamFile = await VGP.opfsGetFile(`dl_${downloadId}_block_0.bin`);
      if (!streamFile) throw new Error('缓存丢失');
      exportBlob(downloadId, new Blob([streamFile], { type: 'video/mp4' }), pageTitle, taskLabel);
      removeAbortController(downloadId);
      runningDownloads.delete(downloadId);
      stopHeartbeat(downloadId);
      hideHiddenBanner();
    } catch (err) {
      reportDownloadError(downloadId, err, taskLabel, {
        done: 0, total: 0, resumeFrom: 0,
        abortNote: `，已下载 ${(received / 1024 / 1024).toFixed(1)}MB 未保留（流式无续传）`,
      });
    }
  }

  // ============ DASH (mpd) 分片下载 ============
  // 阶段3-2：解析 mpd → 视频轨最佳 Representation → init 段 + media 分片 → 拼接导出。
  // 支持 SegmentList（显式分片）和 SegmentTemplate（$Number$ 模板，部分站点风格）。
  // DASH fMP4 = init 段(moov) + media 段(mdat) 顺序拼接即完整 mp4。
  function parseIsoDuration(s) {
    const m = String(s).match(/PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/);
    if (!m) return 0;
    return (parseFloat(m[1] || 0) * 3600 + parseFloat(m[2] || 0) * 60 + parseFloat(m[3] || 0)) * 1000;
  }

  async function downloadDash(downloadId, mpdUrl, resumeFrom, concurrency, referer, pageTitle, signal) {
    const taskLabel = pageTitle ? `${pageTitle}.mp4` : `#${downloadId}`;
    let totalItems = 0;
    let totalDone = 0;
    let throttleTimer = null;
    try {
      // 1. 获取 mpd
      const resp = await fetchWithRetry(mpdUrl, 3, signal, {}, () => reportActivity(downloadId));
      const xml = await resp.text();
      const doc = new DOMParser().parseFromString(xml, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('mpd 解析失败');
      // 2. 找视频轨 AdaptationSet
      const as = [...doc.querySelectorAll('AdaptationSet')].find(a => {
        const ct = a.getAttribute('contentType');
        const mime = (a.getAttribute('mimeType') || '');
        return ct === 'video' || (mime.includes('video/mp4') && ct !== 'audio');
      });
      if (!as) throw new Error('mpd 未找到视频轨');
      // 3. 最佳 Representation（带宽最高）
      const reps = [...as.querySelectorAll('Representation')];
      if (!reps.length) throw new Error('mpd 无 Representation');
      const rep = reps.sort((a, b) => (parseInt(b.getAttribute('bandwidth')) || 0) - (parseInt(a.getAttribute('bandwidth')) || 0))[0];
      const repId = rep.getAttribute('id') || '';
      const repl = s => String(s).replace(/\$RepresentationID\$/g, repId);
      // 4. 分片列表（SegmentList 显式 / SegmentTemplate $Number$）
      let initUrl = '';
      let segUrls = [];
      const segList = rep.querySelector('SegmentList') || as.querySelector('SegmentList');
      if (segList) {
        initUrl = repl(segList.getAttribute('initialization') || '');
        segUrls = [...segList.querySelectorAll('SegmentURL')].map(s => repl(s.getAttribute('media') || '')).filter(Boolean);
      } else {
        const st = rep.querySelector('SegmentTemplate') || as.querySelector('SegmentTemplate');
        if (!st) throw new Error('mpd 无 SegmentTemplate/SegmentList');
        initUrl = repl(st.getAttribute('initialization') || '');
        const mediaTpl = repl(st.getAttribute('media') || '');
        const startNum = parseInt(st.getAttribute('startNumber')) || 1;
        const timescale = parseInt(st.getAttribute('timescale')) || 1;
        const segDur = parseInt(st.getAttribute('duration')) || 0;
        let totalMs = 0;
        const mpdEl = doc.querySelector('MPD');
        const mpdDur = mpdEl && mpdEl.getAttribute('mediaPresentationDuration');
        const period = doc.querySelector('Period');
        const pDur = period && period.getAttribute('duration');
        if (mpdDur) totalMs = parseIsoDuration(mpdDur);
        else if (pDur) totalMs = parseIsoDuration(pDur);
        if (!totalMs || !segDur) throw new Error('mpd 无法计算分片数（无时长信息）');
        const segCount = Math.ceil(totalMs / (segDur * 1000 / timescale));
        for (let i = 0; i < segCount; i++) segUrls.push(mediaTpl.replace(/\$Number\$/g, String(startNum + i)));
      }
      if (!initUrl) throw new Error('mpd 无 init 段 URL');
      initUrl = resolveUrl(initUrl, mpdUrl);
      segUrls = segUrls.map(u => resolveUrl(u, mpdUrl));
      if (!segUrls.length) throw new Error('mpd 无分片');
      totalItems = segUrls.length + 1; // [0]=init, [1..]=media 段
      log('info', `[${taskLabel}] DASH：${segUrls.length} 个分片 + init 段，init=${initUrl.substring(0, 60)}`);

      // 5. 断点元数据 + 下载（init 段 [0] + media 段 [1..]）
      let meta = await loadMeta(downloadId);
      if (!meta || meta.totalSegments !== totalItems) {
        meta = { downloadId, totalSegments: totalItems, completedBatches: [], batchSize: 1, kind: 'seg' };
        await saveMeta(downloadId, meta);
        if (VGP.refreshMergeButton) VGP.refreshMergeButton(); // meta 已落盘 → 合并导出按钮即时出现
      }
      const completed = new Set(meta.completedBatches);
      const CONCURRENCY = concurrency || 4;
      const downloadStartTime = performance.now();
      throttleTimer = startThrottle(downloadId, () => ({ pct: Math.round(totalDone / totalItems * 100), done: totalDone, total: totalItems }));
      const urls = [initUrl, ...segUrls];
      for (let i = 0; i < urls.length; i++) {
        if (completed.has(i)) {
          totalDone = i;
          reportProgress(downloadId, Math.round(totalDone / totalItems * 100), totalDone, totalItems, '');
          continue;
        }
        let data;
        try {
          const r = await fetchWithRetry(urls[i], 3, signal, {}, () => reportActivity(downloadId));
          data = new Uint8Array(await r.arrayBuffer());
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          if (/404/.test(err.message || '')) throw new Error(`段 ${i}/${totalItems} 返回 404（永久错误）`);
          throw new Error(`段 ${i}/${totalItems} 下载失败: ${err.message}`);
        }
        await opfsWrite(`dl_${downloadId}_seg_${i}.bin`, data);
        meta.completedBatches.push(i);
        completed.add(i);
        await saveMeta(downloadId, meta);
        totalDone = i;
        reportProgress(downloadId, Math.round(totalDone / totalItems * 100), totalDone, totalItems, '');
        log('info', `[${taskLabel}] ${i === 0 ? 'init 段' : '分片 ' + i + '/' + segUrls.length} 完成`);
      }
      clearInterval(throttleTimer);

      // 6. 拼接合并（init + media 段顺序）→ blob → DOWNLOAD_BLOB
      log('info', `[${taskLabel}] 全部分片完成，开始合并...`);
      reportProgress(downloadId, 98, totalItems, totalItems, '合并中...');
      const parts = [];
      for (let i = 0; i < totalItems; i++) {
        if (i % 8 === 0) reportActivity(downloadId); // 合并心跳：分片已下完，这里只剩磁盘读取，别被判停摆打断
        // 磁盘支撑的 File（不读回 JS 堆）——大文件合并的内存友好路径（P0-5）
        const f = await VGP.opfsGetFile(`dl_${downloadId}_seg_${i}.bin`);
        if (!f) throw new Error(`段 ${i} 缓存丢失`);
        parts.push(f);
      }
      const finalBlob = new Blob(parts, { type: 'video/mp4' });
      log('success', `[${taskLabel}] 合并完成: ${(finalBlob.size / 1024 / 1024).toFixed(1)}MB`);
      exportBlob(downloadId, finalBlob, pageTitle, taskLabel);
      removeAbortController(downloadId);
      runningDownloads.delete(downloadId);
      stopHeartbeat(downloadId);
      hideHiddenBanner();
    } catch (err) {
      try { clearInterval(throttleTimer); } catch {}
      reportDownloadError(downloadId, err, taskLabel, {
        done: totalDone, total: totalItems, resumeFrom,
      });
    }
  }

  // ============ 实时速度（滑动窗口） ============
  // 只统计"最近 4 秒"的字节增量，而不是"从任务开始到现在的平均速度"——
  // 平均值会被历史拉平：任务单独吃满带宽时仍显示旧的慢速值（真机实测：8 并发时 2.5MB/s，
  // 只剩它一个吃满 14MB/s 仍显示 2.5），任务卡死后也不下降（僵在几十 KB）。
  const speedTrack = new Map(); // downloadId → { samples: [{ t, bytes }], text }
  const SPEED_WINDOW_MS = 4000; // 4s 窗口 = "当前速度"，太长会把之前的慢速段一起平均进来

  // 每下完一个分片/分块调用：记录 (时间, 累计字节) 快照
  function trackBytes(downloadId, totalBytes) {
    let s = speedTrack.get(downloadId);
    if (!s) { s = { samples: [], text: "", lastAt: 0 }; speedTrack.set(downloadId, s); }
    const now = performance.now();
    s.samples.push({ t: now, bytes: totalBytes });
    while (s.samples.length > 1 && now - s.samples[0].t > SPEED_WINDOW_MS) s.samples.shift();
  }

  // 当前实时速度：窗口内最老/最新两点求差。样本间隔太近（<0.5s）时沿用上次值，避免数字抖动。
  // 若窗口里已不足 2 个样本（长时间没有新分片完成）→ 返回空，UI 不再显示陈旧速度。
  function liveSpeed(downloadId) {
    const s = speedTrack.get(downloadId);
    if (!s || s.samples.length < 2) { if (s) s.text = ""; return ""; }
    const now = performance.now();
    // 只保留窗口内的样本；样本不足 2 个（长时间没有新分片 = 实际停摆）→ 清空速度，UI 不再显示陈旧值
    while (s.samples.length > 1 && now - s.samples[0].t > SPEED_WINDOW_MS) s.samples.shift();
    if (s.samples.length < 2) { s.text = ""; return ""; }
    // 距上次算过不到 1s → 沿用上次值，避免界面数字抖动
    if (s.lastAt && now - s.lastAt < 1000) return s.text;
    const a = s.samples[0], b = s.samples[s.samples.length - 1];
    const dt = (b.t - a.t) / 1000;
    if (dt < 0.4) return s.text;
    s.lastAt = now;
    s.text = formatSpeed((b.bytes - a.bytes) / dt);
    return s.text;
  }

  // 任务结束时清掉采样（避免 Map 长期占用）
  function clearSpeed(downloadId) { speedTrack.delete(downloadId); }

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

  // ============ 公共 helper（四路下载路径共用，消除复制粘贴） ============

  // 统一永久错误判定：404/解析失败/无分片等重试无意义 → 直接失败。
  // 注意 404 必须限定为 HTTP 状态文案：错误信息里常带分片 URL（路径可能含 "404"），
  // 裸 /404/ 会把合法路径误判为永久失败。
  const PERMANENT_PATTERN = /HTTP 404|404 Not Found|永久错误|无分片|无法获取文件大小|mpd 解析失败|未找到视频轨|无 Representation|无 SegmentTemplate|无法计算分片数|无 init 段 URL/;

  // 节流上报模板：每 15s 报一次（setInterval 每 5s 检查），getProgress 返回 { pct, done, total, speed? }
  function startThrottle(downloadId, getProgress) {
    let last = 0;
    return setInterval(() => {
      const now = Date.now();
      if (now - last < 3000) return; // v5：实时速度 → 3s 上报一次（原 15s 太滞后）
      last = now;
      const p = getProgress(now);
      reportProgress(downloadId, p.pct, p.done, p.total, p.speed || '');
    }, 1000);
  }

  // 合并导出：blob → DOWNLOAD_BLOB → 失败回退 a.click() → 60s 后清理
  function exportBlob(downloadId, finalBlob, pageTitle, taskLabel) {
    const blobUrl = URL.createObjectURL(finalBlob);
    const filename = guessName(pageTitle || document.title);
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_BLOB', downloadId, blobUrl, filename }, (resp) => {
      // ★ 后台判定为重复导出（另一个 content 实例已经在导出了）→ **绝不能回退 a.click()**：
      //   那会真的再写一个文件，把"防重复落盘"反过来变成"再多落一份"。本实例只释放 blob。
      if (resp && resp.duplicate) {
        log('warn', `[${taskLabel}] 后台已判定为重复导出（另有实例在导出），本实例放弃并释放 blob`);
        try { URL.revokeObjectURL(blobUrl); } catch {}
        return;
      }
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        log('warn', `[${taskLabel}] chrome.downloads 触发失败，回退 a.click()`);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.style.display = 'none';
        (document.body || document.documentElement).appendChild(a);
        a.click();
        setTimeout(() => {
          if (a.parentNode) a.parentNode.removeChild(a);
          try { URL.revokeObjectURL(blobUrl); } catch {}
          VGP.cleanupOpfs(downloadId);
          // a.click() 回退：文件很可能已进入下载目录（浏览器下载器之外的路径扩展无法追踪）
          // → 标为已完成并附提示，而不是 failed（旧行为让用户以为失败而重复下载）
          chrome.runtime.sendMessage({
            type: 'DOWNLOAD_FALLBACK_DONE',
            downloadId,
            fileName: filename,
            note: '已通过页面触发下载（扩展无法追踪该路径），请检查浏览器下载目录确认文件',
          }).catch(() => {});
        }, 60000);
      }
    });
  }

  // 统一错误上报：清理运行态 + AbortError 按取消来源映射文案 + 永久/普通错误
  function reportDownloadError(downloadId, err, taskLabel, { done, total, resumeFrom, abortNote }) {
    const cancelReason = cancelReasons.get(downloadId);
    removeAbortController(downloadId);
    runningDownloads.delete(downloadId);
    stopHeartbeat(downloadId);
    hideHiddenBanner();
    if (err.name === 'AbortError') {
      let errText = '已取消';
      switch (cancelReason) {
        case 'manual_pause': errText = '已暂停'; break;
        case 'manual_cancel': errText = '已取消'; break;
        case 'stalled': errText = '已暂停(无进度)'; break;
        case 'heartbeat': errText = '已暂停(页面无响应)'; break;
        case 'navigation': errText = '已暂停(页面刷新)'; break;
      }
      log('info', `[${taskLabel}] ${errText}${abortNote || '，分片已保留可续传'}`);
      // ★ reason 结构化枚举：background 状态机判断只用 reason（不再解析中文文案），
      //   error 文案只给人看，切断"文案=协议"耦合（review P0-1）
      chrome.runtime.sendMessage({ type: 'DOWNLOAD_ERROR', downloadId, error: errText, reason: cancelReason, done, total });
    } else {
      log('error', `[${taskLabel}] 下载失败: ${err.message}`);
      chrome.runtime.sendMessage({
        type: 'DOWNLOAD_ERROR', downloadId, error: err.message,
        done: done || resumeFrom, total,
        permanent: PERMANENT_PATTERN.test(err.message || ''),
      });
    }
  }

  VGP.startDownload = startDownload;
  VGP.getAbortController = getAbortController;
  VGP.cancelReasons = cancelReasons;
  VGP.reportProgress = reportProgress;
})(window.VGP);
