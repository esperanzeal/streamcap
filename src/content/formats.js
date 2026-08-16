// content formats.js — 视频格式识别（与 background formats.js 逻辑一致）
// content script 不支持 ES module，用 window.VGP 暴露；background 侧 import 同名模块。
'use strict';
window.VGP = window.VGP || {};
(function (VGP) {
  function detectFormat(url = '', contentType = '') {
    const u = String(url).split('?')[0].split('#')[0].toLowerCase();
    const ct = String(contentType || '').toLowerCase();
    if (u.endsWith('.m3u8') || ct.includes('mpegurl')) return 'hls';
    if (u.endsWith('.mpd') || ct.includes('dash+xml')) return 'dash';
    if (u.endsWith('.mp4') || ct.includes('video/mp4')) return 'mp4';
    if (u.endsWith('.flv') || ct.includes('x-flv')) return 'flv';
    return 'unknown';
  }
  VGP.detectFormat = detectFormat;
})(window.VGP);
