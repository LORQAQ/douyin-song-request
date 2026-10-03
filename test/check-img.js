'use strict';
/** 验证 /api/img 代理的成功路径：拿真实封面图走一次代理 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const LOG = path.join(process.env.TEMP, 'img-test.txt');
const log = (s) => fs.appendFileSync(LOG, s + '\n', 'utf8');
try { fs.unlinkSync(LOG); } catch {}

(async () => {
  const { loadConfig } = require('../src/config');
  const cfg = loadConfig([]);
  const logger = { debug() {}, info() {}, warn() {}, error() {} };

  // 1) 直接问 B 站搜索要一个真实封面 URL
  const url =
    'https://api.bilibili.com/x/web-interface/search/all/v2?keyword=' + encodeURIComponent('晴天');
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' },
    signal: AbortSignal.timeout(10000),
  });
  const j = await r.json();
  const seg = (j.data && j.data.result ? j.data.result : []).find((x) => x.result_type === 'video');
  const pic = seg && seg.data && seg.data[0] ? seg.data[0].pic : null;
  log('封面 URL: ' + (pic || '(没拿到)'));

  if (!pic) {
    log('拿不到封面 URL，跳过');
    process.exitCode = 0;
    return;
  }

  // 2) 直接测代理函数（起一个最小服务挂上 _proxyImage）
  const { WebServer } = require('../src/server');
  const { PlaybackEngine } = require('../src/player/player');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-img-'));
  const config = {
    __paths: { root: path.resolve(__dirname, '..'), config: path.join(tmp, 'c.json') },
    server: { host: '127.0.0.1', port: 0, openBrowser: false },
    danmaku: { source: 'mock' },
    playback: {},
    filter: {},
  };
  const engine = new PlaybackEngine({ config, bili: { searchSong: async () => ({ candidates: [] }) }, logger });
  const server = new WebServer({ config, engine, logger, danmaku: { status: {} }, app: {} });
  await server.listen();
  const port = server.server.address().port;
  log('测试服务端口: ' + port);

  const get = (p) =>
    new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 20000, agent: false }, (res) => {
        let n = 0;
        res.on('data', (c) => (n += c.length));
        res.on('end', () => {
          req.destroy();
          resolve({ code: res.statusCode, bytes: n, type: res.headers['content-type'] });
        });
      });
      req.on('error', (e) => resolve({ code: 0, err: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ code: -1 }); });
    });

  // 3) 真实封面图应该代理成功
  const okRes = await get('/api/img?u=' + encodeURIComponent(pic));
  log('真实封面 → HTTP ' + okRes.code + '  ' + okRes.bytes + ' bytes  ' + (okRes.type || ''));

  // 4) 边界
  const noArg = await get('/api/img');
  log('无参数 → HTTP ' + noArg.code);
  const evil = await get('/api/img?u=' + encodeURIComponent('https://evil.example.com/x.jpg'));
  log('非白名单 → HTTP ' + evil.code);

  const pass =
    okRes.code === 200 && okRes.bytes > 1000 && noArg.code === 400 && evil.code === 403;
  log(pass ? '结果: ✅ 全部符合预期' : '结果: ❌ 有不符合预期的地方');

  await new Promise((res) => {
    server.close();
    http.globalAgent.destroy();
    setTimeout(res, 100);
  });
  process.exitCode = pass ? 0 : 1;
})().catch((e) => {
  log('!! 异常: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
