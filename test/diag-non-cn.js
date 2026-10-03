'use strict';
/**
 * 诊断：非中文歌名（英文/日文/韩文）的点歌匹配到底哪里出问题。
 *
 * 逐首跑一遍完整的 pickForSong，把候选排名打出来看。
 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'noncn-diagnose.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { MusicMeta } = require('../src/lib/music-meta');
const { Logger } = require('../src/lib/logger');
const { songFingerprint, parseRequest } = require('../src/danmaku/parser');

const SONGS = [
  // 英文
  'Shape of You',
  'Yesterday Once More',
  'Hotel California',
  'Blinding Lights',
  'Faded',
  // 日文
  'Lemon',
  '残酷な天使のテーゼ',
  '打上花火',
  // 韩文
  'Dynamite',
  'Gangnam Style',
  // 中文对照
  '晴天',
];

(async () => {
  const config = loadConfig([]);
  const logger = new Logger('diag', 'error');
  const bili = new BilibiliClient(config.bilibili || {}, logger);

  log('════════ 非中文歌名匹配诊断 ════════');
  log('');

  // ---- 1) 归一化 & 指纹 ----
  log('【1】歌名归一化（会不会被改坏）');
  for (const s of SONGS) {
    const fp = songFingerprint(s);
    const damaged = fp !== s.toLowerCase().replace(/[\s·・~～!！?？,，.。、:：;；'"“”‘’()（）\[\]【】<>《》\-—_+*/\\|@#$%^&^]+/g, '');
    log('   ' + s.padEnd(24) + ' 指纹 → "' + fp + '"' + (damaged ? '   ⚠️' : ''));
  }
  log('');

  // ---- 2) 弹幕解析：点歌 + 英文名 ----
  log('【2】弹幕解析（"点歌 Shape of You"）');
  const trigger = { keywords: ['点歌'], requireKeyword: true, stripWords: ['点歌', '来一首', '谢谢主播'], minLength: 2, maxLength: 40 };
  for (const s of ['点歌 Shape of You', '点歌 Lemon', '点歌 Dynamite', '点歌 晴天', '点歌 Shape of You 谢谢主播']) {
    const r = parseRequest(s, trigger);
    log('   ' + s.padEnd(34) + ' → ' + (r && r.song ? '"' + r.song + '"' : '（没解析出来）'));
  }
  log('');

  // ---- 3) 原唱查询（酷狗）----
  log('【3】原唱查询（拿不到原唱信息就选不准）');
  const mm = new MusicMeta(config.musicMeta || {}, logger);
  for (const s of SONGS.slice(0, 8)) {
    try {
      const meta = await mm.lookup(s);
      const artist = meta && (meta.artist || meta.singer) ? meta.artist || meta.singer : null;
      const dur = meta && meta.duration ? meta.duration + 's' : '-';
      log('   ' + s.padEnd(24) + ' → ' + (artist ? '原唱: ' + artist + '  时长: ' + dur : '❌ 查不到'));
    } catch (e) {
      log('   ' + s.padEnd(24) + ' → ❌ ' + e.message);
    }
  }
  log('');

  // ---- 4) 完整点歌 ----
  log('【4】完整匹配结果（这是观众最终听到的）');
  for (const s of SONGS) {
    const t0 = Date.now();
    try {
      const r = await bili.pickForSong(s);
      const ms = Date.now() - t0;
      if (!r.ok) {
        log('   ❌ ' + s.padEnd(22) + r.reason + '  (' + ms + 'ms)');
      } else {
        const p = r.pick;
        log('   ✅ ' + s.padEnd(22) + (p.bvid || '') + '  ' + ms + 'ms');
        log('        标题: ' + String(p.title || '').slice(0, 58));
        log('        UP主: ' + (p.owner || '?') + '   时长: ' + (p.duration || '?') + 's   播放: ' + (p.play || 0));
        log('        得分: ' + Math.round(p.score || 0) + (p.derivative ? '   ⚠️ 被判为二创' : ''));
      }
    } catch (e) {
      log('   ❌ ' + s.padEnd(22) + '异常: ' + e.message);
    }
  }

  log('');
  log('诊断完成');
  process.exit(0);
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
