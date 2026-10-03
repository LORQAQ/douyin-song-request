'use strict';
/**
 * 实测点歌时歌手名的各种写法，确认都支持。
 *
 * 观众/主播可能写：
 *   点歌 歌手 - 歌名      （最常见，国内音乐平台的格式）
 *   点歌 歌名 - 歌手
 *   点歌 歌名 歌手        （空格分隔）
 *   点歌 歌手 歌名
 */
const fs = require('fs');
const path = require('path');

const LOG = path.join(process.env.TEMP, 'dash-test.txt');
try { fs.unlinkSync(LOG); } catch {}
const log = (s) => { console.log(s); fs.appendFileSync(LOG, s + '\n', 'utf8'); };

const { loadConfig } = require('../src/config');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { Logger } = require('../src/lib/logger');
const { parseRequest } = require('../src/danmaku/parser');

const cfg = loadConfig([]);
const bili = new BilibiliClient(cfg.bilibili || {}, new Logger('x', 'error'));
const trigger = cfg.trigger || {
  keywords: ['点歌'], requireKeyword: true, stripWords: ['点歌'], minLength: 2, maxLength: 40,
};

// [弹幕, 说明]
const MSGS = [
  '点歌 Heart - Alone',
  '点歌 Alone - Heart',
  '点歌 Alone-Heart',
  '点歌 Alone – Heart',      // en dash
  '点歌 Alone — Heart',      // em dash
  '点歌 周杰伦 - 晴天',
  '点歌 晴天 - 周杰伦',
  '点歌 Alan Walker - Alone',
  '点歌 米津玄師 - Lemon',
  '点歌 Alone Alan Walker',
  '点歌 周杰伦 晴天',
];

log('════════ 歌手名各种写法实测 ════════');
log('');

for (const msg of MSGS) {
  const parsed = parseRequest(msg, trigger);
  const song = parsed && parsed.song ? parsed.song : null;
  log('「' + msg + '」');
  if (!song) {
    log('   ❌ 弹幕没解析出来');
    log('');
    continue;
  }
  log('   搜索用歌名: 「' + song + '」');
  // 只有「歌手 - 歌名」格式才会解析出歌手/歌名，别的写法都是空串
  log('   歌手: ' + (parsed.artist ? '「' + parsed.artist + '」' : '(未指定，走平台数据)'));
  log('   歌名: ' + (parsed.title ? '「' + parsed.title + '」' : '(未解析)'));
  log('');
}

log('════════════════════════════');
process.exit(0);
