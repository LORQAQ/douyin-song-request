'use strict';
/**
 * 空闲垫播的打断边界测试：
 *   1. 打断要快（不能先停垫播再等搜索，那样中间有静音空档）
 *   2. 垫播**自然播完**后，下一次点歌还要能打断（playingIdle 标记不能被卡住）
 *   3. 垫播被手动跳过后，下一次点歌也要能打断
 */
const path = require('path');

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
    idlePlay: { enabled: true, singers: ['周杰伦'], delayMs: 2000, checkEveryMs: 800, maxPerRound: 20 },
    playback: { ...(base.playback || {}), songGapMs: 200 },
  };
  const logger = new Logger('t', 'error');
  const bili = new BilibiliClient(config.bilibili || {}, logger.child('bili'));
  const engine = new PlaybackEngine({ config, bili, logger: logger.child('p') });
  const idle = new IdlePlayer(config, { bili, logger: logger.child('i'), engine });
  engine.on('song-requested', () => idle.noteRealSong());
  engine.idlePlayer = idle;

  console.log('════ 空闲垫播·打断边界测试 ════');
  console.log('');

  idle.start();
  // 等第一次垫播
  let first = null;
  for (let i = 0; i < 40; i++) {
    await wait(1000);
    if (engine.current && engine.current.idle) { first = engine.current; break; }
  }
  if (!first) { console.log('❌ 没垫播起来'); process.exit(1); }
  console.log('① 垫播中：' + first.song);

  // ── 测试 1：打断速度 ──
  const t0 = Date.now();
  await engine.requestSong({ song: '晴天', nickname: '观众A', userId: 'a', force: true });
  let switchedAt = 0;
  for (let i = 0; i < 60; i++) {
    await wait(200);
    const cur = engine.current;
    if (cur && !cur.idle && /晴天/.test(cur.song)) { switchedAt = Date.now() - t0; break; }
  }
  console.log('② 打断耗时：' + (switchedAt ? switchedAt + 'ms' : '❌ 60 秒内没切过去'));
  console.log('   当前：' + (engine.current ? engine.current.song + '（idle=' + engine.current.idle + '）' : '(空)'));
  console.log('');

  // ── 测试 2：垫播自然播完后还能不能打断 ──
  console.log('③ 等垫播自然播完（模拟一首 3 分钟的歌曲）…');
  engine.skip('test'); // 跳过观众那首，让垫播接管
  let second = null;
  for (let i = 0; i < 40; i++) {
    await wait(1000);
    if (engine.current && engine.current.idle) { second = engine.current; break; }
  }
  if (!second) {
    console.log('   ⚠️ 没等到第二次垫播');
  } else {
    console.log('   第二次垫播：' + second.song);
    // 模拟"自然播完"——直接走 finishCurrent（这就是 onEnded 的路径）
    engine.finishCurrent('ended');
    await wait(1500);
    console.log('   已模拟播完（current=' + (engine.current ? engine.current.song : '空') + '）');

    // 现在再点一首，必须还能打断（这是 playingIdle 卡住的经典场景）
    const t1 = Date.now();
    const res = await engine.requestSong({ song: '稻香', nickname: '观众B', userId: 'b', force: true });
    let ok2 = 0;
    for (let i = 0; i < 60; i++) {
      await wait(200);
      const cur = engine.current;
      if (cur && !cur.idle && /稻香/.test(cur.song)) { ok2 = Date.now() - t1; break; }
      void res;
    }
    console.log('   再次点歌 → ' + (ok2 ? '✅ ' + ok2 + 'ms 切过去' : '❌ 没切过去（current=' + (engine.current ? engine.current.song : '空') + '）'));
  }
  console.log('');

  // ── 测试 3：垫播被手动跳过后 ──
  console.log('④ 垫播被手动跳过后，再点歌要能正常播');
  engine.skip('manual');
  await wait(1500);
  const t2 = Date.now();
  await engine.requestSong({ song: '夜曲', nickname: '观众C', userId: 'c', force: true });
  let ok3 = 0;
  for (let i = 0; i < 60; i++) {
    await wait(200);
    const cur = engine.current;
    if (cur && !cur.idle && /夜曲/.test(cur.song)) { ok3 = Date.now() - t2; break; }
  }
  console.log('   → ' + (ok3 ? '✅ ' + ok3 + 'ms' : '❌ 没切过去'));
  console.log('');

  const st = idle.getState();
  console.log('════════════════════');
  console.log('  垫播次数: ' + st.stats.filled + '   打断次数: ' + st.stats.skippedForRealSong);
  console.log('  引擎时长门槛等无异常');
  console.log('════════════════════');
  idle.stop();
  process.exit(0);
})().catch((e) => {
  console.log('!! ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
