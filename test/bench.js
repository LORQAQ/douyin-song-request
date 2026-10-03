'use strict';

/**
 * 性能基准：把「每帧解码 / 每条弹幕 / 每次状态广播 / 内存」分别量化。
 *
 *   node test/bench.js
 *
 * 用真实结构的合成数据（不是随便造的字符串），所以数字有参考价值。
 */

const zlib = require('zlib');
const pb = require('../src/lib/protobuf');
const protocol = require('../src/danmaku/protocol');
const { PlaybackEngine } = require('../src/player/player');
const { Logger } = require('../src/lib/logger');

const logger = new Logger('bench', 'error');

/* ---------------------- 造一帧和真实结构一样的弹幕 ---------------------- */

function makeChatMessage(i) {
  const common = Buffer.concat([
    pb.encodeField(1, 'WebcastChatMessage'),
    pb.encodeVarintField(2, 7691962267278234687 + i),
    pb.encodeField(3, '7691953598460496682'),
    pb.encodeVarintField(4, 1790924500 + i),
  ]);
  const user = Buffer.concat([
    pb.encodeField(1, String(514219545985223 + i)),
    pb.encodeVarintField(2, 2825724622 + i),
    pb.encodeField(3, `观众${i}`),
    pb.encodeVarintField(4, 1 + (i % 30)),
  ]);
  const chat = Buffer.concat([
    pb.encodeField(1, common),
    pb.encodeField(2, user),
    pb.encodeField(3, `点歌 测试歌曲${i % 50}`),
  ]);
  return Buffer.concat([
    pb.encodeField(1, 'WebcastChatMessage'),
    pb.encodeField(2, zlib.gzipSync(chat)),
    pb.encodeVarintField(3, 7691962294088374057 + i),
  ]);
}

/** 非弹幕消息：真实直播间里数量远多于弹幕（进场/点赞/礼物/在线人数） */
function makeOtherMessage(i, method) {
  const payload = Buffer.concat([
    pb.encodeField(1, method),
    pb.encodeField(2, 'x'.repeat(120 + (i % 60))),
    pb.encodeVarintField(3, i),
  ]);
  return Buffer.concat([
    pb.encodeField(1, method),
    pb.encodeField(2, zlib.gzipSync(payload)),
    pb.encodeVarintField(3, 1000000 + i),
  ]);
}

/** 按真实比例造一帧：约 35% 弹幕，其余是进场/点赞/礼物等 */
function makeMixedFrame(total = 40) {
  const messages = [];
  for (let i = 0; i < total; i += 1) {
    const r = i % 20;
    if (r < 7) messages.push(makeChatMessage(i));
    else if (r < 13) messages.push(makeOtherMessage(i, 'WebcastMemberMessage'));
    else if (r < 17) messages.push(makeOtherMessage(i, 'WebcastLikeMessage'));
    else messages.push(makeOtherMessage(i, 'WebcastGiftMessage'));
  }
  const response = Buffer.concat([...messages.map((m) => pb.encodeField(1, m)), pb.encodeField(2, 't-1_r-2_d-1_u-1_h-1')]);
  return Buffer.concat([
    pb.encodeVarintField(1, 1),
    pb.encodeVarintField(2, 835018330400981667),
    pb.encodeVarintField(7, 0),
    pb.encodeField(8, zlib.gzipSync(response)),
  ]);
}

function makeFrame(count = 20) {
  const messages = [];
  for (let i = 0; i < count; i += 1) messages.push(makeChatMessage(i));
  const response = Buffer.concat([...messages.map((m) => pb.encodeField(1, m)), pb.encodeField(2, 't-1_r-2_d-1_u-1_h-1')]);
  return Buffer.concat([
    pb.encodeVarintField(1, 1),
    pb.encodeVarintField(2, 835018330400981667),
    pb.encodeVarintField(7, 0),
    pb.encodeField(8, zlib.gzipSync(response)),
  ]);
}

/* ------------------------------ 测量工具 ------------------------------ */

function mb(bytes) {
  return (bytes / 1048576).toFixed(2);
}

async function measureMemory(label) {
  if (global.gc) {
    global.gc();
    await new Promise((r) => setTimeout(r, 50));
    global.gc();
  }
  const m = process.memoryUsage();
  return { label, heap: m.heapUsed, rss: m.rss };
}

function timeIt(label, iterations, fn) {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) fn(i);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { label, iterations, ms, perOp: (ms / iterations) * 1000 };
}

/* --------------------------------- 跑 --------------------------------- */

(async () => {
  const results = [];
  const before = await measureMemory('start');

  /* 1) 弹幕帧解码 */
  const frame = makeFrame(20);
  const decoded = protocol.decodePushFrame(frame);
  const response = protocol.decodeResponse(decoded.payload);
  const messageCount = response.messages.length;

  const decodeBench = timeIt('解一帧纯弹幕(20条)', 300, () => {
    const f = protocol.decodePushFrame(frame);
    protocol.decodeResponse(f.payload, { decompressOthers: false });
  });
  results.push({ ...decodeBench, note: `${messageCount} 条/帧` });

  /* 1b) 真实比例的混合帧 */
  const mixed = makeMixedFrame(40);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 300; i += 1) {
    const f = protocol.decodePushFrame(mixed);
    protocol.decodeResponse(f.payload, { decompressOthers: false });
  }
  const mixedSkipUs = Number(process.hrtime.bigint() - t0) / 1000 / 300;
  const t1 = process.hrtime.bigint();
  for (let i = 0; i < 300; i += 1) {
    const f = protocol.decodePushFrame(mixed);
    protocol.decodeResponse(f.payload, { decompressOthers: true });
  }
  const mixedAllUs = Number(process.hrtime.bigint() - t1) / 1000 / 300;
  results.push({
    label: '解一帧混合消息(40条)',
    iterations: 300,
    ms: mixedSkipUs * 0.3,
    perOp: mixedSkipUs,
    note: `只解弹幕 ${mixedSkipUs.toFixed(0)}µs vs 全解压 ${mixedAllUs.toFixed(0)}µs（省 ${(
      (1 - mixedSkipUs / mixedAllUs) *
      100
    ).toFixed(0)}%）`,
  });

  /* 2) 单条消息解析成弹幕对象 */
  const chatBench = timeIt('解析一条弹幕', 3000, () => {
    const f = protocol.decodePushFrame(frame);
    const r = protocol.decodeResponse(f.payload, { decompressOthers: false });
    for (const m of r.messages) protocol.decodeMessage(m);
  });
  results.push({ ...chatBench, note: `${messageCount} 条/次` });

  /* 3) 引擎处理弹幕 */
  const fakeBili = {
    async pickForSong(song) {
      return {
        ok: true,
        song,
        pick: {
          bvid: 'BV1TEST', title: `${song} MV`, cleanTitle: song, owner: 'UP',
          duration: 240, play: 100000, score: 120, pic: '', pageUrl: 'u', embedUrl: 'e', cid: 1,
        },
        alternatives: [],
      };
    },
    async getVideoInfo() { return { cid: 1, duration: 240, owner: 'UP' }; },
    async resolveAudioStream() { return { url: 'u', backups: [], expireAt: Date.now() + 3600e3 }; },
    getPageUrl: (b) => b,
    getEmbedUrl: (b) => b,
  };
  const config = {
    playback: { mode: 'queue', useDirectStream: true, volume: 0.8, songGapMs: 1, maxQueueSize: 50 },
    trigger: { keywords: ['点歌'], requireKeyword: true, stripWords: ['点歌'], minLength: 2, maxLength: 40, rejectIfContains: [] },
    filter: { sameSongWindowMs: 0, perUserCooldownMs: 0, maxQueuePerUser: 50 },
    bilibili: {},
    audioPage: {},
  };
  const engine = new PlaybackEngine({ config, bili: fakeBili, logger });

  const engineBench = timeIt('引擎处理弹幕(含状态广播)', 2000, (i) => {
    engine.recentChats.length = 0; // 只测处理成本
    engine.handleChat({ content: `点歌 歌${i % 50}`, nickname: `观众${i}`, userId: `u${i % 30}` });
  });
  results.push({ ...engineBench, note: '含每次 state 事件' });

  /* 4) 状态序列化（广播的关键成本） */
  for (let i = 0; i < 60; i += 1) {
    engine.queue.push(engine.queue.createEntry({ song: `排队歌${i}`, nickname: 'u', userId: `u${i}` }));
  }
  const stateBench = timeIt('getState 序列化', 1000, () => engine.getState());
  const state = engine.getState();
  const stateJson = JSON.stringify({ type: 'state', state });
  results.push({ ...stateBench, note: `JSON ${(stateJson.length / 1024).toFixed(1)} KB` });

  /* 5) 广播成本（JSON 序列化 + 发送前的字符串化） */
  const broadcastBench = timeIt('一次广播的 JSON 化', 1000, () => JSON.stringify({ type: 'state', state: engine.getState() }));
  results.push({ ...broadcastBench, note: `${(stateJson.length / 1024).toFixed(1)} KB/次` });

  /* 6) 弹幕缓存上限是否生效 */
  engine.recentChats.length = 0;
  for (let i = 0; i < 5000; i += 1) {
    engine.handleChat({ content: `点歌 压力${i % 50}`, nickname: `n${i % 20}`, userId: `u${i % 30}` });
  }
  const after = await measureMemory('after 5000 弹幕');
  results.push({ label: '内存(5000 弹幕后)', iterations: 0, ms: 0, perOp: 0, note: `heap ${mb(after.heap)} MB / RSS ${mb(after.rss)} MB` });

  /* 输出 */
  console.log('\n=== 性能基准 ===\n');
  console.log('  项目                             次数      总耗时      单次');
  console.log('  ---------------------------------------------------------------');
  for (const r of results) {
    if (!r.iterations) continue;
    console.log(
      `  ${r.label.padEnd(30)} ${String(r.iterations).padStart(6)}  ${(r.ms.toFixed(0) + ' ms').padStart(9)}  ${r.perOp.toFixed(1).padStart(7)} µs   ${r.note}`
    );
  }
  console.log('');
  for (const r of results) {
    if (r.iterations) continue;
    console.log(`  ${r.label}: ${r.note}`);
  }
  console.log('');
  console.log(`  起始内存 : heap ${mb(before.heap)} MB / RSS ${mb(before.rss)} MB`);
  console.log(`  弹幕缓存 : recentChats=${engine.recentChats.length}（上限 30）`);
  console.log(`  队列     : ${engine.queue.size}（上限 50）/ 历史 ${engine.queue.history.length}（上限 50）`);
  console.log(`  待重试   : ${engine.pendingRetries.length}`);
  console.log('');
  console.log('  提示：加 --expose-gc 会让内存数字更准（node --expose-gc test/bench.js）');
  process.exit(0);
})().catch((err) => {
  console.error('基准失败：', err.stack || err.message);
  process.exit(1);
});
