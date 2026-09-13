// content merge.js — 合并导出浮层按钮（OPFS 按 origin 隔离，必须在视频网站页面合并）
'use strict';
window.VGP = window.VGP || {};
(function (VGP) {
  // ★ 重复注入守卫：与 downloader.js 同一原因（见那里的详细说明）。没有它，
  //    chrome.storage.onChanged 会被注册两次，切换设置时按钮刷新两次（无功能危害，
  //    但会掩盖"content 被重复注入"这一事实 —— 那是重复落盘的根因）。
  if (VGP.__mergeLoaded) {
    try { console.warn('[VGP] merge 被重复注入，本次实例直接退出'); } catch { /* ignore */ }
    return;
  }
  VGP.__mergeLoaded = true;
  const { log, OPFS_PREFIX } = VGP;

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

  // 该站 OPFS 是否存在本扩展的分片（vgp_meta_*）：没有分片时不显示按钮，
  // 避免在所有无关网站右下角常驻悬浮按钮（骚扰 + 误点）
  async function hasLocalShards() {
    try {
      const root = await navigator.storage.getDirectory();
      for await (const [name] of root) {
        if (name.startsWith(OPFS_PREFIX + 'meta_')) return true;
      }
    } catch { /* OPFS 不可用 */ }
    return false;
  }

  async function refreshMergeButton() {
    const s = await chrome.storage.local.get('vgp_settings');
    const enabled = (s.vgp_settings || {}).mergeButton !== false;
    const show = enabled && await hasLocalShards();
    ensureMergeButton(show);
    // 有分片才开轮询（跟踪新增/清空），分片清空后停掉——避免定时器长期空转
    if (show) startPolling();
    else stopPolling();
    return show;
  }
  VGP.refreshMergeButton = refreshMergeButton; // meta 落盘后由 downloader 触发即时显示

  // 开关变化 → 重算显示
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.vgp_settings) refreshMergeButton();
  });

  // 条件轮询：仅在本页确有分片（= 这个站正在用本扩展下载）期间运行
  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { if (!document.hidden) refreshMergeButton(); }, 20000);
  }
  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && pollTimer) refreshMergeButton(); });

  async function initMergeButton() {
    await refreshMergeButton();
  }

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
    const unitSize = meta.batchSize || 40;
    const totalBatches = Math.ceil(meta.totalSegments / unitSize);
    // 分片命名按格式：HLS 批 `batch_*.blob`、MP4 块 `block_*.bin`、DASH 段 `seg_*.bin`。
    // 新 meta 带 kind 字段；旧 meta 无 kind → 探测实际存在的命名（按 unit 0 试读）。
    const nameFor = (k, i) => OPFS_PREFIX + (k === 'batch' ? `dl_${d.id}_batch_${i}.blob`
      : k === 'block' ? `dl_${d.id}_block_${i}.bin`
      : `dl_${d.id}_seg_${i}.bin`);
    let kind = meta.kind;
    if (kind !== 'batch' && kind !== 'block' && kind !== 'seg') {
      kind = 'batch';
      for (const k of ['block', 'seg']) {
        try { await root.getFileHandle(nameFor(k, 0)); kind = k; break; } catch { /* 试下一个 */ }
      }
    }

    // fMP4 的 init 段（EXT-X-MAP）：下载时已落盘为 dl_{id}_map.bin。
    // 手动合并必须把它拼在**所有分片之前**，否则产物无法播放（自动导出路径同样前置）。
    let mapFile = null;
    try { mapFile = await (await root.getFileHandle(OPFS_PREFIX + `dl_${d.id}_map.bin`)).getFile(); } catch {}

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
          const f = await (await root.getFileHandle(nameFor(kind, i))).getFile();
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
    if (mapFile) totalBytes += mapFile.size; // fMP4 init 段也计入总量（进度/校验）

    const writable = await handle.createWritable();
    let wrote = 0;
    let currentBatch = 0;
    const t0 = Date.now();
    const fmt = b => (b / 1024 / 1024 / 1024).toFixed(1) + 'GB';
    try {
      // fMP4：init 段必须写在所有分片之前（否则产物无法播放）
      if (mapFile) {
        await writable.write(await mapFile.arrayBuffer());
        wrote += mapFile.size;
      }
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

  VGP.mergeFromOpfs = mergeFromOpfs;
})(window.VGP);
