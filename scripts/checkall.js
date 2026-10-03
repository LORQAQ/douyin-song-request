'use strict';

/**
 * 一键体检：把「开播前要确认的事」一次性全查完。
 *
 *   node scripts/checkall.js            用配置里的直播间号
 *   node scripts/checkall.js --rid 123  指定直播间号
 *   node scripts/checkall.js --browser  额外用真实 Chrome 打开播放页试听（最慢但最可靠）
 *   node scripts/checkall.js --json     输出 JSON（给脚本/自动化用）
 *
 * 退出码：0 全通过；1 有严重问题（弹幕收不到 / B站不可用）；2 只有警告
 */

const net = require('net');
const { loadConfig } = require('../src/config');
const { Logger } = require('../src/lib/logger');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const { LoudnessAnalyzer } = require('../src/lib/loudness');
const sign = require('../src/danmaku/sign');
const { DouyinDanmakuClient } = require('../src/danmaku/client');
const { detectChromePath } = require('../src/lib/launcher');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const withBrowser = args.includes('--browser');
const ridIndex = args.indexOf('--rid');
const ridOverride = ridIndex >= 0 ? args[ridIndex + 1] : '';
const DANMAKU_WAIT_MS = Number((args.find((a) => a.startsWith('--wait=')) || '').split('=')[1]) || 12000;

const results = [];
function add(name, level, detail = '') {
  // level: 'ok' | 'warn' | 'fail' | 'skip'
  results.push({ name, level, detail });
  if (!asJson) {
    const mark = { ok: '✓', warn: '!', fail: '✗', skip: '·' }[level];
    console.log(`  ${mark} ${name}${detail ? `：${detail}` : ''}`);
  }
}

function portOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(700);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => resolve(false));
  });
}

async function checkBilibili(config, logger) {
  const bili = new BilibiliClient(config.bilibili, logger);
  try {
    const picked = await bili.pickForSong('晴天');
    if (!picked.ok) {
      add('B站搜索', 'fail', picked.reason || '没有结果');
      return null;
    }
    add('B站搜索', 'ok', `「晴天」→ ${picked.pick.title.slice(0, 28)}（${picked.pick.owner}）`);
    try {
      const stream = await bili.resolveAudioStream(picked.pick.bvid, picked.pick.cid);
      add('音频直链', 'ok', `${stream.codec || 'unknown'} · ${Math.round((stream.bandwidth || 0) / 1000)}kbps`);
      return { bili, stream };
    } catch (err) {
      add('音频直链', 'warn', `${err.message}（会自动回退官方内嵌播放器）`);
      return { bili, stream: null };
    }
  } catch (err) {
    add('B站接口', 'fail', err.message);
    return null;
  }
}

async function checkDanmaku(config, logger) {
  const cookie = config.danmaku.cookie || '';
  const page = await sign.fetchWebCookies(config.danmaku.webRid, logger);
  const ttwid = cookie || sign.cookieHeader(page.cookies);
  const info = await sign.fetchRoomInfo(config.danmaku.webRid, ttwid, logger);
  if (!info || !info.roomId) {
    add('抖音房间信息', 'fail', '拿不到 roomId（确认直播间号正确、直播间存在）');
    return false;
  }
  const stateText = info.status === 2 ? '直播中' : info.status === 4 ? '已下播' : `状态${info.status}`;
  add(
    '抖音房间信息',
    info.status === 2 ? 'ok' : 'warn',
    `roomId=${info.roomId} · ${info.nickname} · ${stateText}`
  );

  const client = new DouyinDanmakuClient(
    { webRid: config.danmaku.webRid, roomId: info.roomId, cookie },
    new Logger('check:dy', 'warn')
  );
  const chats = [];
  client.on('chat', (m) => chats.push(m));
  const started = Date.now();
  const connected = await client.connect().catch((err) => {
    add('弹幕通道', 'fail', err.message);
    return false;
  });
  if (!connected) {
    add('弹幕通道', 'fail', client.lastErrorKind || '连接失败');
    return false;
  }
  const firstLatency = Date.now() - started;
  add('弹幕通道', 'ok', `HTTP 长轮询已连上（${firstLatency}ms）`);

  while (Date.now() - started < DANMAKU_WAIT_MS && chats.length < 3) {
    await new Promise((r) => setTimeout(r, 500));
  }
  if (chats.length) {
    add(
      '弹幕数据流',
      'ok',
      `${chats.length} 条弹幕，例如「${chats[0].nickname}：${chats[0].content.slice(0, 24)}」`
    );
  } else if (info.status === 4) {
    add('弹幕数据流', 'skip', '主播当前没开播，等开播后弹幕才会流动');
  } else {
    add(
      '弹幕数据流',
      'warn',
      `${Math.round(DANMAKU_WAIT_MS / 1000)} 秒没有弹幕（房间冷清属正常；如果明明很热闹，改用插件转发模式）`
    );
  }
  client.close();
  return chats.length > 0 || info.status === 4;
}

async function checkBrowserPlayback(config) {
  const { execFile } = require('child_process');
  const path = require('path');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(__dirname, 'browser-check.js')],
      { timeout: 180000, windowsHide: true },
      (err, stdout) => {
        const text = String(stdout || '');
        const pass = /通过 (\d+) 项，失败 0 项/.test(text);
        if (err || !pass) {
          add('真实浏览器播放', 'warn', '没能确认播放（可能是 Chrome 没装/被占用，可手动打开播放页试试）');
          resolve(false);
        } else {
          add('真实浏览器播放', 'ok', 'Chrome 打开播放页并成功出声');
          resolve(true);
        }
      }
    );
  });
}

(async () => {
  const config = loadConfig(process.argv.slice(2));
  if (ridOverride) config.danmaku.webRid = ridOverride;
  const logger = new Logger('check', 'warn');

  if (!asJson) {
    console.log('\n=== 抖音点歌插件 · 一键体检 ===\n');
    console.log('[环境]');
  }

  const major = Number(process.versions.node.split('.')[0]);
  add('Node 版本', major >= 18 ? 'ok' : 'fail', process.version);
  try {
    require('ws');
    add('核心依赖 ws', 'ok');
  } catch {
    add('核心依赖 ws', 'fail', '请先执行 npm install');
  }
  const chrome = detectChromePath();
  add('浏览器（播放页用）', chrome ? 'ok' : 'warn', chrome || '没找到 Chrome/Edge，播放页需要它');

  const running = await portOpen(config.server.port);
  add(
    `端口 ${config.server.port}`,
    running ? 'ok' : 'skip',
    running ? '已有服务在跑（本次体检不影响它）' : '空闲'
  );

  if (!asJson) console.log('\n[B站]');
  const biliResult = await checkBilibili(config, logger);

  if (!asJson) console.log('\n[音量校准]');
  const analyzer = new LoudnessAnalyzer(
    { ...(config.loudness || {}), toolsDir: config.__paths.root },
    new Logger('check:loud', 'warn')
  );
  if (analyzer.enabled && biliResult && biliResult.stream) {
    const measured = await analyzer.measure('check', biliResult.stream.url);
    if (measured && measured.lufs) {
      add('音量校准', 'ok', `测得 ${measured.lufs.toFixed(1)} LUFS，修正 ${measured.gainDb.toFixed(1)}dB`);
    } else {
      add('音量校准', 'warn', measured.error || '分析失败（不影响播放）');
    }
  } else if (analyzer.enabled) {
    add('音量校准', 'skip', '没有可用的音频流可测');
  } else {
    add(
      '音量校准',
      'skip',
      '未检测到 ffmpeg（可选功能）：把 ffmpeg.exe 放进项目 tools 目录即可启用自动音量平衡'
    );
  }

  if (!asJson) console.log('\n[抖音弹幕]');
  let danmakuOk = true;
  if (!config.danmaku.webRid) {
    add('直播间号', 'fail', '没配置，用 --rid 你的直播间号 再跑一次');
    danmakuOk = false;
  } else if (String(config.danmaku.source).toLowerCase() === 'mock') {
    add('直播间号', 'skip', '当前是模拟模式，不连抖音');
  } else {
    danmakuOk = await checkDanmaku(config, logger);
  }

  if (withBrowser && running) {
    if (!asJson) console.log('\n[真实浏览器]');
    await checkBrowserPlayback(config);
  } else if (withBrowser) {
    add('真实浏览器播放', 'skip', '需要先启动程序（npm start）再体检');
  }

  const failed = results.filter((r) => r.level === 'fail');
  const warned = results.filter((r) => r.level === 'warn');

  if (asJson) {
    console.log(JSON.stringify({ ok: failed.length === 0, results, failed: failed.length, warned: warned.length }, null, 2));
  } else {
    console.log('\n=== 结论 ===');
    if (!failed.length && !warned.length) {
      console.log('  ✅ 全部通过，可以开播了。');
    } else {
      if (failed.length) {
        console.log(`  ✗ ${failed.length} 项必须处理：`);
        for (const r of failed) console.log(`     - ${r.name}：${r.detail}`);
      }
      if (warned.length) {
        console.log(`  ! ${warned.length} 项建议关注：`);
        for (const r of warned) console.log(`     - ${r.name}：${r.detail}`);
      }
    }
    console.log('\n  下一步：npm start  然后打开 http://127.0.0.1:' + config.server.port + '/');
    console.log('');
  }

  process.exit(failed.length ? 1 : warned.length ? 2 : 0);
})().catch((err) => {
  if (asJson) console.log(JSON.stringify({ ok: false, error: err.message }, null, 2));
  else console.error('体检失败：', err.stack || err.message);
  process.exit(1);
});
