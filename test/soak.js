'use strict';
/**
 * 长时间浸泡测试：模拟真实直播流量，找出「越跑越胀」的地方。
 *
 * 直播场景的流量特征：
 *   - 弹幕持续不断（每秒几条到几十条）
 *   - 大部分弹幕不是点歌请求
 *   - 点歌请求会触发搜索/缓存
 *
 * 这个脚本跑 N 分钟，每 10 秒记录一次内存，找出增长趋势。
 * 关注的是**稳态之后还涨不涨**（初期涨是 V8 预热，正常）。
 */
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8898;
const MINUTES = Number(process.argv[2]) || 3;
const RATE = Number(process.argv[3]) || 50; // 每秒弹幕数（真实直播大约 5~50）

// 结果同时写到文件（用 UTF-8，避免 Windows 重定向成 GBK 导致中文乱码）
const OUT_FILE = path.join(process.env.TEMP || ROOT, 'soak-result.txt');
const outLines = [];
function out(s) {
  const line = s === undefined ? '' : s;
  console.log(line);
  outLines.push(line);
  try { fs.writeFileSync(OUT_FILE, outLines.join('\n'), 'utf8'); } catch { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function get(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 4000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function post(p, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: p, method: 'POST', timeout: 8000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data);
    req.end();
  });
}

(async () => {
  out('════════ 浸泡测试 ════════');
  out(`  时长 ${MINUTES} 分钟，弹幕速率 ${RATE}/秒`);
  out('');

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'index.js'), '--port', String(PORT), '--source', 'mock'], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', () => {});

  for (let i = 0; i < 100; i += 1) { await sleep(100); if (await get('/api/health')) break; }
  await sleep(2000);

  const samples = [];
  const t0 = Date.now();
  let totalSent = 0;
  let stop = false;

  // 采样线程
  const sampler = (async () => {
    while (!stop) {
      const d = await get('/api/diagnostics');
      const st = await get('/api/state');
      samples.push({
        t: Math.round((Date.now() - t0) / 1000),
        rss: d && d.memoryMB ? d.memoryMB.rss : -1,
        heap: d && d.memoryMB ? d.memoryMB.heapUsed : -1,
        heapTotal: d && d.memoryMB ? d.memoryMB.heapTotal : -1,
        chats: st && st.stats ? st.stats.chatSeen : -1,
        requests: st && st.stats ? st.stats.requests : -1,
      });
      await sleep(10000);
    }
  })();

  // 流量线程：模拟真实弹幕分布
  const SONG_POOL = ['晴天', '稻香', '孤勇者', '海阔天空', '起风了', '演员', '成都', '后来'];
  const NON_REQUEST = [
    '主播好厉害', '哈哈哈', '666', '来了来了', '这首歌好听', '下次什么时候播',
    '关注了', '哈哈哈哈哈哈', 'awsl', '好听', '加油', '晚安', '签到', '第一',
  ];
  const windowMs = 1000;
  const tick = (async () => {
    let n = 0;
    while (!stop) {
      const batchStart = Date.now();
      const batch = [];
      for (let i = 0; i < RATE; i += 1) {
        n += 1;
        // 大约 8% 是点歌请求（真实直播差不多这个比例）
        if (n % 12 === 0) {
          const s = SONG_POOL[n % SONG_POOL.length];
          batch.push({ userId: 'u' + (n % 200), nickname: '观众' + (n % 200), content: `点歌 ${s}${n % 7}`, msgId: 'm' + n });
        } else {
          batch.push({ userId: 'u' + (n % 200), nickname: '观众' + (n % 200), content: NON_REQUEST[n % NON_REQUEST.length], msgId: 'm' + n });
        }
      }
      await post('/api/frame', { messages: batch });
      totalSent += batch.length;
      const spent = Date.now() - batchStart;
      if (spent < windowMs) await sleep(windowMs - spent);
    }
  })();

  const endAt = Date.now() + MINUTES * 60000;
  while (Date.now() < endAt) {
    await sleep(5000);
    const last = samples[samples.length - 1];
    if (last) process.stdout.write(`\r  t=${String(last.t).padStart(4)}s  rss=${String(last.rss).padStart(4)}MB  heap=${String(last.heap).padStart(3)}MB  已发=${totalSent}`);
  }

  stop = true;
  await sampler.catch(() => {});
  await tick.catch(() => {});
  await sleep(500);

  out('');
  out('');
  out('  时间(s)   RSS(MB)  Heap(MB)  HeapTotal(MB)  弹幕数');
  for (const s of samples) {
    out(
      '  ' + String(s.t).padStart(6) +
      '  ' + String(s.rss).padStart(7) +
      '  ' + String(s.heap).padStart(8) +
      '  ' + String(s.heapTotal).padStart(12) +
      '  ' + String(s.chats).padStart(7)
    );
  }

  out('');
  if (samples.length >= 4) {
    // 用后半段算趋势（前半段是 V8 预热，不算泄漏）
    const half = samples.slice(Math.floor(samples.length / 2));
    const first = half[0];
    const last = half[half.length - 1];
    const dMin = (last.t - first.t) / 60;
    out('  === 后半段趋势（排除预热）===');
    out(`    RSS : ${first.rss}MB → ${last.rss}MB  (${dMin > 0 ? ((last.rss - first.rss) / dMin).toFixed(1) : 0} MB/分钟)`);
    out(`    Heap: ${first.heap}MB → ${last.heap}MB  (${dMin > 0 ? ((last.heap - first.heap) / dMin).toFixed(2) : 0} MB/分钟)`);
    const rate = dMin > 0 ? (last.heap - first.heap) / dMin : 0;
    out('');
    if (rate > 1) out('    ⚠️  堆内存每分钟涨超过 1MB —— 很可能有泄漏');
    else if (rate > 0.2) out('    ⚠️  有轻微增长，注意观察');
    else out('    ✅ 稳态，没有明显泄漏');
  }

  out('');
  out(`  共投喂 ${totalSent} 条弹幕`);
  child.kill();
  await sleep(500);
  process.exit(0);
})().catch((e) => { console.error('失败: ' + e.message); process.exit(1); });
