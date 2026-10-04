'use strict';
/**
 * 实测「开启服务时立刻开始垫播」。
 *
 * 需求原话：「开启服务时，直接先播放垫播的，有人点歌再进行正常流程」
 *
 * 检查：
 *   1. start() 之后多久开始出声（应该只是加载合集的时间，不再干等 delayMs）
 *   2. 点歌能正常打断
 *   3. 打断后回到垫播时，仍然遵守 delayMs（点歌间隙不该疯狂插歌）
 */
const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { PlaybackEngine } = require('../src/player/player');
const { IdlePlayer } = require('../src/player/idle');
const { Logger } = require('../src/lib/logger');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log('  ✅ ' + name + (detail ? '  ' + detail : ''));
  } else {
    fail += 1;
    console.log('  ❌ ' + name + (detail ? '  → ' + detail : ''));
  }
};

(async () => {
  const base = loadConfig([]);
  // delayMs 特意设大（10 秒），这样"启动立刻播"和"等 10 秒"能明显区分开
  const DELAY = 10000;
  const config = {
    ...base,
    idlePlay: { enabled: true, singers: ['周杰伦'], delayMs: DELAY, checkEveryMs: 500, maxPerRound: 20 },
    playback: { ...(base.playback || {}), songGapMs: 200 },
  };
  const logger = new Logger('t', 'info');
  const bili = new BilibiliClient(config.bilibili || {}, logger.child('bili'));
  const engine = new PlaybackEngine({ config, bili, logger: logger.child('p') });
  const idle = new IdlePlayer(config, { bili, logger: logger.child('i'), engine });
  engine.on('song-requested', () => idle.noteRealSong());
  engine.idlePlayer = idle;

  console.log('════ 启动即垫播 实测 ════');
  console.log(`  delayMs = ${DELAY}ms（故意设大，好区分）`);
  console.log('');

  // ── 1) start 之后多久出声 ──
  console.log('【1】start() 之后多久开始垫播');
  const t0 = Date.now();
  idle.start();
  let firstAt = 0;
  for (let i = 0; i < 200; i += 1) {
    await wait(200);
    if (engine.current && engine.current.idle) {
      firstAt = Date.now() - t0;
      break;
    }
  }
  check('启动了垫播', firstAt > 0, firstAt ? firstAt + 'ms' : '60 秒内没开始');
  if (firstAt > 0) {
    // 关键断言：必须远小于 delayMs（否则说明还在干等）
    check(
      '没有干等 delayMs（' + DELAY + 'ms）',
      firstAt < DELAY,
      firstAt + 'ms < ' + DELAY + 'ms'
    );
    console.log('     当前：' + engine.current.song);
  }
  console.log('');

  // ── 2) 有人点歌能正常打断 ──
  console.log('【2】有人点歌，走正常流程');
  const t1 = Date.now();
  let stopAt = 0;
  const onCmd = (c) => {
    if (c.cmd === 'stop' && !stopAt) stopAt = Date.now();
  };
  engine.on('command', onCmd);
  await engine.requestSong({ song: '晴天', nickname: '观众', userId: 'u1', force: true });
  await wait(4000);
  engine.off('command', onCmd);
  const cur = engine.current;
  check('切到了观众点的歌', Boolean(cur && !cur.idle), cur ? cur.song : '(空)');
  check('打断及时（<1 秒）', stopAt > 0 && stopAt - t1 < 1000, stopAt ? stopAt - t1 + 'ms' : '没收到 stop');
  console.log('');

  // ── 3) 打断后回到垫播，仍应遵守 delayMs ──
  console.log('【3】观众那首播完后，回垫播仍遵守 delayMs（不疯狂插歌）');
  /**
   * 【计时基准要用引擎内部的 lastActivityAt】
   *
   * 外面测不准：`finishCurrent` 的调用时刻、以及"点歌"真正被记下的时刻
   * 之间差着几百毫秒到两秒（requestSong 是异步的）。
   * 直接从 idle.lastActivityAt 推算才准 —— 那才是 _tick 实际比较的值。
   */
  const activityAt = idle.lastActivityAt;
  engine.finishCurrent('ended');
  let backAt = 0;
  for (let i = 0; i < 200; i += 1) {
    await wait(300);
    const c = engine.current;
    if (c && c.idle) {
      backAt = Date.now() - activityAt;
      break;
    }
  }
  check('回到了垫播', backAt > 0, backAt ? backAt + 'ms' : '60 秒内没回');
  if (backAt > 0) {
    // 必须 ≥ delayMs（这就是"点歌间隙不疯狂插歌"的保证）
    check(
      '从"有人点歌"到"回垫播" ≥ delayMs（' + DELAY + 'ms）',
      backAt >= DELAY,
      backAt + 'ms'
    );
    // 也不该等太久（检查周期 500ms + 播放间隔，3 秒余量足够）
    check(
      '也没有拖太久（< delayMs + 3 秒）',
      backAt < DELAY + 3000,
      backAt + 'ms'
    );
  }
  console.log('');

  const st = idle.getState();
  console.log('════════════════════');
  console.log('  垫播 ' + st.stats.filled + ' 次   打断 ' + st.stats.skippedForRealSong + ' 次   续播 ' + st.stats.resumed + ' 次');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('════════════════════');
  idle.stop();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(), 1500);
})().catch((e) => {
  console.log('!! ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
