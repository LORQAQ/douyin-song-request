'use strict';

/**
 * 压力测试：模拟一场热闹的直播，看点歌系统会不会崩、内存会不会涨。
 *
 *   node test/stress.js            1000 条弹幕（默认）
 *   node test/stress.js 5000       自定义条数
 *
 * 不联网：B站客户端是假的，专门测队列/去重/冷却/内存。
 */

const { PlaybackEngine } = require('../src/player/player');
const { Logger } = require('../src/lib/logger');

const TOTAL = Number(process.argv[2]) || 1000;
const SONG_POOL = [
  '晴天', '七里香', '稻香', '告白气球', '海阔天空', '光辉岁月', '漠河舞厅', '孤勇者',
  '夜空中最亮的星', '起风了', '光年之外', '演员', '消愁', '成都', '理想', '平凡之路',
  '后来', '匆匆那年', '小幸运', '体面', '遥远的她', '红玫瑰', '浮夸', '富士山下',
];
const NICKS = ['小明', '小红', '阿伟', '路人甲', '观众乙', 'DJ小王', '老张', '喵喵', '大风车', '土豆'];

const fakeBili = {
  async pickForSong(song) {
    return {
      ok: true,
      song,
      pick: {
        bvid: `BV${song.length}TEST`,
        title: `${song} 官方MV`,
        cleanTitle: song,
        owner: '测试UP',
        duration: 240,
        play: 100000 + Math.floor(Math.random() * 900000),
        score: 120,
        pic: '',
        pageUrl: `https://www.bilibili.com/video/BV${song.length}TEST`,
        embedUrl: 'https://player.bilibili.com/player.html',
        cid: 1,
      },
      alternatives: [],
    };
  },
  async getVideoInfo() {
    return { cid: 1, duration: 240, owner: '测试UP' };
  },
  async resolveAudioStream() {
    return { url: 'https://example.com/a.m4s', backups: [], expireAt: Date.now() + 3600000 };
  },
  getPageUrl: (b) => `https://www.bilibili.com/video/${b}`,
  getEmbedUrl: (b) => `https://player.bilibili.com/embed/${b}`,
};

const config = {
  playback: { mode: 'queue', useDirectStream: true, volume: 0.8, songGapMs: 1, maxQueueSize: 50 },
  trigger: { keywords: ['点歌'], requireKeyword: true, stripWords: ['点歌'], minLength: 2, maxLength: 40, rejectIfContains: [] },
  filter: { sameSongWindowMs: 0, perUserCooldownMs: 0, maxQueuePerUser: 50 },
  bilibili: {},
  audioPage: {},
};

const logger = new Logger('stress', 'error');
const engine = new PlaybackEngine({ config, bili: fakeBili, logger });

let played = 0;
let ended = 0;
engine.on('play', () => {
  played += 1;
});

const heapStart = process.memoryUsage().heapUsed;
const start = Date.now();

// 立刻把播放中的歌标记为播完，让队列一直流动
const pump = setInterval(() => {
  if (engine.current) {
    engine.finishCurrent('ended');
    ended += 1;
  }
}, 5);

for (let i = 0; i < TOTAL; i += 1) {
  const song = SONG_POOL[i % SONG_POOL.length];
  const nick = NICKS[i % NICKS.length];
  // 让部分弹幕带上花式写法，顺便压一压解析器
  const variants = [`点歌 ${song}`, `主播来一首《${song}》吧`, `点歌${song}`, ` 点歌 ${song}！`];
  engine.handleChat({
    content: variants[i % variants.length],
    nickname: `${nick}${i % 7}`,
    userId: `u${i % 40}`,
  });
}

setTimeout(() => {
  clearInterval(pump);
  const heapEnd = process.memoryUsage().heapUsed;
  const seconds = (Date.now() - start) / 1000;
  const growth = (heapEnd - heapStart) / 1048576;

  console.log(`\n=== 压力测试结果（${TOTAL} 条弹幕）===`);
  console.log(`  耗时            : ${seconds.toFixed(1)}s（${Math.round(TOTAL / seconds)} 条/秒）`);
  console.log(`  看到弹幕        : ${engine.stats.chatSeen}`);
  console.log(`  触发点歌        : ${engine.stats.requests}`);
  console.log(`  被过滤(去重/冷却): ${engine.stats.rejected}`);
  console.log(`  开始播放        : ${played}`);
  console.log(`  播放结束        : ${ended}`);
  console.log(`  当前队列长度    : ${engine.queue.size}（上限 50）`);
  console.log(`  历史长度        : ${engine.queue.history.length}（上限 50）`);
  console.log(`  最近弹幕缓存    : ${engine.recentChats.length}（上限 30）`);
  console.log(`  堆内存增长      : ${growth >= 0 ? '+' : ''}${growth.toFixed(1)} MB`);

  const problems = [];
  if (engine.queue.size > 50) problems.push('队列超过上限');
  if (engine.queue.history.length > 50) problems.push('历史超过上限');
  if (engine.recentChats.length > 30) problems.push('弹幕缓存超过上限');
  if (growth > 80) problems.push(`内存增长过大（${growth.toFixed(1)}MB）`);
  if (engine.stats.chatSeen !== TOTAL) problems.push('弹幕计数不对');

  if (problems.length) {
    console.log(`\n  ❌ 发现问题：${problems.join('、')}`);
    process.exit(1);
  }
  console.log('\n  ✅ 队列/历史/缓存都被正确裁剪，内存增长正常');
  process.exit(0);
}, 4000);
