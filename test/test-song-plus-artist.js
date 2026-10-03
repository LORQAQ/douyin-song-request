'use strict';
/**
 * 实测「歌名 + 歌手」这种点法是否真的生效。
 *
 * 观众写「点歌 Alone Heart」时，程序应该：
 *   1. 抽出歌手线索 Heart（用于打分时给含 Heart 的候选加分）
 *   2. 搜索词里带上 Heart
 *   3. 最终选中 Heart 的版本，而不是播放量最高的那一首
 *
 * 注意 artistHints 用的是**标题里的字符串包含**，英文歌手名要大小写不敏感。
 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'artist-hint-test.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { MusicMeta } = require('../src/lib/music-meta');
const { Logger } = require('../src/lib/logger');
const { parseRequest } = require('../src/danmaku/parser');

/** [观众发的弹幕, 期望选到的歌手, 期望的时长(秒，可空), 说明] */
const CASES = [
  ['点歌 Alone Heart', 'Heart', 219, 'Alone 的摇滚原版'],
  ['点歌 Alone Alan Walker', 'Alan Walker', 161, 'Alone 的电音版'],
  ['点歌 Alone Marshmello', 'Marshmello', 153, 'Alone 的另一首电音'],
  ['点歌 Hello Adele', 'Adele', 295, 'Hello 的阿黛尔版'],
  ['点歌 Stay Zedd', 'Zedd', 210, 'Stay 的 Zedd 版'],
  ['点歌 晴天 周杰伦', '周杰伦', 269, '中文对照'],
];

(async () => {
  const config = loadConfig([]);
  const logger = new Logger('h', 'debug');
  const debugLines = [];
  logger.onLine((l) => debugLines.push(typeof l === 'string' ? l : l.text || ''));

  const bili = new BilibiliClient(config.bilibili || {}, logger);
  const mm = new MusicMeta(config.bilibili || {}, logger);
  const trigger = config.trigger || {
    keywords: ['点歌'], requireKeyword: true, stripWords: ['点歌'], minLength: 2, maxLength: 40,
  };

  log('════════ 「歌名 + 歌手」实测 ════════');
  log('');

  let good = 0;

  for (const [msg, wantArtist, wantDur, note] of CASES) {
    log('════ ' + msg + ' ════');
    log('  期望: ' + wantArtist + (wantDur ? ' · ' + wantDur + 's' : '') + '   （' + note + '）');

    // 1) 弹幕解析
    const parsed = parseRequest(msg, trigger);
    const song = parsed && parsed.song ? parsed.song : null;
    log('  解析出歌名: 「' + (song || '失败') + '」');
    if (!song) {
      log('  ❌ 解析失败');
      log('');
      continue;
    }

    // 2) 歌手线索
    const hints = bili._artistHints(song);
    log('  歌手线索: ' + JSON.stringify(hints) + (hints.length ? '' : '   ⚠️ 空！'));

    // 3) 平台查询
    let meta = null;
    try {
      meta = await mm.lookupOriginal(song);
    } catch { /* ignore */ }
    log('  平台判定: ' + (meta && meta.artist ? meta.artist + ' · ' + meta.durationSec + 's' : '无'));

    // 4) 最终结果
    debugLines.length = 0;
    const t0 = Date.now();
    let r;
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
      log('');
      continue;
    }
    const p = r.pick;
    const title = String(p.title || '');
    const owner = String(p.owner || '');
    const lowerBoth = (title + ' ' + owner).toLowerCase();
    const artistHit = lowerBoth.includes(wantArtist.toLowerCase());
    const durHit = wantDur ? Math.abs((Number(p.duration) || 0) - wantDur) <= 20 : true;
    const ok = artistHit && durHit;
    if (ok) good += 1;

    log('  → ' + (ok ? '✅' : '⚠️ ') + Math.round(p.score) + '分  ' + ms + 'ms  ' + (p.bvid || ''));
    log('     ' + title.slice(0, 64));
    log('     UP=' + owner + '   时长=' + p.duration + 's');
    log('     含期望歌手「' + wantArtist + '」: ' + (artistHit ? '✅' : '❌'));
    if (wantDur) log('     时长符合期望 ' + wantDur + 's: ' + (durHit ? '✅' : '❌'));
    if (p.reasons && p.reasons.length) log('     理由: ' + p.reasons.slice(-4).join(' / '));

    // 关键日志
    const keys = /索引|合集|原唱参考|补搜|核验|加入比较|采用|歧义|权重/;
    const rel = debugLines.filter((l) => keys.test(l)).slice(0, 6);
    if (rel.length) {
      log('     内部:');
      rel.forEach((l) => log('       ' + l));
    }
    log('');
  }

  log('════════════════════════════');
  log('  完全符合期望: ' + good + ' / ' + CASES.length);
  log('════════════════════════════');
  process.exit(0);
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
