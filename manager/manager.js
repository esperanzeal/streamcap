// manager.js — StreamCap 下载管理器
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let downloads = {};
let filter = 'all';

const ICONS = { queued: '⏳', downloading: '⬇️', retrying: '🔁', exporting: '📤', completed: '✅', failed: '❌', cancelled: '🚫', paused: '⏸️' };
const BADGES = {
  queued: ['队列中', 'b-queued'], downloading: ['下载中', 'b-active'], retrying: ['重试中', 'b-active'],
  exporting: ['导出中', 'b-active'], completed: ['已完成', 'b-done'], failed: ['失败', 'b-fail'], cancelled: ['已取消', 'b-cxl'],
  paused: ['已暂停', 'b-queued'],
};
const BARS = { queued: 'bar-q', downloading: 'bar-go', retrying: 'bar-go', exporting: 'bar-go', completed: 'bar-ok', failed: 'bar-err', cancelled: 'bar-cxl', paused: 'bar-q' };

// ============ 操作 ============
function act(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

function render() {
  const all = Object.values(downloads).sort((a, b) => b.createdAt - a.createdAt);
  const cnt = {};
  all.forEach(d => { cnt[d.status] = (cnt[d.status] || 0) + 1; });

  $('#stats').textContent = [
    cnt.downloading ? `⬇️${cnt.downloading}` : '',
    cnt.exporting ? `📤${cnt.exporting}` : '',
    cnt.queued ? `⏳${cnt.queued}` : '',
    cnt.completed ? `✅${cnt.completed}` : '',
    cnt.failed ? `❌${cnt.failed}` : '',
  ].filter(Boolean).join('  ');

  const filtered = all.filter(d => {
    if (filter === 'all') return true;
    if (filter === 'active') return d.status === 'downloading' || d.status === 'queued' || d.status === 'exporting';
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
    const isExporting = d.status === 'exporting';
    const isDead = d.status === 'failed' || d.status === 'cancelled';
    const isRetryable = isDead || isPaused || isDone;
    const barW = d.pct || 0;
    const doneText = d.total ? `${d.done}/${d.total}` : '—';
    // 速度/临时文案只在下载中、重试中显示（已完成/失败等不显示，避免残留"合并中"等）
    const speedText = (d.status === 'downloading' || d.status === 'retrying') ? (d.speed || '') : '';
    // 导出中提示：与"下载中"视觉区分，提醒别关页面
    const exportingHint = isExporting
      ? '<div style="font-size:11px;color:#d29922;margin-top:4px;">📤 文件保存中，请勿关闭此页面</div>'
      : '';

    const fname = d.pageTitle ? `${d.pageTitle}.mp4` : (d.fileName || '');
    const dupTag = d.dupIndex ? ` <span style="color:#d29922;font-weight:600;">(${d.dupIndex})</span>` : '';
    return `
    <div class="card">
      <div class="card-icon">${icon}</div>
      <div class="card-body">
        ${fname ? `<div style="font-weight:600;color:#58a6ff;margin-bottom:2px;">📄 ${esc(fname)}${dupTag}</div>` : ''}
        <div class="card-title">
          ${d.resolution || '?'} · ${new Date(d.createdAt).toLocaleTimeString()}
          <span class="badge ${badgeCls}">${badgeText}</span>
        </div>
        <div class="card-url" title="${esc(d.url)}">${esc(d.url)}</div>
        <div class="bar-wrap"><div class="bar-fill ${barCls}" style="width:${barW}%"></div></div>
        <div class="card-info">
          <span>${doneText} 分片${speedText ? ` · ${esc(speedText)}` : ''}</span>
          <span>${(d.pct || 0).toFixed(1)}%</span>
        </div>
        ${d.error ? `<div class="card-err">${esc(d.error)}</div>` : ''}
        ${d.fileName ? `<div style="font-size:11px;color:#3fb950;margin-top:4px;">📁 ${esc(d.fileName)}</div>` : ''}
        ${exportingHint}
      </div>
      <div class="card-actions">
        ${isActive ? `<button class="btn-act" data-act="pause" data-id="${d.id}">暂停</button>` : ''}
        ${isRetryable ? `<button class="btn-act retry" data-act="retry" data-id="${d.id}">${isPaused ? '继续' : '重试'}</button>` : ''}
        ${!isActive && !isExporting ? `<button class="btn-act danger" data-act="delete" data-id="${d.id}">删除</button>` : ''}
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
        if (!d) return;
        // 已完成任务的重试 = 进度归零从头重新下载（分片已清理），需确认防误触
        if (d.status === 'completed') {
          if (!confirm(`该任务已完成，重新下载将清空进度从头开始（约 ${(d.total || 0)} 个分片），确定？`)) return;
        }
        act({ type: 'ENQUEUE', tabId: d.tabId, url: d.url, referer: d.referer, resolution: d.resolution, pageUrl: d.pageUrl, pageTitle: d.pageTitle, retryId: d.id });
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
  maxConcSelect.value = (settings.maxConcurrent === undefined || settings.maxConcurrent === null) ? 4 : settings.maxConcurrent;
  // 页面合并按钮开关：默认开（undefined 视为 true）
  $('#mergeBtnToggle').checked = settings.mergeButton !== false;
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
  // 消息携带新值，避免后台读取 storage 时的时序竞态
  act({ type: 'SET_MAX_CONCURRENT', value: parseInt(maxConcSelect.value) });
});
// 页面合并按钮开关：只写 settings，content script 监听 storage 变化实时显示/隐藏
$('#mergeBtnToggle').addEventListener('change', () => {
  saveSettings({ mergeButton: $('#mergeBtnToggle').checked });
});

// 打开日志页
$('#btnLog').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('logger/logger.html') });
});
// 全部暂停：发后台统一处理
$('#btnPauseAll').addEventListener('click', () => {
  act({ type: 'PAUSE_ALL' });
});
// 全部继续：恢复所有暂停任务（由并发限制决定启动数量）
$('#btnResumeAll').addEventListener('click', () => {
  act({ type: 'RESUME_ALL' });
});
// 全部重试：重试所有失败/取消任务
$('#btnRetryAll').addEventListener('click', () => {
  Object.values(downloads).forEach(d => {
    if (d.status === 'failed' || d.status === 'cancelled') {
      act({ type: 'ENQUEUE', tabId: d.tabId, url: d.url, referer: d.referer, resolution: d.resolution, pageUrl: d.pageUrl, pageTitle: d.pageTitle, retryId: d.id });
    }
  });
});

$('#btnClearFail').addEventListener('click', () => {
  Object.values(downloads).forEach(d => { if (d.status === 'failed' || d.status === 'cancelled') act({ type: 'DELETE_DOWNLOAD', downloadId: d.id }); });
});

// ============ 实时更新 ============
// 长连接（实时广播）+ storage 兜底双通道。
// MV3 的 service worker 空闲约 30s 就重启，SW 重启会断开扩展页的长连接 →
// 若不做自动重连，页面会收不到任何更新（进度条/网速静止，只有 F5 能恢复）。
// 断线后延迟重连 + 主动拉一次全量，保证断线期间的状态不丢。
function connectManager() {
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
  port.onDisconnect.addListener(() => {
    // SW 重启导致断开 → 延迟重连，并拉一次全量状态兜底
    setTimeout(() => {
      connectManager();
      chrome.runtime.sendMessage({ type: 'GET_DOWNLOADS' }, list => {
        (list || []).forEach(d => downloads[d.id] = d);
        render();
      });
    }, 500);
  });
}
connectManager();

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
