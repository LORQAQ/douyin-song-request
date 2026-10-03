'use strict';
/**
 * 实测带 `-` 的写法，端到端看能不能选对。
 *
 * 注意：解析器会把 `-` 当标点剥掉（「Alone - Heart」→「Alone Heart」），
 * 所以程序实际拿到的是空格分隔的版本。
 * 但搜索时标题里同时含这两个词的视频（「Alone - Heart」「Heart - Alone」）
 * 都能被检索到，所以理论上仍然能选对。这里验证一下。
 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'dash-e2e.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { Logger } = require('../src/lib/logger');
const { parseRequest } = require('../src/danmaku/parser');

// [弹幕, 期望歌手, 期望时长, 说明]
const CASES = [
  ['点歌 Heart - Alone', 'Heart', 219, '歌手在前的标准写法'],
  ['点歌 Alone - Heart', 'Heart', 219, '歌名在前'],
  ['点歌 周杰伦 - 晴天', '周杰伦', 269, '中文标准写法'],
  ['点歌 晴天 - 周杰伦', '周杰伦', 269, '中文歌名在前'],
  ['点歌 Alan Walker - Alone', 'Alan Walker', 161, '多词英文歌手'],
  ['点歌 Adele - Hello', 'Adele', 295, '英文标准'],
  ['点歌 米津玄師 - Lemon', '米津玄師', 275, '日文歌手'],
];

(async () => {
  const config = loadConfig([]);
  const bili = new BilibiliClient(config.bilibili || {}, new Logger('d', 'error'));
  const trigger = config.trigger || {
    keywords: ['点歌'], requireKeyword: true, stripWords: ['点歌'], minLength: 2, maxLength: 40,
  };

  log('════════ 带 - 的写法 · 端到端实测 ════════');
  log('');

  let good = 0;
  for (const [msg, wantArtist, wantDur, note] of CASES) {
    const parsed = parseRequest(msg, trigger);
    const song = parsed && parsed.song ? parsed.song : null;
    log('「' + msg + '」  （' + note + '）');
    if (!song) {
      log('   ❌ 没解析出来');
      log('');
      continue;
    }
    log('   实际搜索词: 「' + song + '」   期望: ' + wantArtist + ' · ' + wantDur + 's');

    let r;
    const t0 = Date.now();
    try {
      r = await bili.pickForSong(song);
    } catch (e) {
      log('   ❌ 异常: ' + e.message);
      log('');
      continue;
    }
    const ms = Date.now() - t0;
    if (!r.ok) {
      log('   ❌ 没找到: ' + r.reason);
      log('');
      continue;
    }
    const p = r.pick;
    const both = (String(p.title || '') + ' ' + String(p.owner || '')).toLowerCase();
    const artistHit = both.includes(wantArtist.toLowerCase());
    const durHit = Math.abs((Number(p.duration) || 0) - wantDur) <= 25;
    const ok = artistHit && durHit;
    if (ok) good += 1;
    log('   ' + (ok ? '✅' : '⚠️ ') + Math.round(p.score) + '分 ' + ms + 'ms ' + (p.bvid || ''));
    log('      ' + String(p.title || '').slice(0, 62));
    log('      UP=' + (p.owner || '?') + '  时长=' + p.duration + 's' +
      '   含歌手' + (artistHit ? '✅' : '❌') + '   时长符合' + (durHit ? '✅' : '❌'));
    log('');
  }

  log('════════════════════════════');
  log('  选对: ' + good + ' / ' + CASES.length);
  log('════════════════════════════');
  process.exit(0);
})().catch((e) => {
  log('!! ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
