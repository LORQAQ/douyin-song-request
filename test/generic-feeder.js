'use strict';
/**
 * 用一个「和点歌插件毫无关系」的极简服务测试悬浮窗。
 *
 * 目的：证明悬浮窗真的解耦了 —— 任何按协议推 JSON 的程序都能驱动它，
 * 不限于本仓库的点歌插件。
 *
 * 这个脚本只做两件事：
 *   1. 起一个裸 WebSocket 服务，路径 /ws/audio
 *   2. 按协议推一条 now + 一条 queue
 */
const http = require('http');
const WebSocket = require('ws');

const PORT = Number(process.argv[2]) || 8899;
const HOLD = Number(process.argv[3]) || 20000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('not a real service');
});

const wss = new WebSocket.Server({ server, path: '/ws/audio' });

wss.on('connection', (ws, req) => {
  console.log('  [极简服务] 悬浮窗连上来了  origin=' + (req.headers.origin || '(无)'));
  // 按协议推数据
  ws.send(
    JSON.stringify({
      type: 'now',
      song: '晴天',
      status: 'playing',
      nickname: '极简服务测试',
      source: '不经过点歌插件 · 纯协议驱动',
      pic: '',
    })
  );
  ws.send(
    JSON.stringify({
      type: 'queue',
      items: [
        { song: '稻香', nickname: '观众甲' },
        { song: '孤勇者', nickname: '观众乙' },
        { song: '海阔天空', nickname: '观众丙' },
      ],
    })
  );
  console.log('  [极简服务] 已推送 1 条 now + 3 条 queue');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('  [极简服务] 监听 ws://127.0.0.1:' + PORT + '/ws/audio');
  console.log('  [极简服务] ' + Math.round(HOLD / 1000) + ' 秒后自动关闭');
  setTimeout(() => {
    server.close();
    process.exit(0);
  }, HOLD);
});
