// manager.js — StreamCap 下载管理器
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let downloads = {};
let filter = 'all';

const ICONS = { queued: '⏳', downloading: '⬇️', retrying: '🔁', completed: '✅', failed: '❌', cancelled: '🚫', paused: '⏸️' };
const BADGES = {
  queued: ['队列中', 'b-queued'], downloading: ['下载中', 'b-active'], retrying: ['重试中', 'b-active'],
  completed: ['已完成', 'b-done'], failed: ['失败', 'b-fail'], cancelled: ['已取消', 'b-cxl'],
  paused: ['已暂停', 'b-queued'],
};
const BARS = { queued: 'bar-q', downloading: 'bar-go', retrying: 'bar-go', completed: 'bar-ok', failed: 'bar-err', cancelled: 'bar-cxl', paused: 'bar-q' };

// ============ 操作 ============
function act(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

function render() {
  const all = Object.values(downloads).sort((a, b) => b.createdAt - a.createdAt);
  const cnt = {};
  all.forEach(d => { cnt[d.status] = (cnt[d.status] || 0) + 1; });

  $('#stats').textContent = [
    cnt.downloading ? `⬇️${cnt.downloading}` : '',
    cnt.queued ? `⏳${cnt.queued}` : '',
    cnt.completed ? `✅${cnt.completed}` : '',
    cnt.failed ? `❌${cnt.failed}` : '',
  ].filter(Boolean).join('  ');

  const filtered = all.filter(d => {
    if (filter === 'all') return true;
    if (filter === 'active') return d.status === 'downloading' || d.status === 'queued';
    return d.status === filter;
  });

  if (filtered.length === 0) {
    $('#list').innerHTML = '<div class="empty-state"><span>📭</span>暂无下载任务</div>';
    return;
  }

  $('#list').innerHTML = filtered.map(d => {
    const icon = ICONS[d.status] || '❓';
    const [badgeText, badgeCls] = BADGES[d.status] || ['?', 'b-queued'];
    const barCls = BARS[d.status] || 'bar-q';
    const isActive = d.status === 'downloading' || d.status === 'queued' || d.status === 'retrying';
    const isPaused = d.status === 'paused';
    const isDone = d.status === 'completed';
    const isDead = d.status === 'failed' || d.status === 'cancelled';
    const isRetryable = isDead || isPaused;
    const barW = d.pct || 0;
    const doneText = d.total ? `${d.done}/${d.total}` : '—';

    const fname = d.pageTitle ? `${d.pageTitle}.mp4` : (d.fileName || '');
    return `
    <div class="card">
      <div class="card-icon">${icon}</div>
      <div class="card-body">
        ${fname ? `<div style="font-weight:600;color:#58a6ff;margin-bottom:2px;">📄 ${esc(fname)}</div>` : ''}
        <div class="card-title">
          ${d.resolution || '?'} · ${new Date(d.createdAt).toLocaleTimeString()}
          <span class="badge ${badgeCls}">${badgeText}</span>
        </div>
        <div class="card-url" title="${esc(d.url)}">${esc(d.url)}</div>
        <div class="bar-wrap"><div class="bar-fill ${barCls}" style="width:${barW}%"></div></div>
        <div class="card-info">
          <span>${doneText} 分片 · ${d.speed || ''}</span>
          <span>${(d.pct || 0).toFixed(1)}%</span>
        </div>
        ${d.error ? `<div class="card-err">${esc(d.error)}</div>` : ''}
        ${d.fileName ? `<div style="font-size:11px;color:#3fb950;margin-top:4px;">📁 ${esc(d.fileName)}</div>` : ''}
      </div>
      <div class="card-actions">
        ${isActive ? `<button class="btn-act" data-act="pause" data-id="${d.id}">暂停</button>` : ''}
        ${isPaused ? `<button class="btn-act retry" data-act="resume" data-id="${d.id}">继续</button>` : ''}
        ${isDead ? `<button class="btn-act retry" data-act="retry" data-id="${d.id}">重试·续传</button>` : ''}
        ${!isActive ? `<button class="btn-act danger" data-act="delete" data-id="${d.id}">删除</button>` : ''}
      </div>
    </div>`;
  }).join('');

  // 事件绑定
  $('#list').querySelectorAll('[data-act]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const d = downloads[id];
      if (btn.dataset.act === 'pause') act({ type: 'PAUSE', downloadId: id });
      if (btn.dataset.act === 'delete') act({ type: 'DELETE_DOWNLOAD', downloadId: id });
      if (btn.dataset.act === 'resume' || btn.dataset.act === 'retry') {
        if (d) act({ type: 'ENQUEUE', tabId: d.tabId, url: d.url, referer: d.referer, resolution: d.resolution, pageUrl: d.pageUrl, pageTitle: d.pageTitle, retryId: d.id });
      }
    });
  });
}

// ============ 过滤标签 ============
$$('.tab-btn').forEach(b => {
  b.addEventListener('click', () => {
    $$('.tab-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    filter = b.dataset.filter;
    render();
  });
});

// ============ 清空按钮 ============
$('#btnClearDone').addEventListener('click', () => {
  Object.values(downloads).forEach(d => { if (d.status === 'completed') act({ type: 'DELETE_DOWNLOAD', downloadId: d.id }); });
});
// 线程数设置 + 并发任务数设置
const threadsSelect = $('#threads');
const maxConcSelect = $('#maxConcurrent');
chrome.storage.local.get('vgp_settings', s => {
  const settings = s.vgp_settings || {};
  threadsSelect.value = settings.concurrency || 4;
  // 注意：0 = 无上限，必须用 undefined 判断
  maxConcSelect.value = (settings.maxConcurrent === undefined || settings.maxConcurrent === null) ? 3 : settings.maxConcurrent;
});
function saveSettings(patch) {
  chrome.storage.local.get('vgp_settings', s => {
    const merged = { ...(s.vgp_settings || {}), ...patch };
    chrome.storage.local.set({ vgp_settings: merged });
  });
}
threadsSelect.addEventListener('change', () => {
  saveSettings({ concurrency: parseInt(threadsSelect.value) });
});
maxConcSelect.addEventListener('change', () => {
  saveSettings({ maxConcurrent: parseInt(maxConcSelect.value) });
  // 通知后台立即重新调度（改大→派发排队任务，改小→停止新派发）
  act({ type: 'SET_MAX_CONCURRENT' });
});

$('#btnClearFail').addEventListener('click', () => {
  Object.values(downloads).forEach(d => { if (d.status === 'failed' || d.status === 'cancelled') act({ type: 'DELETE_DOWNLOAD', downloadId: d.id }); });
});

// ============ 实时更新 ============
// 用长连接 + storage 双通道
const port = chrome.runtime.connect({ name: 'manager' });
port.onMessage.addListener(msg => {
  if (msg.type === 'INIT') {
    msg.downloads.forEach(d => downloads[d.id] = d);
    render();
  }
  if (msg.type === 'DOWNLOAD_UPDATE' && msg.download) {
    downloads[msg.download.id] = msg.download;
    render();
  }
  if (msg.type === 'DOWNLOAD_REMOVED') {
    delete downloads[msg.downloadId];
    render();
  }
});
port.onDisconnect.addListener(() => { /* reconnect handled by storage listener */ });

// 初始加载 + storage 兜底
chrome.runtime.sendMessage({ type: 'GET_DOWNLOADS' }, list => {
  (list || []).forEach(d => downloads[d.id] = d);
  render();
});
chrome.storage.onChanged.addListener(changes => {
  if (changes.vgp_downloads) {
    downloads = {};
    (changes.vgp_downloads.newValue || []).forEach(d => downloads[d.id] = d);
    render();
  }
});

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
