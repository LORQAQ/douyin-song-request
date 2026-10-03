'use strict';
/**
 * 回归验证：修完非中文歌的匹配后，中文歌（原本的强项）有没有被改坏。
 * 重点看是不是还选歌手本人/官方账号的版本。
 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'regress-cn.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { Logger } = require('../src/lib/logger');

// 歌名 + 期望的原唱（用来判断选得对不对）
const CASES = [
  ['晴天', '周杰伦'],
  ['稻香', '周杰伦'],
  ['夜曲', '周杰伦'],
  ['孤勇者', '陈奕迅'],
  ['成都', '赵雷'],
  ['海阔天空', 'BEYOND'],
  ['演员', '薛之谦'],
  ['起风了', '买辣椒也用券'],
  ['后来', '刘若英'],
  ['挪威的森林', '伍佰'],
];

(async () => {
  const config = loadConfig([]);
  const bili = new BilibiliClient(config.bilibili || {}, new Logger('r', 'error'));

  log('════════ 中文歌回归验证 ════════');
  log('');

  let good = 0;
  let bad = 0;
  const problems = [];

  for (const [song, artist] of CASES) {
    const t0 = Date.now();
    let r;
    try {
      r = await bili.pickForSong(song);
    } catch (e) {
      log('  ❌ ' + song.padEnd(8) + ' 异常: ' + e.message);
      bad += 1;
      continue;
    }
    const ms = Date.now() - t0;
    if (!r.ok) {
      log('  ❌ ' + song.padEnd(8) + ' 没找到：' + r.reason);
      bad += 1;
      problems.push(song + ': ' + r.reason);
      continue;
    }
    const p = r.pick;
    const title = String(p.title || '');
    const owner = String(p.owner || '');
    // 期望：标题或 UP 主里出现原唱歌手名
    const ok = title.includes(artist) || owner.includes(artist);
    if (ok) good += 1;
    else {
      bad += 1;
      problems.push(song + ': 期望含「' + artist + '」，实际 ' + owner + ' / ' + title.slice(0, 36));
    }
    log('  ' + (ok ? '✅' : '⚠️ ') + ' ' + song.padEnd(8) + (p.bvid || '').padEnd(14) + String(Math.round(p.score)).padStart(5) + '分  ' + ms + 'ms');
    log('       ' + title.slice(0, 62));
    log('       UP=' + owner + '  时长=' + p.duration + 's');
  }

  log('');
  log('════════════════════════════════');
  log('  选对（标题/UP含原唱）: ' + good + ' / ' + CASES.length);
  if (problems.length) {
    log('  可疑:');
    problems.forEach((x) => log('     · ' + x));
  }
  log('════════════════════════════════');
  process.exit(0);
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
