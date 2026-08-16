// content hls.js — m3u8 解析 + AES-128 解密（含 key rotation）+ 重试 fetch
'use strict';
window.VGP = window.VGP || {};
(function (VGP) {
  // 重试 fetch（含 20s 超时，防 TCP 挂起卡死批次）
  async function fetchWithRetry(url, retries = 3, signal = null, extraHeaders = {}) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      const timeoutSignal = AbortSignal.timeout(20000); // 20s 无响应 → 超时按失败重试
      const sig = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      try {
        // referrer: 完整页面 URL + unsafe-url 策略——部分 CDN（如 部分 CDN）校验
        // 完整 Referer 而非 origin；credentials: 'include' 带跨域 CDN cookie
        // （video 元素播放自动带 cookie，fetch 默认不带 → 403；webRequest 已注入
        // 具体 origin 的 ACAO + Allow-Credentials 配合）
        const resp = await fetch(url, {
          signal: sig,
          headers: extraHeaders,
          referrer: location.href,
          referrerPolicy: 'unsafe-url',
          credentials: 'include',
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp;
      } catch (err) {
        if (err.name === 'AbortError' && signal?.aborted) throw err; // 用户取消，直接抛
        if (err.name === 'AbortError') {
          // 超时（signal 未取消）：包装成普通错误按失败重试，不能被误判为用户取消
          err = new Error('下载超时（20s 无响应）');
        }
        if (attempt === retries) {
          // ★ 记录最终失败原因（之前只打"重试 X/Y"，看不出为何失败——403/CORS/超时）
          VGP.log('error', `尝试 ${attempt}/${retries} 失败（放弃）: ${err.message}`);
          throw err;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
        VGP.log('warn', `尝试 ${attempt}/${retries} 失败: ${err.message}，等待 ${delay}ms 重试`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

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

  // 解析 m3u8 中的所有 KEY 标签，返回 key 段列表（支持 key rotation）
  // 每个 key 段包含 { segStartIndex, keyUrl, ivHex }，控制从 segStartIndex 开始的所有分片
  // 直到下一个 key 段或 playlist 末尾。
  function parseKeySegments(text, baseUrl) {
    const lines = text.split('\n').map(l => l.trim());
    const keySegments = [];
    let segIndex = 0;
    let currentKeyInfo = null;
    let mediaSeq = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (line.startsWith('#EXT-X-KEY')) {
        const m = line.match(/METHOD=AES-128,URI="([^"]+)"(?:,IV=(0x[0-9a-fA-F]+))?/);
        if (m) {
          const keyUrl = resolveUrl(m[1], baseUrl);
          const ivHex = m[2] || null;
          if (!currentKeyInfo || currentKeyInfo.keyUrl !== keyUrl || currentKeyInfo.ivHex !== ivHex) {
            currentKeyInfo = { segStartIndex: segIndex, keyUrl, ivHex };
            keySegments.push(currentKeyInfo);
          }
        }
        continue;
      }

      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) {
        const m = line.match(/:(\d+)/);
        if (m) mediaSeq = parseInt(m[1]);
        continue;
      }

      // 跳过注释/标签行
      if (line.startsWith('#') || !line) continue;

      // 分片 URI 行
      segIndex++;
    }

    return { keySegments, mediaSeq };
  }

  // 为给定分片索引查找对应的 key 段（二分查找）
  function findKeyForSegment(keySegments, segIndex) {
    if (!keySegments || keySegments.length === 0) return null;
    let lo = 0, hi = keySegments.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (keySegments[mid].segStartIndex <= segIndex) lo = mid;
      else hi = mid - 1;
    }
    return keySegments[lo].segStartIndex <= segIndex ? keySegments[lo] : null;
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

  VGP.fetchWithRetry = fetchWithRetry;
  VGP.resolveUrl = resolveUrl;
  VGP.parseM3u8 = parseM3u8;
  VGP.selectBestVariant = selectBestVariant;
  VGP.parseKeySegments = parseKeySegments;
  VGP.findKeyForSegment = findKeyForSegment;
  VGP.fetchDecryptKey = fetchDecryptKey;
  VGP.decryptSegment = decryptSegment;
  VGP.makeIV = makeIV;
})(window.VGP);
