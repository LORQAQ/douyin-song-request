'use strict';
/**
 * 精确测「垫播中有人点歌」的切换时序。
 *
 * 记录每一步的毫秒时间戳，看"立刻"到底慢在哪：
 *   点歌 → 垫播被停 → 新歌解析完 → 新歌真正开始播
 */
const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { PlaybackEngine } = require('../src/player/player');
const { IdlePlayer } = require('../src/player/idle');
const { Logger } = require('../src/lib/logger');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const base = loadConfig([]);
  const config = {
    ...base,
    idlePlay: { enabled: true, singers: ['周杰伦'], delayMs: 2000, checkEveryMs: 600, maxPerRound: 20 },
    playback: { ...(base.playback || {}), songGapMs: 200 },
  };
  const logger = new Logger('t', 'info');

  // 记录每一步
  const events = [];
  const T0 = () => Date.now();

  const bili = new BilibiliClient(config.bilibili || {}, logger.child('bili'));
  const engine = new PlaybackEngine({ config, bili, logger: logger.child('p') });
  const idle = new IdlePlayer(config, { bili, logger: logger.child('i'), engine });
  engine.on('song-requested', () => {
    events.push(['song-requested 事件', T0()]);
    idle.noteRealSong();
  });
  engine.idlePlayer = idle;

  // 监听关键状态变化
  engine.on('command', (c) => events.push(['命令 ' + c.cmd, T0()]));
  engine.on('state', () => {
    const cur = engine.current;
    events.push(['状态 current=' + (cur ? (cur.idle ? '[垫播]' : '[观众]') + cur.song : '空'), T0()]);
  });

  console.log('════ 垫播 → 点歌 切换时序 ════');
  console.log('');

  idle.start();
  let filled = null;
  for (let i = 0; i < 40; i += 1) {
    await wait(1000);
    if (engine.current && engine.current.idle) {
      filled = engine.current;
      break;
    }
  }
  if (!filled) {
    console.log('❌ 没垫播起来');
    process.exit(1);
  }
  console.log('垫播中：' + filled.song);
  console.log('');

  // 清空记录，只看点歌这一刻
  events.length = 0;
  const t0 = T0();
  console.log('>>> 此刻收到点歌「晴天」');
  await engine.requestSong({ song: '晴天', nickname: '观众', userId: 'u1', force: true });

  let startedAt = 0;
  for (let i = 0; i < 100; i += 1) {
    await wait(100);
    const cur = engine.current;
    if (cur && !cur.idle && /晴天/.test(cur.song) && cur.status === 'playing') {
      startedAt = T0() - t0;
      break;
    }
  }

  console.log('');
  console.log('=== 时间线（相对点歌时刻的毫秒）===');
  for (const [what, at] of events) {
    console.log('  +' + String(at - t0).padStart(5) + 'ms  ' + what);
  }
  console.log('');
  console.log('新歌真正开始播: ' + (startedAt ? '+' + startedAt + 'ms' : '❌ 10 秒内没开始'));
  console.log('');
  console.log('说明：');
  console.log('  · 如果「垫播被停」和「新歌开始」之间差很大 → 中间有静音空档');
  console.log('  · 如果「song-requested 事件」来得晚 → 打断被推迟了');

  idle.stop();
  process.exit(0);
})().catch((e) => {
  console.log('!! ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
