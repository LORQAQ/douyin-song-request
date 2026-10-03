'use strict';

/**
 * 开播前自检：npm run doctor
 *   - Node 与依赖是否就绪
 *   - B站：能否访问、搜索接口是否被风控、Cookie 是否有效
 *   - 抖音：直播间号能不能解析出 roomId
 *   - 弹幕：协议直连能不能连上（3 秒内握手）
 *   - 本机：端口有没有被占用
 */

const net = require('net');
const { loadConfig } = require('../src/config');
const { Logger } = require('../src/lib/logger');
const { BilibiliClient } = require('../src/bilibili/bili-api');
const sign = require('../src/danmaku/sign');
const { DouyinDanmakuClient } = require('../src/danmaku/client');

const logger = new Logger('doctor', 'info');
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok === null ? '…' : ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `：${detail}` : ''}`);
}

async function checkPort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    socket.setTimeout(800);
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

async function main() {
  console.log('\n=== 抖音点歌插件 · 开播前自检 ===\n');
  const config = loadConfig(process.argv.slice(2));

  console.log('[环境]');
  record('Node 版本', Number(process.versions.node.split('.')[0]) >= 18, process.version);
  try {
    require('ws');
    record('ws 依赖', true);
  } catch {
    record('ws 依赖', false, '请先执行 npm install');
  }
  try {
    require('playwright-core');
    record('playwright-core（备用通道用）', true);
  } catch {
    try {
      require('playwright');
      record('playwright（备用通道用）', true);
    } catch {
      record('playwright（备用通道用）', null, '未安装，只有需要浏览器抓取时才要（npm i playwright-core）');
    }
  }
  const inUse = await checkPort(config.server.port);
  record(`端口 ${config.server.port}`, !inUse, inUse ? '已被占用（可能是程序已经在跑）' : '可用');

  console.log('\n[B站]');
  const bili = new BilibiliClient(config.bilibili, logger);
  try {
    const result = await bili.pickForSong('晴天');
    if (result.ok) {
      record('搜索接口', true, `测试搜索「晴天」→ ${result.pick.title.slice(0, 30)}（${result.pick.owner}）`);
    } else {
      record('搜索接口', false, result.reason || '无结果');
    }
    if (result.ok) {
      try {
        const stream = await bili.resolveAudioStream(result.pick.bvid, result.pick.cid);
        record('音频直链解析', true, `${stream.codec || 'unknown'}，${Math.round((stream.bandwidth || 0) / 1000)}kbps`);
      } catch (err) {
        record('音频直链解析', false, `${err.message}（会回退到官方内嵌播放器）`);
      }
    }
  } catch (err) {
    record('搜索接口', false, err.message);
  }
  if (config.bilibili.cookie) {
    try {
      const res = await fetch('https://api.bilibili.com/x/web-interface/nav', {
        headers: { ...require('../src/lib/util').BILI_HEADERS, Cookie: config.bilibili.cookie },
      });
      const json = await res.json();
      if (json.code === 0 && json.data && json.data.isLogin) {
        record('B站 Cookie', true, `已登录：${json.data.uname}`);
      } else {
        record('B站 Cookie', false, 'Cookie 无效或已过期，请重新获取');
      }
    } catch (err) {
      record('B站 Cookie', false, err.message);
    }
  } else {
    record('B站 Cookie', null, '未配置（可选，配了搜索更稳、音质更好）');
  }

  console.log('\n[抖音]');
  if (!config.danmaku.webRid) {
    record('直播间号', false, '未配置，请在控制台填写或启动时加 --rid');
  } else {
    const cookie = config.danmaku.cookie || '';
    const page = await sign.fetchWebCookies(config.danmaku.webRid, logger);
    const ttwid = cookie || sign.cookieHeader(page.cookies);
    const info = await sign.fetchRoomInfo(config.danmaku.webRid, ttwid, logger);
    if (info && info.roomId) {
      record(
        '房间信息接口',
        true,
        `roomId=${info.roomId}${info.nickname ? `，主播=${info.nickname}` : ''}` +
          (info.status === 2 ? '（直播中）' : info.status === 4 ? '（已下播）' : '')
      );
    } else {
      record('房间信息接口', false, '没拿到 roomId（确认直播间号正确、直播间存在）');
    }

    if (config.danmaku.source === 'native' || config.danmaku.source === 'mock') {
      const client = new DouyinDanmakuClient(
        { webRid: config.danmaku.webRid, roomId: config.danmaku.roomId, cookie },
        new Logger('doctor:dy', 'warn')
      );
      const chats = [];
      client.on('chat', (m) => chats.push(m));
      try {
        const connected = await client.connect();
        if (connected) {
          record('弹幕通道（HTTP 长轮询）', true, '连接成功');
          console.log('     （保持 12 秒观察有没有真实弹幕…）');
          await new Promise((r) => setTimeout(r, 12000));
          record(
            '弹幕数据流',
            chats.length > 0 ? true : null,
            chats.length > 0
              ? `收到 ${chats.length} 条弹幕，例如「${chats[0].nickname}：${chats[0].content.slice(0, 20)}」`
              : '12 秒内没有弹幕（房间可能太冷清；如果直播间很热闹却收不到，改用插件转发模式）'
          );
        } else {
          record('弹幕通道（HTTP 长轮询）', false, client.lastErrorKind || '连接失败');
        }
      } catch (err) {
        record('弹幕通道（HTTP 长轮询）', false, err.message);
      } finally {
        client.close();
      }
    } else {
      record('弹幕通道（HTTP 长轮询）', null, `当前配置为 ${config.danmaku.source} 模式，跳过`);
    }
  }

  console.log('\n=== 结论 ===');
  const bad = results.filter((r) => r.ok === false);
  if (!bad.length) {
    console.log('  ✅ 全部通过，可以开播了。');
  } else {
    console.log(`  ⚠️ 有 ${bad.length} 项需要注意：`);
    for (const r of bad) console.log(`     - ${r.name}：${r.detail}`);
    console.log('\n  提示：弹幕收不到时，把 config.json 里的 danmaku.source 改成');
    console.log('        "extension"（浏览器插件转发，最稳）或 "browser"（浏览器抓取）即可。');
  }
  console.log('');
  process.exit(0);
}

main().catch((err) => {
  console.error('自检失败：', err);
  process.exit(1);
});
