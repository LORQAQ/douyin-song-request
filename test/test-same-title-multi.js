'use strict';
/**
 * 实测「同名不同歌」——典型如 Alone / Hello / Stay / Sorry 这类
 * 一个词被很多歌手用过、且每首都是名曲的情况。
 *
 * 关注：观众只发「点歌 Alone」（不带歌手名）时会选到哪一首，
 * 以及"猜"得合不合理。
 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'same-title-multi.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { MusicMeta } = require('../src/lib/music-meta');
const { Logger } = require('../src/lib/logger');

/** 真实的同名曲目（都是名曲） */
const CASES = [
  {
    song: 'Alone',
    known: [
      ['Heart', 219, '1987 摇滚'],
      ['Marshmello', 153, '2016 电音'],
      ['Alan Walker', 161, '2016 电音'],
      ['Dozer', 165, ''],
    ],
  },
  {
    song: 'Stay',
    known: [
      ['Rihanna', 240, '2012'],
      ['The Kid LAROI', 141, '2021'],
      ['Zedd', 210, '2017'],
      ['Kygo', 228, ''],
    ],
  },
  {
    song: 'Hello',
    known: [
      ['Adele', 295, '2015'],
      ['Lionel Richie', 250, '1983'],
      ['Martin Solveig', 205, '2010'],
    ],
  },
  {
    song: 'Sorry',
    known: [
      ['Justin Bieber', 200, '2015'],
      ['Madonna', 236, '2005'],
      ['Nothing But Thieves', 190, ''],
    ],
  },
];

(async () => {
  const config = loadConfig([]);
  const logger = new Logger('s', 'error');
  const bili = new BilibiliClient(config.bilibili || {}, logger);
  const mm = new MusicMeta(config.bilibili || {}, logger);

  log('════════ 同名不同歌（Alone / Stay / Hello / Sorry）════════');
  log('');

  for (const { song, known } of CASES) {
    log('════ ' + song + ' ════');
    log('  已知同名名曲:');
    known.forEach(([a, d, n]) => log('    · ' + a.padEnd(20) + d + 's   ' + n));

    // 平台查到哪一首
    let meta = null;
    try {
      meta = await mm.lookupOriginal(song);
    } catch { /* ignore */ }
    log('  平台判定原唱: ' + (meta && meta.artist
      ? meta.artist + ' · ' + (meta.durationSec || '?') + 's' + (meta.album ? '   专辑《' + meta.album + '》' : '')
      : '❌ 查不到'));
    if (meta && meta.durations) log('            所有版本时长=' + JSON.stringify(meta.durations));

    // 最终选了什么
    let r;
    const t0 = Date.now();
    try {
      r = await bili.pickForSong(song);
    } catch (e) {
      log('  ❌ 异常: ' + e.message);
      log('');
      continue;
    }
    const ms = Date.now() - t0;
    if (!r.ok) {
      log('  ❌ 没找到: ' + r.reason);
    } else {
      const p = r.pick;
      log('  → 选中 ' + Math.round(p.score) + '分  ' + ms + 'ms  ' + (p.bvid || ''));
      log('     ' + String(p.title || '').slice(0, 64));
      log('     UP=' + (p.owner || '?') + '   时长=' + p.duration + 's');
      // 匹配到哪个已知版本
      const dur = Number(p.duration) || 0;
      const best = known
        .map(([a, d]) => ({ a, d, diff: Math.abs(d - dur) }))
        .sort((x, y) => x.diff - y.diff)[0];
      log('     时长最接近: ' + best.a + '（' + best.d + 's，差 ' + best.diff + 's）' +
        (best.diff <= 15 ? '  ← 应该就是这首' : '  ⚠️ 对不上任何已知版本'));
      if (meta && meta.artist) {
        const sameArtist = String(p.title || '').includes(meta.artist) || String(p.owner || '').includes(meta.artist);
        log('     与平台判定的一致: ' + (sameArtist ? '✅' : '❌'));
      }
    }
    log('');
  }

  log('════════════════════════════');
  process.exit(0);
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
