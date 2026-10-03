'use strict';
/** 批量实测：多首不同语种的歌，看选得对不对（简洁输出） */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'multi-test.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { MusicMeta } = require('../src/lib/music-meta');
const { Logger } = require('../src/lib/logger');

const SONGS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const LIST = SONGS.length
  ? SONGS
  : [
      'one last kiss',
      'Lemon',
      'Shape of You',
      'Faded',
      '打上花火',
      '残酷な天使のテーゼ',
      'Dynamite',
      'Yesterday Once More',
    ];

(async () => {
  const config = loadConfig([]);
  const logger = new Logger('m', 'error');
  const bili = new BilibiliClient(config.bilibili || {}, logger);
  const mm = new MusicMeta(config.bilibili || {}, logger);

  log('════════ 多语种实测 ════════');
  log('');

  let good = 0;
  let bad = 0;

  for (const song of LIST) {
    let meta = null;
    try {
      meta = await mm.lookupOriginal(song);
    } catch {
      /* ignore */
    }
    let r;
    const t0 = Date.now();
    try {
      r = await bili.pickForSong(song);
    } catch (e) {
      log('❌ ' + song.padEnd(24) + '异常: ' + e.message);
      bad += 1;
      continue;
    }
    const ms = Date.now() - t0;

    if (!r.ok) {
      log('❌ ' + song.padEnd(24) + '没找到：' + r.reason);
      bad += 1;
      continue;
    }

    const p = r.pick;
    const artist = meta && meta.artist ? meta.artist : '';
    const t = String(p.title || '').toLowerCase();
    const o = String(p.owner || '').toLowerCase();
    const a = artist.toLowerCase();
    const artistInTitle = a ? t.includes(a) : false;
    const artistInOwner = a ? o.includes(a) : false;
    // 官方/认证也是好信号
    const official = (p.reasons || []).some((x) => /官方|认证|原唱信号/.test(x));
    const ok = artistInTitle || artistInOwner || official;
    if (ok) good += 1;
    else bad += 1;

    log((ok ? '✅' : '⚠️ ') + ' ' + song.padEnd(24) + (p.bvid || '').padEnd(14) + String(Math.round(p.score)).padStart(5) + '分  ' + ms + 'ms');
    log('      ' + String(p.title || '').slice(0, 64));
    log('      原唱=' + (artist || '?') + '   UP=' + (p.owner || '?') + '   时长=' + p.duration + 's');
    const flags = [];
    if (artistInTitle) flags.push('标题署原唱');
    if (artistInOwner) flags.push('UP即原唱');
    if (official) flags.push('官方/认证');
    log('      ' + (flags.length ? flags.join(' + ') : '⚠️ 没有原唱背书'));
    log('');
  }

  log('════════════════════════════');
  log('  有原唱背书: ' + good + ' / ' + LIST.length);
  log('════════════════════════════');
  process.exit(0);
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
