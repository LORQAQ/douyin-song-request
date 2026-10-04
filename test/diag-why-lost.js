'use strict';
/** 看这首歌每个候选的分数，找出正确的「完整版」为什么被淘汰 */
const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { Logger } = require('../src/lib/logger');

const SONG = process.argv.slice(2).join(' ').trim() || '大家一起十六强';

(async () => {
  const c = loadConfig([]);
  const b = new BilibiliClient(c.bilibili || {}, new Logger('x', 'error'));

  const cfg = c.bilibili || {};
  const minDur = Number(cfg.minDurationSec ?? 60);
  const maxDur = Number(cfg.maxDurationSec ?? 900);
  const minPlay = Number(cfg.minPlay ?? 0);
  const minScore = Number(cfg.minScore ?? 58);
  const excludeInstrumental = cfg.excludeInstrumental !== false;

  const r = await b._searchVideos(SONG, 30);
  const items = r.items || [];
  console.log('原始结果 ' + items.length + ' 条');
  console.log('门槛: minDur=' + minDur + ' maxDur=' + maxDur + ' minPlay=' + minPlay + ' minScore=' + minScore);
  console.log('');

  const ranked = b._rank(SONG, SONG, items);
  const all = ranked.all || [];
  console.log('_rank 的 all 共 ' + all.length + ' 条（未过滤）:');
  console.log('');
  all.forEach((x, i) => {
    const baseFilter =
      x.titleMatch !== 'poor' &&
      !(excludeInstrumental && x.instrumental) &&
      !(x.duration && (x.duration < minDur || x.duration > maxDur)) &&
      !(minPlay > 0 && x.play < minPlay);

    const fails = [];
    if (x.titleMatch === 'poor') fails.push('titleMatch=poor');
    if (excludeInstrumental && x.instrumental) fails.push('器乐');
    if (x.duration && (x.duration < minDur || x.duration > maxDur)) fails.push('时长越界');
    if (minPlay > 0 && x.play < minPlay) fails.push('播放量不足');
    if (!baseFilter) fails.push('→被baseFilter淘汰');
    if (x.score < 30) fails.push('→分数<30被粗排池淘汰');
    else if (x.score < minScore) fails.push('→分数<' + minScore + '被finalize淘汰');

    console.log(
      String(i + 1).padStart(2) + '. [' + String(Math.round(x.score)).padStart(4) + '] ' +
      String(x.duration || '?').padStart(4) + 's ' +
      String(x.play || 0).padStart(9) + '播 ' +
      String(x.owner || '').slice(0, 12).padEnd(13) +
      String(x.title || '').slice(0, 34)
    );
    if (fails.length) console.log('      ⛔ ' + fails.join(' '));
    if (x.reasons && x.reasons.length) console.log('      ' + x.reasons.slice(-4).join(' / '));
  });

  console.log('');
  console.log('最终候选（过了 finalize）: ' + (ranked.candidates || []).length + ' 个');
  (ranked.candidates || []).forEach((x) => {
    console.log('  [' + Math.round(x.score) + '] ' + String(x.title || '').slice(0, 46));
  });
  process.exit(0);
})();
