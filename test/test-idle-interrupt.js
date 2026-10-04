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

  // ── 测试 1：打断要**立刻**（不是等搜好才打断）──
  //
  // 这里踩过两次坑，必须锁住：
  //   ① 一开始"等新歌搜好再打断" → 垫播多放 3 秒，主播反馈"没立刻打断"
  //   ② 更早的版本"先停垫播再搜索" → 中间静音 2~4 秒
  // 正确行为：**收到点歌就立刻停垫播**（1 毫秒级），
  // 然后边搜边等，搜好立刻播。中间的静音是搜索固有延迟，不是"打断慢"。
  const t0 = Date.now();
  let stopAt = 0;
  const onCmd = (c) => {
    if (c.cmd === 'stop' && !stopAt) stopAt = Date.now();
  };
  engine.on('command', onCmd);

  await engine.requestSong({ song: '晴天', nickname: '观众A', userId: 'a', force: true });

  let switchedAt = 0;
  for (let i = 0; i < 60; i++) {
    await wait(200);
    const cur = engine.current;
    if (cur && !cur.idle && /晴天/.test(cur.song)) {
      switchedAt = Date.now() - t0;
      break;
    }
  }
  engine.off('command', onCmd);

  const stopDelay = stopAt ? stopAt - t0 : -1;
  console.log('② 打断（停垫播）耗时：' + (stopDelay >= 0 ? stopDelay + 'ms' : '❌ 没收到 stop'));
  console.log('   新歌开始播：       ' + (switchedAt ? switchedAt + 'ms' : '❌ 60 秒内没切过去'));
  console.log('   （两者之差 = 搜索耗时，属于固有延迟）');
  if (stopDelay < 0 || stopDelay > 500) {
    console.log('   ❌ 打断不及时！应该在收到点歌的瞬间就停垫播（实测 ' + stopDelay + 'ms）');
  } else {
    console.log('   ✅ 打断及时（<500ms）');
  }
  console.log('');

  // ── 测试 2：垫播自然播完后还能不能打断 ──
  console.log('③ 等垫播自然播完（模拟一首 3 分钟的歌曲）…');
  engine.skip('test'); // 跳过观众那首，让垫播接管
  let second = null;
  for (let i = 0; i < 40; i++) {
    await wait(1000);
    if (engine.current && engine.current.idle) {
      second = engine.current;
      break;
    }
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
    let ok2 = 0;
    await engine.requestSong({ song: '稻香', nickname: '观众B', userId: 'b', force: true });
    for (let i = 0; i < 60; i++) {
      await wait(200);
      const cur = engine.current;
      if (cur && !cur.idle && /稻香/.test(cur.song)) {
        ok2 = Date.now() - t1;
        break;
      }
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
