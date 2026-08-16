const url = 'https://cdn.部分无扩展名 CDN.com/stream?t=LfPVtQeiJbxouYj1qUv2A3C6nRS-2dPuu3iEddbWkOR7eFOtKDYiCIhbm62mvxbTY2W_UL4vLMgR0dej';

async function probe(name, init) {
  try {
    const r = await fetch(url, init);
    const h = {};
    for (const [k, v] of r.headers) h[k] = v;
    // 读一点 body 看类型
    let sample = '';
    try {
      const buf = await r.arrayBuffer();
      sample = buf.byteLength + ' bytes, 前4字节: ' + Array.from(new Uint8Array(buf.slice(0, 4))).map(b => b.toString(16).padStart(2, '0')).join(' ');
    } catch (e) { sample = 'body读失败: ' + e.message; }
    console.log(`\n=== ${name} ===`);
    console.log('状态:', r.status, r.statusText);
    console.log('content-type:', h['content-type'] || '无');
    console.log('content-length:', h['content-length'] || '无');
    console.log('content-range:', h['content-range'] || '无');
    console.log('access-control-allow-origin:', h['access-control-allow-origin'] || '无');
    console.log('cache-control:', h['cache-control'] || '无');
    console.log('sample:', sample);
  } catch (e) {
    console.log(`\n=== ${name} ===`);
    console.log('fetch 异常:', e.message);
  }
}

await probe('普通 GET', {});
await probe('Range: bytes=0-1023', { headers: { Range: 'bytes=0-1023' } });
await probe('HEAD', { method: 'HEAD' });
