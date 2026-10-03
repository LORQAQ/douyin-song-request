'use strict';
/**
 * 性能与内存基线测量。
 *
 * 测什么（都是直播场景真正关心的）：
 *   1. 启动到服务就绪的耗时
 *   2. 稳态内存占用（RSS / Heap）
 *   3. 点歌耗时（冷/热）
 *   4. 弹幕吞吐（每秒处理多少条）+ 内存增长
 *   5. 长时间运行的缓存是否会无限膨胀
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const ROOT = __dirname + path.sep + '..';
const PORT = 8899; // 用别的端口，避免和正在跑的实例冲突

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 5000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('════════ 性能基线 ════════');
  console.log('');

  // ---- 1) 启动耗时 ----
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--port', String(PORT), '--mock'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1' },
  });

  let startMs = 0;
  for (let i = 0; i < 200; i += 1) {
    await sleep(100);
    const h = await get('/api/health');
    if (h) { startMs = Date.now() - t0; break; }
  }
  console.log('  1) 启动到服务就绪: ' + startMs + ' ms' + (startMs ? '' : '  ❌ 没起来'));

  if (!startMs) {
    child.kill();
    process.exit(1);
  }

  // ---- 2) 稳态内存 ----
  await sleep(2000);
  const readMem = () => {
    try {
      // 用 wmic 拿不到就退回 /api/diagnostics 的自报
      return null;
    } catch { return null; }
  };
  let d = await get('/api/diagnostics');
  const mem0 = d && d.memoryMB ? d.memoryMB : (d && d.memory ? d.memory : null);
  console.log('  2) 稳态内存: ' + JSON.stringify(mem0 || '(接口没提供)'));

  // ---- 3) 点歌耗时（冷 + 热） ----
  const songs = ['晴天', '稻香', '孤勇者'];
  for (const s of songs) {
    const a = Date.now();
    const r = await fetch(`http://127.0.0.1:${PORT}/api/song`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: Buffer.from(JSON.stringify({ song: s, nickname: '基准测试' })),
    });
    const cold = Date.now() - a;
    const b = Date.now();
    await fetch(`http://127.0.0.1:${PORT}/api/song`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: Buffer.from(JSON.stringify({ song: s, nickname: '基准测试' })),
    });
    const warm = Date.now() - b;
    console.log(`  3) 点歌「${s}」: 冷 ${cold}ms / 热(重复) ${warm}ms`);
  }

  // ---- 4) 弹幕吞吐 ----
  console.log('');
  console.log('  4) 弹幕吞吐测试…');
  const N = 2000;
  const msgs = [];
  for (let i = 0; i < N; i += 1) {
    msgs.push({ type: 'chat', nickname: '观众' + (i % 50), content: `点歌 测试歌${i % 200}`, userId: 'u' + (i % 50) });
  }
  const before = await get('/api/diagnostics');
  const tStart = Date.now();
  await fetch(`http://127.0.0.1:${PORT}/api/frame`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: msgs }),
  }).catch(() => null);
  const elapsed = Date.now() - tStart;
  await sleep(1500);
  const after = await get('/api/diagnostics');
  console.log(`     投喂 ${N} 条: ${elapsed}ms`);
  console.log('     内存变化: ' + JSON.stringify(before && before.memoryMB) + ' → ' + JSON.stringify(after && after.memoryMB));

  // ---- 5) 缓存上限 ----
  const st = await get('/api/state');
  if (st && st.stats) {
    console.log('');
    console.log('  5) 运行统计: ' + JSON.stringify(st.stats));
  }

  child.kill();
  await sleep(500);
  console.log('');
  console.log('════════ 基线测量完成 ════════');
  process.exit(0);
})().catch((e) => {
  console.error('失败: ' + e.message);
  process.exit(1);
});
