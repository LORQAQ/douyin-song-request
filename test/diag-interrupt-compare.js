'use strict';
/**
 * 对比两种打断策略的实测数据：
 *
 *   方案 A（当前）：等新歌搜好了再切
 *     → 3 秒内垫播还在放，然后一次干净切换，中间无静音
 *
 *   方案 B：点歌瞬间就停垫播，搜好立刻播
 *     → 垫播立刻停（"立刻打断"的体感），但搜索期间有静音空档
 *
 * 把两种的真实数字都测出来，再决定用哪个。
 */
const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { PlaybackEngine } = require('../src/player/player');
const { IdlePlayer } = require('../src/player/idle');
const { Logger } = require('../src/lib/logger');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function scenario(stopImmediately) {
  const base = loadConfig([]);
  const config = {
    ...base,
    idlePlay: { enabled: true, singers: ['周杰伦'], delayMs: 1500, checkEveryMs: 500, maxPerRound: 20 },
    playback: { ...(base.playback || {}), songGapMs: 200 },
  };
  const logger = new Logger('t', 'error');
  const bili = new BilibiliClient(config.bilibili || {}, logger);
  const engine = new PlaybackEngine({ config, bili, logger });

  const t = { stopAt: 0, playAt: 0 };
  const idle = new IdlePlayer(config, { bili, logger, engine });

  engine.on('song-requested', () => {
    if (stopImmediately) {
      // 方案 B：先停垫播（会产生静音），再让流程继续
      idle.interruptForRealSong();
    } else {
      idle.noteRealSong();
    }
  });
  engine.on('command', (c) => {
    if (c.cmd === 'stop' && !t.stopAt) t.stopAt = Date.now();
  });
  engine.idlePlayer = idle;

  idle.start();
  let filled = null;
  for (let i = 0; i < 40; i += 1) {
    await wait(800);
    if (engine.current && engine.current.idle) {
      filled = engine.current;
      break;
    }
  }
  if (!filled) {
    idle.stop();
    return null;
  }

  const t0 = Date.now();
  await engine.requestSong({ song: '晴天', nickname: '观众', userId: 'u', force: true });
  for (let i = 0; i < 120; i += 1) {
    await wait(100);
    const cur = engine.current;
    if (cur && !cur.idle && /晴天/.test(cur.song)) {
      t.playAt = Date.now();
      break;
    }
  }
  idle.stop();
  return {
    stopDelay: t.stopAt ? t.stopAt - t0 : -1,
    playDelay: t.playAt ? t.playAt - t0 : -1,
    gap: t.stopAt && t.playAt ? t.playAt - t.stopAt : -1,
  };
}

(async () => {
  console.log('════ 两种打断策略实测对比 ════');
  console.log('');

  const a = await scenario(false);
  console.log('方案 A（等搜好再切，当前实现）');
  console.log('  垫播被停   : ' + (a ? '+' + a.stopDelay + 'ms' : '失败'));
  console.log('  新歌开始播 : ' + (a ? '+' + a.playDelay + 'ms' : '失败'));
  console.log('  静音空档   : ' + (a ? a.gap + 'ms' : '失败'));
  console.log('');

  const b = await scenario(true);
  console.log('方案 B（点歌瞬间停垫播）');
  console.log('  垫播被停   : ' + (b ? '+' + b.stopDelay + 'ms' : '失败'));
  console.log('  新歌开始播 : ' + (b ? '+' + b.playDelay + 'ms' : '失败'));
  console.log('  静音空档   : ' + (b ? b.gap + 'ms' : '失败'));
  console.log('');

  console.log('════════════════════════════');
  console.log('  A: 打断晚(' + (a ? a.stopDelay : '?') + 'ms) 但无静音');
  console.log('  B: 打断立刻(' + (b ? b.stopDelay : '?') + 'ms) 但静音 ' + (b ? b.gap : '?') + 'ms');
  console.log('════════════════════════════');
  process.exit(0);
})().catch((e) => {
  console.log('!! ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
