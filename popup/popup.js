// popup.js — StreamCap
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

// 显示扩展版本号（从 manifest 读取）——确认加载的是新版本
(function showVersion() {
  try {
    const v = chrome.runtime.getManifest().version;
    const el = $('#ver');
    if (el && v) el.textContent = 'v' + v;
  } catch {}
})();

let currentPageUrl = '';
let currentTabId = 0; // 当前激活标签页 id（续传时指定宿主用）
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
    ? data.videos
    : data.videos.filter(e => resolutionGroup(e.resolution) === resFilter);

  const filterBar = $('#filterBar');
  if (data.videos && data.videos.length > 0) {
    filterBar.classList.remove('hidden');
  } else {
    filterBar.classList.add('hidden');
  }

  if (!data.videos || data.videos.length === 0 || filtered.length === 0) {
    list.innerHTML = '<div class="empty">浏览视频页面后自动嗅探<br><span class="hint">无需手动刷新</span></div>';
    return;
  }
  // 格式标签（阶段2：HLS/DASH/MP4/FLV）
  const fmtLabel = { hls: 'HLS', dash: 'DASH', mp4: 'MP4', flv: 'FLV' };
  const fmtSize = b => {
    if (!b && b !== 0) return '';
    if (b > 1024 * 1024 * 1024) return (b / 1024 / 1024 / 1024).toFixed(1) + 'GB';
    if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + 'MB';
    return (b / 1024).toFixed(0) + 'KB';
  };
  list.innerHTML = filtered.map(e => `
    <div class="card">
      <div class="meta">
        <span class="res">${e.resolution}</span>
        <span class="fmt-tag ${e.format}">${fmtLabel[e.format] || '?'}</span>
        <span class="size">${e.format === 'mp4' ? (e.size === undefined ? '⏳' : (e.size ? fmtSize(e.size) : '—')) : ''}</span>
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
        pageTitle: data.pageTitle || pageFileName(), // ★ 优先嗅探到的页面标题，否则 URL 末段（review P2-5）
      }, resp => {
        if (resp?.ok) {
          btn.textContent = '✅ 已加入';
        } else if (resp?.duplicate) {
          // 该 URL 已在任务列表：failed/paused → 提供"续传"（沿用原任务 id 断点续传，
          // 走重试智能接管自动找宿主 tab）；其他状态 → 询问是否强制重复下载（默认拒绝）
          const st = resp.existingStatus || '?';
          const retryable = st === 'failed' || st === 'cancelled' || st === 'paused';
          const pctTxt = resp.existingPct != null ? `（已下载 ${Math.round(resp.existingPct)}%）` : '';
          const force = confirm(retryable
            ? `检测到同一视频的${st === 'paused' ? '已暂停' : st === 'cancelled' ? '已取消' : '失败'}任务${pctTxt}，分片已保留，可直接续传不重复下载。\n\n续传该任务？`
            : `该视频已在下载任务列表中（状态：${st}${pctTxt}）。\n\n确定要重复下载一份吗？`);
          if (force) {
            chrome.runtime.sendMessage({
              type: 'ENQUEUE',
              url: btn.dataset.url,
              referer: btn.dataset.ref,
              resolution: btn.dataset.res,
              pageUrl: currentPageUrl,
              pageTitle: data.pageTitle || pageFileName(),
              // 续传：沿用原任务 id（OPFS 分片跳过）；页面嗅探续传时用户就在当前页操作
              // → forceHostTab 直接绑当前 tab（页面必然活，无需接管链绕路）
              retryId: retryable ? resp.existingId : undefined,
              force: retryable ? undefined : true,
              forceHostTab: retryable ? true : undefined,
              tabId: currentTabId || undefined,
            }, r2 => {
              if (r2?.ok) {
                btn.textContent = retryable ? '✅ 已续传' : '✅ 已加入';
              } else {
                // 续传也可能失败（如找不到宿主页），提示用户去下载管理点重试
                if (retryable && r2 && r2.ok === false) alert(r2.error || '续传失败，请到下载管理点「重试」');
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
  currentTabId = tabs[0]?.id || 0;
  chrome.runtime.sendMessage({ type: 'GET_M3U8S' }, data => {
    renderList(data || { videos: [], pageUrl: '' });
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
  chrome.runtime.sendMessage({ type: 'CLEAR_SNIFF' }, () => renderList({ videos: [], pageUrl: '' }));
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
