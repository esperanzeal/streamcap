// logger.js — StreamCap 日志查看页
const $ = id => document.getElementById(id);
let curDate = todayStr();
let lines = [];

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function shiftDay(delta) {
  const d = new Date(curDate + 'T00:00:00');
  d.setDate(d.getDate() + delta);
  curDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function load() {
  $('date').value = curDate;
  $('lines').innerHTML = '<div class="empty">加载中...</div>';
  chrome.runtime.sendMessage({ type: 'GET_LOGS', date: curDate }, resp => {
    lines = (resp && resp.lines) || [];
    render();
  });
}

function render() {
  // 关键字筛选（视图级；导出仍导出当天全量）
  const kwEl = $('filter');
  const kw = kwEl ? (kwEl.value || '').trim() : '';
  const shown = kw ? lines.filter(l => l.includes(kw)) : lines;
  $('count').textContent = `${curDate} · ${shown.length}${kw ? ' / ' + lines.length : ''} 条`;
  if (shown.length === 0) {
    $('lines').innerHTML = kw
      ? `<div class="empty">🔍 无匹配「${esc(kw)}」的记录</div>`
      : '<div class="empty">📭 当天暂无日志</div>';
    return;
  }
  $('lines').innerHTML = shown.map(l => {
    const m = l.match(/\[(\w+)\]/);
    const cls = m ? 'l-' + m[1].toLowerCase() : 'l-info';
    return `<span class="${cls}">${esc(l)}</span>\n`;
  }).join('');
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

$('date').addEventListener('change', () => { curDate = $('date').value; load(); });
$('btnPrev').addEventListener('click', () => { shiftDay(-1); load(); });
$('btnNext').addEventListener('click', () => { shiftDay(1); load(); });
$('btnToday').addEventListener('click', () => { curDate = todayStr(); load(); });

$('btnExport').addEventListener('click', () => {
  const blob = new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `streamcap_log_${curDate}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
});

$('btnClear').addEventListener('click', () => {
  if (!confirm(`确定清空 ${curDate} 的日志？`)) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_LOGS', date: curDate }, () => load());
});

$('btnClearAll').addEventListener('click', () => {
  if (!confirm('确定清空全部日志（所有日期）？此操作不可恢复。')) return;
  chrome.runtime.sendMessage({ type: 'CLEAR_ALL_LOGS' }, () => {
    load();
    const c = $('count');
    if (c) c.textContent = `${curDate} · 0 条`;
  });
});

// 关键字筛选：视图级过滤（导出仍导出当天全量）。带存在性判断——
// 若 html/js 版本不同步（如扩展未重载）也不会让本文件后续代码中断（曾导致整页卡"加载中"）
const filterEl = $('filter');
if (filterEl) filterEl.addEventListener('input', render);

load();
