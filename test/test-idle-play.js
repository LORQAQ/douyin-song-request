'use strict';
/**
 * 实测空闲垫播：
 *   1. 没人点歌 → 自动垫播
 *   2. 有人点歌 → 立刻打断垫播、切到观众点的歌
 *   3. 队列空了 → 继续垫播
 *
 * 用短 delayMs 加速（真实配置是 8 秒）。
 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'idle-test.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

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
    idlePlay: { enabled: true, singers: ['周杰伦'], delayMs: 3000, checkEveryMs: 1000, maxPerRound: 5 },
    playback: { ...(base.playback || {}), songGapMs: 300 },
  };

  const logger = new Logger('idle', 'info');
  const bili = new BilibiliClient(config.bilibili || {}, logger.child('bili'));
  const engine = new PlaybackEngine({ config, bili, logger: logger.child('player') });
  const idle = new IdlePlayer(config, { bili, logger: logger.child('idle'), engine });
  engine.on('song-requested', () => idle.noteRealSong());
  engine.idlePlayer = idle;

  log('════════ 空闲垫播实测 ════════');
  log('  配置: 歌手=' + JSON.stringify(config.idlePlay.singers) +
      '  延迟=' + config.idlePlay.delayMs + 'ms  轮次上限=' + config.idlePlay.maxPerRound);
  log('');

  // ── 阶段 1：没人点歌，应该自动垫播 ──
  log('【阶段 1】不点歌，等它自动垫播…');
  idle.start();
  let filled = null;
  for (let i = 0; i < 60; i += 1) {
    await wait(1000);
    if (engine.current && engine.current.idle) {
      filled = engine.current;
      break;
    }
  }
  if (!filled) {
    log('  ❌ 等了 60 秒也没自动垫播');
    log('     垫播状态: ' + JSON.stringify(idle.getState()));
    process.exit(1);
  }
  log('  ✅ 自动垫播了：' + filled.song);
  log('     ' + String((filled.pick && filled.pick.title) || '').slice(0, 56));
  log('     idle 标记=' + filled.idle + '   队列长度=' + engine.queue.items.length);
  log('');

  // ── 阶段 2：有人点歌，应该打断垫播 ──
  log('【阶段 2】模拟有人点歌「晴天」，应该打断垫播');
  const beforeSong = filled.song;
  await engine.requestSong({ song: '晴天', nickname: '测试观众', userId: 't1', force: true });

  let switched = null;
  for (let i = 0; i < 40; i += 1) {
    await wait(1000);
    const cur = engine.current;
    if (cur && !cur.idle && /晴天/.test(cur.song)) {
      switched = cur;
      break;
    }
  }
  if (switched) {
    log('  ✅ 已切到观众点的歌：' + switched.song);
    log('     ' + String((switched.pick && switched.pick.title) || '').slice(0, 56));
    log('     打断统计=' + JSON.stringify(idle.getState().stats));
  } else {
    log('  ❌ 没切过去，当前：' + (engine.current ? engine.current.song + '（idle=' + engine.current.idle + '）' : '(空)'));
  }
  log('');

  // ── 阶段 3：观众的歌播完后，空闲下来应该继续垫播 ──
  log('【阶段 3】跳过观众那首，空闲后应继续垫播');
  engine.skip('test');
  let filled2 = null;
  for (let i = 0; i < 40; i += 1) {
    await wait(1000);
    if (engine.current && engine.current.idle) {
      filled2 = engine.current;
      break;
    }
  }
  if (filled2) {
    log('  ✅ 继续垫播：' + filled2.song);
  } else {
    log('  ⚠️ 没继续垫播，当前：' + (engine.current ? engine.current.song : '(空)'));
  }
  log('');

  const st = idle.getState();
  log('════════════════════════════');
  log('  垫播次数  : ' + st.stats.filled);
  log('  打断次数  : ' + st.stats.skippedForRealSong);
  log('  曲库就绪  : ' + st.ready + ' 首');
  log('  当前是垫播: ' + st.playingIdle);
  log('════════════════════════════');
  idle.stop();
  process.exit(0);
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
