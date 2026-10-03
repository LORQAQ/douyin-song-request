'use strict';

/**
 * 弹幕通道自检：直接跑 HTTP 长轮询，打印收到的真实弹幕。
 *
 * 用法：
 *   node scripts/probe-connect.js 66186758468            (直播间号)
 *   node scripts/probe-connect.js 66186758468 --dur 30   (持续秒数)
 */

const { DouyinDanmakuClient } = require('../src/danmaku/client');
const { Logger } = require('../src/lib/logger');

const args = process.argv.slice(2);
const webRid = args.find((a) => /^\d+$/.test(a)) || process.env.DSR_RID || '';
const durIndex = args.indexOf('--dur');
const duration = durIndex >= 0 ? Number(args[durIndex + 1]) * 1000 : 25000;

if (!webRid) {
  console.error('用法：node scripts/probe-connect.js <直播间号> [--dur 30]');
  process.exit(2);
}

const logger = new Logger('probe', 'info');
const client = new DouyinDanmakuClient({ webRid }, logger);

let chats = 0;
let others = 0;

client.on('chat', (m) => {
  chats += 1;
  console.log(`  💬 ${m.nickname}：${m.content}`);
});
client.on('message', (m) => {
  if (m.type !== 'chat') others += 1;
});
client.on('status', (s) => logger.info(`状态：${s.state} ${s.detail || ''}`));

(async () => {
  console.log(`\n=== 弹幕通道自检：直播间 ${webRid} ===\n`);
  const ok = await client.connect();
  if (!ok) {
    console.log(`\n连接失败：${client.lastErrorKind}`);
    client.close();
    process.exit(2);
  }
  const started = Date.now();
  while (Date.now() - started < duration && !client.closed) {
    await new Promise((r) => setTimeout(r, 1000));
    process.stdout.write(
      `\r  已运行 ${Math.round((Date.now() - started) / 1000)}s | 轮询 ${client.rounds} 次 | 消息 ${client.messageCount} | 弹幕 ${client.chatCount}   `
    );
    if (client.chatCount >= 5) break;
  }
  console.log('');
  console.log(`\n统计：轮询 ${client.rounds} 次，消息 ${client.messageCount} 条，弹幕 ${client.chatCount} 条，其它 ${others} 条`);
  client.close();
  process.exit(client.chatCount > 0 ? 0 : 3);
})().catch((err) => {
  console.error('异常：', err.message);
  process.exit(1);
});
