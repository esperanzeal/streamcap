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
  $('count').textContent = `${curDate} · ${lines.length} 条`;
  if (lines.length === 0) {
    $('lines').innerHTML = '<div class="empty">📭 当天暂无日志</div>';
    return;
  }
  $('lines').innerHTML = lines.map(l => {
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

load();
