// content opfs.js — OPFS 工具 + 断点续传元数据 + 孤儿清理
'use strict';
window.VGP = window.VGP || {};
(function (VGP) {
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

  // 取 OPFS 文件的 File 对象（磁盘支撑，不进 JS 堆）：
  // 大文件合并导出用它组装 Blob，避免把全部数据读回内存（P0-5）
  async function opfsGetFile(name) {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(OPFS_PREFIX + name, { create: false });
      return await fh.getFile();
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

  // 断点续传元数据
  // ★ meta 只是"进度快照"，不是关键数据 —— 它损坏时必须降级为"没有进度"，绝不能让整个任务失败。
  //   真机现象：`下载失败: Unexpected end of JSON input` —— 旧的 loadMeta 直接 JSON.parse，
  //   遇到空/截断内容就抛错，冒泡到 startDownload 的 catch → 任务被标失败。
  //   损坏来源：写入过程中页面被 reload / 进程被杀，或（修复前）同一页面两个 content 实例
  //   同时写同一个 meta 文件相互交错。修好重复注入后概率大降，但读取端必须容错。
  //   返回 null 是安全的：三个调用点都是 `if (!meta || meta.totalSegments !== total) { 新建 }`，
  //   而且分片文件还在，重新下载时会重新识别并跳过已落盘的部分。
  async function saveMeta(downloadId, meta) {
    await opfsWrite(`meta_${downloadId}.json`, JSON.stringify(meta));
  }
  async function loadMeta(downloadId) {
    const buf = await opfsRead(`meta_${downloadId}.json`);
    if (!buf || !buf.byteLength) return null;
    try {
      return JSON.parse(new TextDecoder().decode(buf));
    } catch (e) {
      // 损坏：丢掉它，按"无进度"继续（不要把任务搞失败）
      try { await opfsDelete(`meta_${downloadId}.json`); } catch { /* ignore */ }
      try { VGP.log('warn', `[#${downloadId}] 断点续传元数据损坏（${(e && e.message) || e}），已丢弃并按无进度继续`); } catch { /* ignore */ }
      return null;
    }
  }
  async function deleteMeta(downloadId) {
    await opfsDelete(`meta_${downloadId}.json`);
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

  VGP.OPFS_PREFIX = OPFS_PREFIX;
  VGP.opfsWrite = opfsWrite;
  VGP.opfsRead = opfsRead;
  VGP.opfsGetFile = opfsGetFile;
  VGP.opfsDelete = opfsDelete;
  VGP.opfsList = opfsList;
  VGP.saveMeta = saveMeta;
  VGP.loadMeta = loadMeta;
  VGP.deleteMeta = deleteMeta;
  VGP.cleanupOpfs = cleanupOpfs;
})(window.VGP);
