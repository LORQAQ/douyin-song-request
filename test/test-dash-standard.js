'use strict';
/**
 * 端到端实测「歌手 - 歌名」格式。
 *
 * 链路：parseRequest（硬规则切分）→ pickForSong({artist,title}) → 选中的视频。
 * 不经过播放器（避免自动连播把队列清空，导致取不到结果）。
 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'dash-final.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const { loadConfig } = require('../src/config');
const { BilibiliClient, toSimplified } = require('../src/bilibili/bili-api');
const { Logger } = require('../src/lib/logger');
const { parseRequest } = require('../src/danmaku/parser');

// [弹幕, 期望歌手, 期望时长, 说明]
const CASES = [
  ['点歌 Heart - Alone', 'Heart', 219, '歌手-歌名（标准）'],
  ['点歌 周杰伦 - 晴天', '周杰伦', 269, '中文标准'],
  ['点歌 Alan Walker - Alone', 'Alan Walker', 161, '多词英文歌手'],
  ['点歌 Adele - Hello', 'Adele', 295, '英文标准'],
  ['点歌 米津玄師 - Lemon', '米津玄师', 275, '日文歌手（繁体输入）'],
  ['点歌 Taylor Swift - Love Story', 'Taylor Swift', 231, '多词歌手 + 多词歌名'],
  ['点歌 The Kid LAROI - Stay', 'The Kid LAROI', 141, '含 The 的歌手名'],
  ['点歌 Marshmello - Alone', 'Marshmello', 199, '同名不同歌·指定另一版本'],
];

(async () => {
  const config = loadConfig([]);
  const bili = new BilibiliClient(config.bilibili || {}, new Logger('e', 'error'));
  const trigger = config.trigger || {
    keywords: ['点歌'], requireKeyword: true, stripWords: ['点歌'], minLength: 2, maxLength: 40,
  };

  log('════════ 「歌手 - 歌名」端到端实测 ════════');
  log('');

  let good = 0;
  for (const [msg, wantArtist, wantDur, note] of CASES) {
    const parsed = parseRequest(msg, trigger);
    log('「' + msg + '」  （' + note + '）');
    if (!parsed || !parsed.ok || !parsed.artist) {
      log('   ❌ 没解析出歌手（artist=' + JSON.stringify(parsed && parsed.artist) + '）');
      log('');
      continue;
    }
    log('   解析: 歌手=「' + parsed.artist + '」 歌名=「' + parsed.title + '」');

    let r;
    const t0 = Date.now();
    try {
      r = await bili.pickForSong(parsed.song, { artist: parsed.artist, title: parsed.title });
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
    /**
     * 【比对前要繁简归一 + 统一大小写】
     *
     * 观众用繁体点（「米津玄師」），B站标题写简体（「米津玄师」）——
     * 直接字符串比对会误判成"没匹配到歌手"，其实选得完全正确。
     * 用项目里现成的 toSimplified() 归一，和匹配逻辑保持一致。
     */
    const norm = (x) => toSimplified(String(x || '')).toLowerCase();
    const both = norm(String(p.title || '') + ' ' + String(p.owner || ''));
    const artistHit = both.includes(norm(wantArtist));
    const durHit = Math.abs((Number(p.duration) || 0) - wantDur) <= 25;
    const ok = artistHit && durHit;

    if (ok) good += 1;
    log('   ' + (ok ? '✅' : '⚠️ ') + Math.round(p.score) + '分  ' + ms + 'ms  ' + (p.bvid || ''));
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
