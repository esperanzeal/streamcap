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
  VGP.opfsDelete = opfsDelete;
  VGP.opfsList = opfsList;
  VGP.saveMeta = saveMeta;
  VGP.loadMeta = loadMeta;
  VGP.deleteMeta = deleteMeta;
  VGP.cleanupOpfs = cleanupOpfs;
})(window.VGP);
