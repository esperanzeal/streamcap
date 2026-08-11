// popup.js — StreamCap
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

let currentPageUrl = '';
let resFilter = 'all';

function resolutionGroup(res) {
  if (!res || res === '?') return 'other';
  const m = res.match(/(\d{3,4})p/i);
  if (m) {
    const h = parseInt(m[1]);
    if (h >= 2160) return '4K';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
  }
  // 也匹配 WxH 格式
  const m2 = res.match(/(\d{3,4})x(\d{3,4})/i);
  if (m2) {
    const h = parseInt(m2[2]);
    if (h >= 2160) return '4K';
    if (h >= 1080) return '1080p';
    if (h >= 720) return '720p';
  }
  return 'other';
}

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
  const actualName = (data.pageTitle || fn) + '.mp4';
  pageInfo.classList.remove('hidden');
  pageTitleLabel.textContent = '📄 ' + actualName;
  if (data.pageTitle) {
    pageTitleLabel.innerHTML = '📄 ' + esc(actualName) + ' <span class="page-hint">（页面标题）</span>';
  } else {
    pageTitleLabel.innerHTML = '📄 ' + esc(actualName) + ' <span class="page-hint">文件名取自网址路径末段</span>';
  }

  const filtered = resFilter === 'all'
    ? data.m3u8s
    : data.m3u8s.filter(e => resolutionGroup(e.resolution) === resFilter);

  const filterBar = $('#filterBar');
  if (data.m3u8s && data.m3u8s.length > 0) {
    filterBar.classList.remove('hidden');
  } else {
    filterBar.classList.add('hidden');
  }

  if (!data.m3u8s || data.m3u8s.length === 0 || filtered.length === 0) {
    list.innerHTML = '<div class="empty">浏览视频页面后自动嗅探<br><span class="hint">无需手动刷新</span></div>';
    return;
  }
  list.innerHTML = filtered.map(e => `
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
      // 立即禁用防双击（两次 ENQUEUE 会产生重复任务；响应失败时恢复）
      btn.disabled = true;
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
        } else if (resp?.duplicate) {
          // 该 URL 已在任务列表：询问是否强制重复下载（默认拒绝，防误操作产生重复文件）
          const force = confirm(`该视频已在下载任务列表中（状态：${resp.existingStatus || '?'}）。\n\n确定要重复下载一份吗？`);
          if (force) {
            chrome.runtime.sendMessage({
              type: 'ENQUEUE',
              url: btn.dataset.url,
              referer: btn.dataset.ref,
              resolution: btn.dataset.res,
              pageUrl: currentPageUrl,
              pageTitle: pageFileName(),
              force: true,
            }, r2 => {
              if (r2?.ok) {
                btn.textContent = '✅ 已加入';
              } else {
                btn.disabled = false;
              }
            });
          } else {
            btn.disabled = false;
          }
        } else {
          // 其他错误（如无标签页）：恢复按钮
          btn.disabled = false;
        }
      });
    });
  });
}

function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// 初始化：从标签页取 URL 和标题
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  currentPageUrl = tabs[0]?.url || '';
  chrome.runtime.sendMessage({ type: 'GET_M3U8S' }, data => {
    renderList(data || { m3u8s: [], pageUrl: '' });
  });
});

// 按钮
$('#btnRefresh').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    currentPageUrl = tabs[0]?.url || '';
    const tid = tabs[0]?.id;
    const refresh = () => chrome.runtime.sendMessage({ type: 'GET_M3U8S' }, data => renderList(data || {}));
    if (tid) {
      // 走 background 的 SCAN_VIDEOS：结果写入 sniffStore 后再读取，刷新才真正生效
      chrome.runtime.sendMessage({ type: 'SCAN_VIDEOS', tabId: tid }, refresh);
    } else {
      refresh();
    }
  });
});
$('#btnClear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_SNIFF' }, () => renderList({ m3u8s: [], pageUrl: '' }));
});
$('#btnMgr').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_MANAGER' });
});

// 分辨率筛选按钮
$$('.filt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.filt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    resFilter = btn.dataset.res;
    chrome.runtime.sendMessage({ type: 'GET_M3U8S' }, data => renderList(data || {}));
  });
});
