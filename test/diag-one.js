'use strict';
/** 单首详细诊断：一首歌从解析到选中的每一步 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'one-detail.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { MusicMeta } = require('../src/lib/music-meta');
const { Logger } = require('../src/lib/logger');
const { parseRequest } = require('../src/danmaku/parser');

const SONG = process.argv.slice(2).join(' ').trim();

(async () => {
  const c = loadConfig([]);
  const logger = new Logger('d', 'debug');
  const lines = [];
  logger.onLine((l) => lines.push(typeof l === 'string' ? l : l.text || ''));

  const b = new BilibiliClient(c.bilibili || {}, logger);
  const mm = new MusicMeta(c.bilibili || {}, logger);
  const trigger = c.trigger || { keywords: ['点歌'], requireKeyword: true, stripWords: ['点歌'], minLength: 2, maxLength: 40 };

  log('════════ 单首诊断：「' + SONG + '」════════');
  log('');

  // 1) 解析
  const parsed = parseRequest('点歌 ' + SONG, trigger);
  log('【1】弹幕解析');
  log('   点歌 ' + SONG + ' → ok=' + (parsed && parsed.ok) + '  song=' + JSON.stringify(parsed && parsed.song) +
      '  artist=' + JSON.stringify(parsed && parsed.artist) + '  title=' + JSON.stringify(parsed && parsed.title));
  if (!parsed || !parsed.ok) {
    log('   ❌ 解析就被拒了：reason=' + (parsed && parsed.reason));
  }
  log('');

  const song = parsed && parsed.ok ? parsed.song : SONG;

  // 2) 原唱查询
  log('【2】平台原唱查询');
  let meta = null;
  try { meta = await mm.lookupOriginal(song); } catch (e) { log('   ❌ ' + e.message); }
  log('   ' + (meta && meta.artist ? meta.artist + '《' + (meta.songName || '') + '》 ' + (meta.durationSec || '?') + 's' : '❌ 查不到'));

  // 3) 原始搜索
  log('');
  log('【3】B站原始搜索（前 8 条）');
  try {
    const r = await b._searchVideos(song, 30);
    log('   共 ' + (r.items || []).length + ' 条');
    (r.items || []).slice(0, 8).forEach((x, i) => {
      log('     ' + String(i + 1).padStart(2) + '. ' + String(x.duration || '').padStart(7) + '  ' +
          String(x.author || '').slice(0, 14).padEnd(16) + String(x.title || '').replace(/<[^>]+>/g, '').slice(0, 40));
    });
  } catch (e) { log('   ❌ ' + e.message); }

  // 4) 本地打分后
  log('');
  log('【4】本地打分后的候选');
  try {
    const s = await b.searchSong(song, { noCache: true });
    log('   候选 ' + ((s.candidates || []).length) + ' 个' + (s.error ? '  error=' + s.error : ''));
    (s.candidates || []).slice(0, 6).forEach((x) => {
      log('     [' + String(Math.round(x.score)).padStart(4) + '] ' + String(x.duration || '?').padStart(4) + 's  ' +
          String(x.owner || '').slice(0, 12).padEnd(14) + String(x.title || '').slice(0, 38));
      if (x.reasons && x.reasons.length) log('            ' + x.reasons.slice(-4).join(' / '));
    });
    if (!((s.candidates || []).length)) {
      log('   ❌ 没有候选通过门槛（minScore=' + (c.bilibili.minScore || 58) + '）');
      // 看看 all 里有没有
      (s.all || []).slice(0, 6).forEach((x) => {
        log('     [all][' + String(Math.round(x.score)).padStart(4) + '] ' + String(x.title || '').slice(0, 42));
      });
    }
  } catch (e) { log('   ❌ ' + e.message); }

  // 5) 完整流程
  log('');
  log('【5】最终选中');
  try {
    const r = await b.pickForSong(song, { artist: parsed && parsed.artist, title: parsed && parsed.title });
    if (r.ok) {
      const p = r.pick;
      log('   ✅ ' + p.bvid + '  ' + Math.round(p.score) + '分  ' + p.duration + 's');
      log('      ' + String(p.title || ''));
      log('      UP=' + (p.owner || '?'));
      log('      路径: ' + (r.pinned ? '固定答案' : r.fromLocalIndex ? '本地索引' : '搜索'));
      if (p.reasons && p.reasons.length) log('      理由: ' + p.reasons.join(' / '));
    } else {
      log('   ❌ ' + r.reason);
    }
  } catch (e) { log('   ❌ ' + e.message); }

  // 6) 关键内部日志
  log('');
  log('【6】内部决策日志');
  const keys = /索引|合集|原唱参考|补搜|核验|白名单|加入比较|采用|置信|降权|剔除|断词|基准|指定歌手/;
  lines.filter((l) => keys.test(l)).slice(0, 18).forEach((l) => log('   ' + l));

  process.exit(0);
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
