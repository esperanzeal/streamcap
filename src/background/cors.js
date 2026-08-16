// cors.js — 动态 CORS 注入（DNR session 规则）
// 背景：部分站点等 CDN 有 CORS 头，content fetch 能读；部分无扩展名 CDN 等无扩展名 CDN 无 CORS 头，
// content fetch 被浏览器拦截（Failed to fetch）。cors_rules.json 静态规则只按 URL 扩展名
// （.mp4/.ts）注入，覆盖不到 /stream?t= 这类。这里给"要下载的视频 URL"动态加 DNR session
// 规则注入响应 CORS 头（含 preflight OPTIONS），下载完成由任务清理。
import { log } from './log.js';

// 固定规则 id：按 URL 哈希生成（同一 URL 稳定复用同一 id），先删后加实现幂等——
// DNR session 规则在 SW 重启后保留，若用递增计数器会因 SW 重启重置而 id 冲突。
function urlHash(url) {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) >>> 0;
  return h;
}

export async function addCorsRule(url) {
  try {
    const u = new URL(url);
    const id = 30000 + (urlHash(u.host + u.pathname) % 20000); // 30000~49999
    // 幂等：先删同名旧规则（SW 重启残留）再加
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [{
        id,
        priority: 2, // 高于静态规则 1
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: '*' },
            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
            { header: 'Access-Control-Allow-Headers', operation: 'set', value: 'Range, Referer, Content-Type' },
          ],
        },
        condition: {
          urlFilter: `||${u.host}${u.pathname}`,
          resourceTypes: ['xmlhttprequest', 'media', 'other'],
        },
      }],
    });
    log('debug', `[CORS规则] 已为 ${url.substring(0, 70)} 注入 CORS（规则 #${id}）`);
    return id;
  } catch (e) {
    log('warn', `[CORS规则] 添加失败 ${url.substring(0, 60)}: ${e.message}`);
    return null;
  }
}

export async function removeCorsRule(id) {
  if (!id) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  } catch {}
}
