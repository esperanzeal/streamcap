// content sniffer.js — 页面级 video 标签嗅探
'use strict';
window.VGP = window.VGP || {};
(function (VGP) {
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
  VGP.extractVideoSources = extractVideoSources;
})(window.VGP);
