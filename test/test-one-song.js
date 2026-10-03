'use strict';
/** 实测一首具体的歌：走完整的点歌流程，把结果和中间信息都打出来 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'one-song-test.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { MusicMeta } = require('../src/lib/music-meta');
const { Logger } = require('../src/lib/logger');
const { parseRequest } = require('../src/danmaku/parser');

const SONG = process.argv.slice(2).join(' ') || 'one last kiss';

(async () => {
  const config = loadConfig([]);
  const logger = new Logger('t', 'debug');
  const debugLines = [];
  logger.onLine((line) => {
    const s = typeof line === 'string' ? line : line.text || JSON.stringify(line);
    debugLines.push(s);
  });
  const bili = new BilibiliClient(config.bilibili || {}, logger);
  const mm = new MusicMeta(config.bilibili || {}, logger);

  log('════════ 实测点歌：「' + SONG + '」════════');
  log('');

  // 1) 弹幕能不能解析出来
  const trigger = config.trigger || { keywords: ['点歌'], requireKeyword: true, stripWords: ['点歌'], minLength: 2, maxLength: 40 };
  const parsed = parseRequest('点歌 ' + SONG, trigger);
  log('【1】弹幕解析：');
  log('   「点歌 ' + SONG + '」 → ' + (parsed && parsed.song ? '「' + parsed.song + '」' : '❌ 没解析出来'));
  log('');

  // 2) 原唱查询
  log('【2】原唱查询（酷狗）：');
  let meta = null;
  try {
    meta = await mm.lookupOriginal(SONG);
  } catch (e) {
    log('   ❌ ' + e.message);
  }
  if (meta && meta.artist) {
    log('   原唱: ' + meta.artist);
    log('   歌名: ' + (meta.songName || '-'));
    log('   专辑: ' + (meta.album || '-'));
    log('   时长: ' + (meta.durationSec || '-') + 's   所有版本时长: ' + JSON.stringify(meta.durations || []));
  } else {
    log('   ❌ 查不到原唱信息（匹配会退化到纯标题相似度）');
  }
  log('');

  // 3) 完整点歌
  log('【3】完整点歌流程：');
  const t0 = Date.now();
  let r;
  try {
    r = await bili.pickForSong(SONG);
  } catch (e) {
    log('   ❌ 异常: ' + e.message);
    process.exit(1);
  }
  const ms = Date.now() - t0;

  if (!r.ok) {
    log('   ❌ 没找到：' + r.reason);
  } else {
    const p = r.pick;
    log('   ✅ ' + (p.bvid || '') + '   用时 ' + ms + 'ms');
    log('   标题  : ' + (p.title || ''));
    log('   UP主  : ' + (p.owner || '?'));
    log('   时长  : ' + p.duration + 's' + (meta && meta.durationSec ? '（原曲 ' + meta.durationSec + 's，差 ' + Math.abs(p.duration - meta.durationSec) + 's）' : ''));
    log('   播放量: ' + (p.play || 0));
    log('   得分  : ' + Math.round(p.score || 0));
    log('   页码  : P' + (p.page || 1));
    log('   路径  : ' + (r.pinned ? '固定答案' : r.fromLocalIndex ? '本地索引' : '搜索'));
    if (p.reasons && p.reasons.length) log('   理由  : ' + p.reasons.join(' / '));
    if (p.pageUrl) log('   链接  : ' + p.pageUrl);

    // 4) 判断对不对
    log('');
    log('【4】对不对：');
    if (meta && meta.artist) {
      const a = meta.artist.toLowerCase();
      const t = String(p.title || '').toLowerCase();
      const o = String(p.owner || '').toLowerCase();
      log('   原唱「' + meta.artist + '」在标题里: ' + (t.includes(a) ? '✅ 是' : '❌ 否'));
      log('   原唱「' + meta.artist + '」在UP主里: ' + (o.includes(a) ? '✅ 是' : '❌ 否'));
    }
    // 常见的问题特征
    const bad = [];
    if (/fancam|饭拍|演唱会|live|现场/i.test(p.title)) bad.push('疑似现场/饭拍');
    if (/学唱|教程|教学|翻唱|cover/i.test(p.title)) bad.push('疑似教学/翻唱');
    if (/神仙打架|盘点|150首|100首|精选合集/i.test(p.title)) bad.push('疑似第三方杂锦合集');
    log('   问题特征: ' + (bad.length ? bad.join(', ') : '无'));
  }

  // 5) 内部决策日志
  log('');
  log('【5】内部决策日志（关键行）：');
  const keys = /索引|合集|原唱参考|补搜|核验|白名单|加入比较|采用|置信|降权/;
  debugLines.filter((l) => keys.test(l)).slice(0, 14).forEach((l) => log('   ' + l));

  process.exit(0);
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
