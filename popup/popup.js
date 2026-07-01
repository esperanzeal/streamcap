// popup.js — StreamCap
const $ = s => document.querySelector(s);

let currentPageUrl = '';
let currentPageTitle = '';

function pageFileName() {
  try {
    const parts = new URL(currentPageUrl).pathname.split('/');
    return parts.filter(Boolean).pop() || 'video';
  } catch { return 'video'; }
}

function renderList(data) {
  const list = $('#list');
  const pageInfo = $('#pageInfo');
  const pageTitleLabel = $('#pageTitleLabel');

  // sniffStore 页面标题优先，否则用网址栏
  const fn = pageFileName();
  pageInfo.classList.remove('hidden');
  pageTitleLabel.textContent = '📄 ' + fn + '.mp4';

  if (!data.m3u8s || data.m3u8s.length === 0) {
    list.innerHTML = '<div class="empty">浏览视频页面后自动嗅探<br><span class="hint">无需手动刷新</span></div>';
    return;
  }
  list.innerHTML = data.m3u8s.map(e => `
    <div class="card">
      <div class="meta">
        <span class="res">${e.resolution}</span>
        <span style="font-size:10px;color:#666">${new Date(e.timestamp).toLocaleTimeString()}</span>
      </div>
      <div class="url-preview" title="${esc(e.url)}">${esc(e.url)}</div>
      <div class="btn-row">
        <button class="btn-queue" data-url="${esc(e.url)}" data-ref="${esc(e.referer||'')}" data-res="${e.resolution}">⬇️ 加入下载</button>
      </div>
    </div>`).join('');

  list.querySelectorAll('.btn-queue').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'ENQUEUE',
        url: btn.dataset.url,
        referer: btn.dataset.ref,
        resolution: btn.dataset.res,
        pageUrl: currentPageUrl,
        pageTitle: pageFileName(),
      }, resp => {
        if (resp?.ok) {
          btn.textContent = '✅ 已加入';
          btn.disabled = true;
        }
      });
    });
  });
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// 初始化：从标签页取 URL 和标题
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  currentPageUrl = tabs[0]?.url || '';
  currentPageTitle = tabs[0]?.title || '';
  chrome.runtime.sendMessage({ type: 'GET_M3U8S' }, data => {
    renderList(data || { m3u8s: [], pageUrl: '' });
  });
});

// 按钮
$('#btnRefresh').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    currentPageUrl = tabs[0]?.url || '';
    currentPageTitle = tabs[0]?.title || '';
    chrome.runtime.sendMessage({ type: 'GET_M3U8S' }, data => renderList(data || {}));
    if (tabs[0]?.id) chrome.tabs.sendMessage(tabs[0].id, { type: 'SCAN_VIDEOS' }, () => {});
  });
});
$('#btnClear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_SNIFF' }, () => renderList({ m3u8s: [], pageUrl: '' }));
});
$('#btnMgr').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_MANAGER' });
});
$('#btnLog').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('logger/logger.html') });
});
