'use strict';
/**
 * 实测「垫播被打断后，下次空闲接着上次的位置放」。
 *
 * 需求原话：「没人点歌切回去的时候不要从头开始放，要接着断开的地方接着放」
 *
 * 【测试策略】
 * 不去等引擎的自动重播时序（那个受 songGapMs / delayMs / 队列状态影响，很容易测飘），
 * 而是直接驱动 IdlePlayer 的关键环节，验证数据流：
 *   1. 播放页上报进度 → entry.resumeAt 被记住
 *   2. 垫播被打断 → IdlePlayer 存下 { bvid, resumeAt }
 *   3. 下次 _fillOnce → 走"恢复"分支，并且 requestSong 带上 resumeAt
 *   4. buildPlayPayload 把 resumeAt 放进 payload（播放页据此 seek）
 *   5. 恢复一次后记录清空，不会反复回到同一首
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
  const config = {
    ...base,
    idlePlay: { enabled: true, singers: ['周杰伦'], delayMs: 1500, checkEveryMs: 500, maxPerRound: 20 },
    playback: { ...(base.playback || {}), songGapMs: 200 },
  };
  const logger = new Logger('t', 'error');
  const bili = new BilibiliClient(config.bilibili || {}, logger);
  const engine = new PlaybackEngine({ config, bili, logger });
  const idle = new IdlePlayer(config, { bili, logger, engine });
  engine.idlePlayer = idle;

  // 捕获每次发给播放页的 payload
  const payloads = [];
  engine.on('play', (p) => payloads.push({ ...p }));

  console.log('════ 垫播「接着放」实测 ════');
  console.log('');

  // ── 准备：先把合集曲库拉好 ──
  await idle._loadPlaylist();
  check('曲库已就绪', idle.playlist.length > 0, idle.playlist.length + ' 首');
  console.log('');

  // ── 1) 手动垫一首，模拟播放页上报进度 ──
  console.log('【1】垫一首并上报进度');
  await idle._fillOnce();
  await wait(1500);
  const first = engine.current;
  check('垫播已开始', Boolean(first && first.idle), first ? first.song : '(空)');
  if (!first) {
    console.log('  后续测试无法继续');
    process.exit(1);
  }
  const firstBvid = first.pick && first.pick.bvid;

  const FAKE_POS = 47;
  engine.onProgress(first.id, 5); // 模拟连续上报
  engine.onProgress(first.id, 23);
  engine.onProgress(first.id, FAKE_POS);
  check('进度被记住', first.resumeAt === FAKE_POS, 'entry.resumeAt = ' + first.resumeAt);
  console.log('');

  // ── 2) 有人点歌 → 打断，位置应被存下来 ──
  console.log('【2】有人点歌打断');
  engine.emit('song-requested', { song: '晴天', nickname: '观众' });
  idle.noteRealSong();
  const saved = idle.interrupted;
  check('存下了中断位置', Boolean(saved), saved ? saved.song + ' 第 ' + saved.resumeAt + ' 秒' : '没存');
  check('记住的是同一首', Boolean(saved && saved.bvid === firstBvid), (saved && saved.bvid) + ' vs ' + firstBvid);
  check('位置正确', Boolean(saved && saved.resumeAt === FAKE_POS), String(saved && saved.resumeAt));

  // 清掉当前（模拟真的被切走了）
  engine.current = null;
  await wait(500);
  console.log('');

  // ── 3) 下次垫播应该"恢复"而不是取新曲 ──
  console.log('【3】下次垫播应走恢复分支');
  payloads.length = 0;
  const beforeCursor = idle.cursor;
  await idle._fillOnce();
  await wait(1500);
  const resumedEntry = engine.current;
  check('又垫回来了', Boolean(resumedEntry && resumedEntry.idle), resumedEntry ? resumedEntry.song : '(空)');
  check(
    '是同一首（不是新曲）',
    Boolean(resumedEntry && resumedEntry.pick && resumedEntry.pick.bvid === firstBvid),
    resumedEntry && resumedEntry.pick ? String(resumedEntry.pick.bvid) : '?'
  );
  check('传给 requestSong 的 resumeAt 正确', Number(resumedEntry && resumedEntry.resumeAt) === FAKE_POS, String(resumedEntry && resumedEntry.resumeAt));
  check('没有推进曲库游标（因为没取新曲）', idle.cursor === beforeCursor, 'cursor ' + beforeCursor + ' → ' + idle.cursor);
  console.log('');

  // ── 4) payload 里要带上 resumeAt（播放页据此 seek） ──
  console.log('【4】发给播放页的 payload');
  const last = payloads[payloads.length - 1] || {};
  check('payload.resumeAt 存在且正确', Number(last.resumeAt) === FAKE_POS, String(last.resumeAt));
  check('payload.id 是这次恢复的条目', last.id === (resumedEntry && resumedEntry.id), String(last.id));
  console.log('');

  // ── 5) 恢复一次后记录清空，不该反复回到同一首 ──
  console.log('【5】恢复后不该反复回到同一首');
  check('中断记录已清空', idle.interrupted === null, String(idle.interrupted));
  engine.current = null;
  await idle._fillOnce();
  await wait(1200);
  const third = engine.current;
  /**
   * 注意：不能用 bvid 判断"是不是同一首" ——
   * 合集里多个分P**共用一个 bvid**（「周杰伦全MV【200P】」20 首都用它），
   * 要靠 page（分P号）区分。
   */
  const firstPage = first.pick && first.pick.page;
  const thirdPage = third && third.pick && third.pick.page;
  check(
    '这次取的是新曲（分P号不同）',
    Boolean(third && thirdPage !== firstPage),
    `page ${firstPage} → ${thirdPage}（${third ? third.song : '(空)'}）`
  );
  console.log('');

  // ── 6) 放了几秒就切走的不记（续播不如从头放） ──
  console.log('【6】只放了几秒就切走 → 不记续播');
  idle.interrupted = null;
  if (third) {
    engine.onProgress(third.id, 2); // 才 2 秒
    idle.rememberInterrupted(third);
    check('2 秒不记续播', idle.interrupted === null, String(idle.interrupted));
  }
  console.log('');

  const st = idle.getState();
  console.log('════════════════════');
  console.log('  垫播 ' + st.stats.filled + ' 次   续播 ' + st.stats.resumed + ' 次');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  console.log('════════════════════');
  idle.stop();
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => process.exit(), 1200);
})().catch((e) => {
  console.log('!! ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
