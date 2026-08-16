// formats.js — 视频格式识别（阶段2：支持 HLS/DASH/MP4/FLV 嗅探）
// background 侧 ES module 使用；content 侧只需收 URL，格式由 background 判断。

// 根据 URL 后缀 + Content-Type 判断视频流格式
export function detectFormat(url = '', contentType = '') {
  const u = String(url).split('?')[0].split('#')[0].toLowerCase();
  const ct = String(contentType || '').toLowerCase();
  if (u.endsWith('.m3u8') || ct.includes('mpegurl')) return 'hls';
  if (u.endsWith('.mpd') || ct.includes('dash+xml')) return 'dash';
  if (u.endsWith('.mp4') || ct.includes('video/mp4')) return 'mp4';
  if (u.endsWith('.flv') || ct.includes('x-flv')) return 'flv';
  return 'unknown';
}

// 格式显示标签
export const FORMAT_LABEL = { hls: 'HLS', dash: 'DASH', mp4: 'MP4', flv: 'FLV', unknown: '?' };

// 该格式是否可入队下载（阶段3 之前 hls 可下载；mp4/dash/flv 先嗅探展示，下载阶段3 接入）
export function isDownloadableFormat(fmt) {
  return fmt === 'hls' || fmt === 'mp4'; // mp4 直链阶段3 直接支持；dash/flv 阶段3 后续
}
