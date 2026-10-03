'use strict';
/**
 * 实测「同名不同歌」的处理。
 *
 * 这类场景的特征：同一个歌名对应**不同的歌**（不同歌手/不同年代/不同曲）。
 * 程序必须靠"歌手 + 时长"把它们分开，光看歌名不够。
 *
 * 用例说明：
 *   · 海阔天空        Beyond(1993, 325s) vs 信乐团(2004, 290s) —— 两首不同的歌
 *   · 后来            刘若英(340s) vs 张智成
 *   · 打上花火        原唱 DAOKO×米津玄師，但酷狗错标成中文翻唱「祈Inory」
 *   · 突然的自我      伍佰 vs 很多人翻唱
 *   · 情人            Beyond / 杜德伟 / 蔡徐坤 都是不同歌
 *   · 一个人          多首完全不同的歌
 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'same-name.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { MusicMeta } = require('../src/lib/music-meta');
const { Logger } = require('../src/lib/logger');

/** 歌名 → [ {artist, dur, note} ... ] 已知的同名不同歌 */
const CASES = [
  { song: '海阔天空', variants: [
    { artist: 'BEYOND', dur: 325, note: '粤语原版' },
    { artist: '信乐团', dur: 290, note: '另一首完全不同的歌' },
  ] },
  { song: '后来', variants: [
    { artist: '刘若英', dur: 340, note: '原唱' },
    { artist: '张智成', dur: 260, note: '同名不同歌' },
  ] },
  { song: '情人', variants: [
    { artist: 'BEYOND', dur: 265, note: '粤语' },
    { artist: '杜德伟', dur: 250, note: '另一首' },
    { artist: '蔡徐坤', dur: 200, note: '又一首' },
  ] },
  { song: '打上花火', variants: [
    { artist: 'DAOKO×米津玄師', dur: 289, note: '日文原版' },
    { artist: '祈Inory', dur: 293, note: '中文翻唱（酷狗误标为原唱）' },
  ] },
  { song: '突然的自我', variants: [{ artist: '伍佰', dur: 217, note: '原唱' }] },
];

(async () => {
  const config = loadConfig([]);
  const logger = new Logger('s', 'error');
  const bili = new BilibiliClient(config.bilibili || {}, logger);
  const mm = new MusicMeta(config.bilibili || {}, logger);

  log('════════ 同名不同歌 · 实测 ════════');
  log('');

  for (const { song, variants } of CASES) {
    log('════ ' + song + ' ════');
    log('  已知同名版本:');
    variants.forEach((v) => log('    · ' + v.artist + '  ' + v.dur + 's  （' + v.note + '）'));

    // 平台查到什么
    let meta = null;
    try {
      meta = await mm.lookupOriginal(song);
    } catch { /* ignore */ }
    log('  平台查询: ' + (meta && meta.artist
      ? meta.artist + ' · ' + (meta.durationSec || '?') + 's   所有时长=' + JSON.stringify(meta.durations || [])
      : '❌ 查不到'));
    if (meta && meta.songName && meta.songName !== song) {
      log('            平台给的歌名: 「' + meta.songName + '」' + (meta.songName !== song ? '  ← 与点歌名不同' : ''));
    }

    // 索引里同名条目有几个归属歌手
    const idx = bili._loadLocalIndex();
    if (idx) {
      const want = song.toLowerCase().replace(/\s/g, '');
      const owners = new Map();
      for (const [artist, info] of Object.entries(idx.artists)) {
        for (const v of info.videos || []) {
          const t = String(v.title || '').toLowerCase().replace(/[\s\-_·【】\[\]()（）]/g, '');
          if (t === want || t.includes(want)) {
            if (!owners.has(artist)) owners.set(artist, []);
            owners.get(artist).push(Number(v.duration));
          }
        }
      }
      const list = [...owners.entries()].sort((a, b) => b[1].length - a[1].length);
      log('  索引里同名条目归属 ' + list.length + ' 位歌手（前 6）:');
      list.slice(0, 6).forEach(([a, durs]) => {
        const uniq = [...new Set(durs)].sort((x, y) => x - y);
        log('    · ' + a.padEnd(12) + durs.length + ' 条   时长=' + JSON.stringify(uniq.slice(0, 6)));
      });
    }

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
      log('  → 选中: ' + (p.bvid || '') + '  ' + Math.round(p.score) + '分  ' + ms + 'ms');
      log('     ' + String(p.title || '').slice(0, 62));
      log('     UP=' + (p.owner || '?') + '  时长=' + p.duration + 's');
      // 判断选的是哪个版本
      if (meta && meta.artist) {
        const hit = String(p.title || '').includes(meta.artist) || String(p.owner || '').includes(meta.artist);
        log('     与平台原唱「' + meta.artist + '」一致: ' + (hit ? '✅' : '❌ 不一致'));
      }
      // 和已知版本比时长
      const dur = Number(p.duration) || 0;
      const closest = variants
        .map((v) => ({ ...v, diff: Math.abs(v.dur - dur) }))
        .sort((a, b) => a.diff - b.diff)[0];
      log('     最接近的已知版本: ' + closest.artist + '（差 ' + closest.diff + 's）' +
        (closest.diff <= 5 ? '  ✅ 时长吻合' : closest.diff <= 30 ? '  ⚠️ 大致吻合' : '  ❌ 对不上'));
    }
    log('');
  }

  log('════════════════════════════');
  process.exit(0);
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
