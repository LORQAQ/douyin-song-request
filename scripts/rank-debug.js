'use strict';

/**
 * 看看某首歌的候选排名（调打分用）：
 *   node scripts/rank-debug.js 海阔天空 晴天
 */

const { BilibiliClient } = require('../src/bilibili/bili-api');
const { loadConfig } = require('../src/config');
const { Logger } = require('../src/lib/logger');

const logger = new Logger('rank', 'warn');

(async () => {
  const songs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!songs.length) {
    console.log('用法：node scripts/rank-debug.js 歌名 [歌名...]');
    return;
  }
  const config = loadConfig(process.argv.slice(2));
  const client = new BilibiliClient(config.bilibili, logger);
  console.log(`屏蔽词 ${config.bilibili.blacklistKeywords.length} 个，最低播放量 ${config.bilibili.minPlay}`);
  for (const song of songs) {
    const result = await client.searchSong(song, { noCache: true });
    console.log(`\n=== ${song} ===`);
    if (!result.candidates.length) {
      console.log(`  ❌ 没有候选：${result.error || '得分都不够'}`);
    }
    const top = result.candidates.length ? result.candidates : result.all.slice(0, 8);
    top.forEach((c, i) => {
      const tag = result.candidates.includes(c) ? '候选' : '被过滤';
      console.log(
        `  ${String(i + 1).padStart(2)}. [${String(Math.round(c.score)).padStart(4)}] ${tag} ${c.title.slice(0, 52)}` +
          `\n      ${c.author || ''} | ${c.duration}s | ${c.play} 播放 | ${c.reasons.join('/')}`
      );
    });
  }
})().catch((err) => console.error('出错：', err.message));
