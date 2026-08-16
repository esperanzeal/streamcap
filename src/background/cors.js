// cors.js — 动态 CORS 注入（DNR session 规则）
// 背景：部分站点等 CDN 有 CORS 头，content fetch 能读；部分无扩展名 CDN 等无扩展名 CDN 无 CORS 头，
// content fetch 被浏览器拦截（Failed to fetch）。cors_rules.json 静态规则只按 URL 扩展名
// （.mp4/.ts）注入，覆盖不到 /stream?t= 这类。这里给"要下载的视频 URL"动态加 DNR session
// 规则注入响应 CORS 头（含 preflight OPTIONS），下载完成由任务清理。
import { log } from './log.js';

let corsRuleId = 30000; // 与静态规则(1-5)、其他动态规则不冲突

export async function addCorsRule(url) {
  try {
    const u = new URL(url);
    const id = ++corsRuleId;
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
