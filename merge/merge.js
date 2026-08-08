// 分片合并导出工具：从 OPFS 流式合并分片到用户选择的磁盘文件
// 不生成整块 blob（不占内存）、不经过 chrome.downloads（绕开大文件导出中断问题）
const $ = s => document.querySelector(s);

let downloads = [];

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function taskName(d) {
  try {
    const base = d.url.split('/').pop().split('?')[0];
    if (base) return decodeURIComponent(base);
  } catch {}
  return 'task-' + d.id;
}

function setStatus(html, cls = '') {
  $('#status').innerHTML = `<span class="${cls}">${html}</span>`;
}

async function opfsRoot() {
  return navigator.storage.getDirectory();
}

// 找出 OPFS 里存在分片缓存的任务（按 meta 文件识别）
async function loadTasks() {
  const root = await opfsRoot();
  const withMeta = new Set();
  for await (const [name] of root) {
    const m = name.match(/^vgp_meta_(\d+)\.json$/);
    if (m) withMeta.add(Number(m[1]));
  }
  const list = await new Promise(res => chrome.runtime.sendMessage({ type: 'GET_DOWNLOADS' }, r => res(r || [])));
  downloads = list.filter(d => withMeta.has(d.id));
  render();
}

function render() {
  const box = $('#tasks');
  if (!downloads.length) {
    box.innerHTML = '<p class="empty">这里无法直接读取网站页面的分片缓存（浏览器按网站隔离存储）。<br>👉 请打开下载该视频的网站（如 missav.ws），页面右下角点 <b>🗜️ 合并导出</b> 按钮操作。</p>';
    return;
  }
  box.innerHTML = downloads.map(d => `
    <div class="task" data-id="${d.id}">
      <span class="name">${esc(taskName(d))}</span>
      <span class="status">${esc(d.status)}</span>
      <button class="btn" data-act="merge">📦 选择保存位置并合并</button>
    </div>`).join('');
  box.querySelectorAll('button[data-act=merge]').forEach(b =>
    b.addEventListener('click', () => merge(Number(b.closest('.task').dataset.id), b)));
}

async function merge(id, btn) {
  const d = downloads.find(x => x.id === id);
  if (!d) return;
  btn.disabled = true;
  try {
    const root = await opfsRoot();

    // 1. 读元数据：分片总数 / 每批段数
    let meta;
    try {
      const mf = await root.getFileHandle(`vgp_meta_${id}.json`);
      meta = JSON.parse(await (await mf.getFile()).text());
    } catch {
      setStatus('读取分片元数据失败：分片可能已丢失或被清理', 'err');
      return;
    }
    const totalBatches = Math.ceil(meta.totalSegments / (meta.batchSize || 80));

    // 2. 用户手势：选择保存位置（showSaveFilePicker 必须在点击事件里调用）
    let handle;
    try {
      handle = await showSaveFilePicker({
        suggestedName: taskName(d),
        types: [{ description: '视频文件', accept: { 'video/mp4': ['.mp4'], 'video/x-matroska': ['.mkv'] } }],
      });
    } catch (e) {
      if (e.name === 'AbortError') return; // 用户取消
      setStatus('选择保存位置失败: ' + e.message, 'err');
      return;
    }

    // 3. 先扫一遍所有批次文件，拿到总字节数和缺失情况
    setStatus('正在扫描分片…');
    const sizes = new Array(totalBatches);
    let totalBytes = 0;
    for (let i = 0; i < totalBatches; i++) {
      try {
        const f = await (await root.getFileHandle(`vgp_dl_${id}_batch_${i}.blob`)).getFile();
        sizes[i] = f.size;
        totalBytes += f.size;
      } catch {
        sizes[i] = -1;
      }
    }
    const missing = sizes.map((s, i) => s < 0 ? i : -1).filter(i => i >= 0);
    if (missing.length) {
      setStatus(`⚠️ 缺少 ${missing.length} 个批次（${missing.slice(0, 10).map(i => i + 1).join(', ')}${missing.length > 10 ? '…' : ''}）。可先在下载管理里对该任务点"继续/重试"补齐分片后再来合并。`);
      return;
    }

    // 4. 流式合并：逐批读 OPFS → 写入磁盘文件
    setStatus(`开始合并：${(totalBytes / 1024 / 1024 / 1024).toFixed(1)}GB，共 ${totalBatches} 批…`);
    const writable = await handle.createWritable();
    let wrote = 0;
    const t0 = Date.now();
    const barWrap = document.createElement('div');
    barWrap.className = 'bar-wrap';
    const bar = document.createElement('div');
    bar.className = 'bar';
    barWrap.appendChild(bar);
    $('#status').appendChild(barWrap);

    const updateProgress = () => {
      const pct = totalBytes ? Math.min(100, wrote / totalBytes * 100) : 0;
      bar.style.width = pct + '%';
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      const gb = (wrote / 1024 / 1024 / 1024).toFixed(1);
      const speed = wrote && secs > 0 ? (wrote / 1024 / 1024 / secs).toFixed(0) : 0;
      $('#status').firstChild.textContent = `合并中 ${gb}GB / ${(totalBytes / 1024 / 1024 / 1024).toFixed(1)}GB（${pct.toFixed(0)}%） ${speed}MB/s`;
    };

    try {
      for (let i = 0; i < totalBatches; i++) {
        const buf = await (await (await root.getFileHandle(`vgp_dl_${id}_batch_${i}.blob`)).getFile()).arrayBuffer();
        await writable.write(buf);
        wrote += buf.byteLength;
        updateProgress();
      }
      await writable.close();
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      setStatus(`✅ 合并完成：${(wrote / 1024 / 1024 / 1024).toFixed(1)}GB，用时 ${secs} 秒（${(wrote / 1024 / 1024 / Math.max(1, secs)).toFixed(0)}MB/s）。文件已保存。分片仍保留在 OPFS，确认无误后可在下载管理删除该任务以清理缓存。`, 'ok');
    } catch (e) {
      setStatus('合并失败：' + e.message + '（已写入部分不会保留，可重新选择位置再来一次）', 'err');
      try { await writable.abort(); } catch {}
    }
  } finally {
    btn.disabled = false;
  }
}

loadTasks();
