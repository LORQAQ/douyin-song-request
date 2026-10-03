'use strict';

/**
 * 回归测试：针对代码审查发现并修复的 bug，每个都留一个用例锁住行为。
 * 由 test/run.js 调用（共享它的 test/testAsync 计数器）。
 *
 * 这些都是**真实发生过**的问题，改回去就会挂 —— 所以值得测。
 */

module.exports = async function registerRegressionTests({ test, testAsync, assert }) {
  const http = require('http');
  const path = require('path');
  const fs = require('fs');
  const os = require('os');

  const ROOT = path.resolve(__dirname, '..');

  const dbg = (s) => {
    if (process.env.DSR_DEBUG_REGRESSION) console.log('      [dbg] ' + s);
  };

  /** 起一个测试用的 WebServer（端口 0 = 让系统分配，避免冲突） */
  async function startServer(tagName) {
    dbg(`startServer(${tagName}) 开始`);
    const { WebServer } = require('../src/server');
    const { PlaybackEngine } = require('../src/player/player');
    const { Logger } = require('../src/lib/logger');
    dbg('  require 完成');

    const logger = new Logger('test', 'error');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dsr-${tagName}-`));
    const config = {
      __paths: { root: ROOT, config: path.join(tmp, 'c.json') },
      server: { host: '127.0.0.1', port: 0, openBrowser: false },
      danmaku: { source: 'mock' },
      playback: { volume: 0.8 },
      filter: {},
    };
    const engine = new PlaybackEngine({
      config,
      bili: { searchSong: async () => ({ candidates: [] }) },
      logger,
    });
    dbg('  engine 建好');
    const server = new WebServer({ config, engine, logger, danmaku: { status: {} }, app: {} });
    dbg('  server 建好，准备 listen');
    await server.listen();
    const port = server.server.address().port;
    dbg(`  listen 完成，端口 ${port}`);
    return {
      server,
      config,
      engine,
      port,
      close: () =>
        new Promise((r) => {
          server.close();
          // 额外把全局 agent 的 keep-alive socket 也断掉，
          // 否则测试进程的 event loop 会因为池子里的 socket 不退出。
          try {
            http.globalAgent.destroy();
          } catch {
            /* ignore */
          }
          setTimeout(r, 50);
        }),
    };
  }

  /**
   * 发一个 GET 并**立刻销毁连接**。
   *
   * 为什么不用 http.get 直接返回：Node 的全局 agent 默认开着 keep-alive，
   * 请求完成后 socket 会被放回池子里继续存活 —— 于是
   *   - 服务的 httpConns 一直非空（close() 要等它们）
   *   - 测试进程的 event loop 也一直非空（进程不退出）
   * 手动 destroy + agent:false 可以彻底断开。
   */
  function rawGet(port, p) {
    return new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: p, timeout: 4000, agent: false },
        (res) => {
          const code = res.statusCode;
          res.resume();
          res.on('end', () => {
            req.destroy();
            resolve(code);
          });
        }
      );
      req.on('error', () => resolve(0));
      req.on('timeout', () => {
        req.destroy();
        resolve(-1);
      });
    });
  }

  /* ===================================================================
   * 1) 畸形 URL 不能打挂进程
   *
   * 原来 server.js 里 `new URL()` / `decodeURIComponent()` 在 try 块之外，
   * `GET /%` 会抛 URIError → 变成 unhandledRejection → Node ≥15 直接结束进程。
   * 任何网页 fetch 一下就能把正在直播的点歌工具打挂。
   * =================================================================== */
  {
    const ctx = await startServer('reg1');
    try {
      await testAsync('畸形 URL 不会打挂进程', async () => {
        for (const p of ['/%', '/%E4%BD', '/%zz', '/%25%25%25']) {
          const code = await rawGet(ctx.port, p);
          assert.ok(code > 0, `请求 ${p} 得到异常结果（${code}），服务可能已经挂了`);
        }
        const ok = await rawGet(ctx.port, '/api/health');
        assert.strictEqual(ok, 200, '畸形请求之后 /api/health 应该仍然可用（进程没崩）');
        console.log('      → 畸形 URL 被安全拒绝，进程存活');
      });
    } finally {
      await ctx.close();
    }
  }

  /* ===================================================================
   * 2) WebSocket 必须校验 Origin
   *
   * WS 不受同源策略限制：主播浏览器里任何网站都能连 ws://127.0.0.1:8787，
   * 而 updateConfig 能改配置并落盘 —— 等于任意网站可改主播的点歌程序。
   * =================================================================== */
  {
    const ctx = await startServer('reg2');
    try {
      await testAsync('WebSocket 拒绝非本机 Origin', async () => {
        const WebSocket = require('ws');
        const connect = (origin) =>
          new Promise((resolve) => {
            const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws/audio`, {
              headers: origin ? { Origin: origin } : {},
            });
            let settled = false;
            const done = (v) => {
              if (settled) return;
              settled = true;
              try {
                ws.terminate();
              } catch {
                /* ignore */
              }
              resolve(v);
            };
            ws.on('open', () => done('open'));
            ws.on('unexpected-response', (_req, res) => done('http-' + res.statusCode));
            ws.on('error', (e) => done('blocked:' + (e.message || '').slice(0, 30)));
            setTimeout(() => done('timeout'), 3000);
          });

        const evil = await connect('https://evil.example.com');
        assert.ok(evil !== 'open', `恶意 Origin 竟然连上了（${evil}）`);

        const local = await connect(`http://127.0.0.1:${ctx.port}`);
        assert.strictEqual(local, 'open', `本机 Origin 应该能连上，实际 ${local}`);
        console.log('      → 恶意来源被拒、本机来源放行');
      });
    } finally {
      await ctx.close();
    }
  }

  /* ===================================================================
   * 3) 音量必须是有限数字
   *
   * msg.value = 'abc' 时 Number() = NaN → 写进配置并落盘（→ null）
   * → 播放页 `Number(v) || 0` 变成 0 → 整场直播静音且不报错。
   * =================================================================== */
  {
    const ctx = await startServer('reg3');
    try {
      await test('非法音量值被忽略（不会静音）', () => {
        const fakeWs = { role: 'console', readyState: 1 };
        ctx.server._onClientMessage(fakeWs, JSON.stringify({ type: 'volume', value: 'abc' }));
        assert.strictEqual(ctx.config.playback.volume, 0.8, '非法值不该改掉音量');

        ctx.server._onClientMessage(fakeWs, JSON.stringify({ type: 'volume', value: 5 }));
        assert.strictEqual(ctx.config.playback.volume, 1, '超范围应该被夹到 1');

        ctx.server._onClientMessage(fakeWs, JSON.stringify({ type: 'volume', value: -3 }));
        assert.strictEqual(ctx.config.playback.volume, 0, '负数应该被夹到 0');
        console.log('      → NaN 被忽略、越界被夹取');
      });
    } finally {
      await ctx.close();
    }
  }

  /* ===================================================================
   * 4) 删除队列条目要释放该观众的点歌配额
   *
   * 原来只有"播完/跳过/清空队列"才 -1，控制台删条目和队列溢出不 -1，
   * 于是观众被删 3 次后就被永久拒绝（"已经排了3首"），必须重启才恢复。
   * =================================================================== */
  await test('删除队列条目会释放点歌配额', () => {
    const { SongQueue } = require('../src/player/queue');
    const { RequestFilter } = require('../src/danmaku/parser');

    const filter = new RequestFilter({ sameSongWindowMs: 0, perUserCooldownMs: 0, maxQueuePerUser: 3 }, null);
    const queue = new SongQueue({ maxQueueSize: 50 });
    queue.onDrop = (entry) => filter.releaseUser(entry.userId);

    for (let i = 0; i < 3; i += 1) {
      const song = '歌' + i;
      assert.ok(filter.check({ userId: 'u1', nickname: '甲', song }).ok, `第 ${i + 1} 首应该能点`);
      filter.commit({ userId: 'u1', song, fingerprint: 'fp' + i });
      queue.push({ id: 'e' + i, song, userId: 'u1', nickname: '甲', status: 'queued' });
    }
    assert.strictEqual(filter.check({ userId: 'u1', nickname: '甲', song: '歌X' }).ok, false, '配额满了应该拒绝');

    queue.remove('e0');
    queue.remove('e1');
    assert.ok(filter.check({ userId: 'u1', nickname: '甲', song: '歌Y' }).ok, '删掉条目后应该又能点了');
    console.log('      → 删条目后配额已归还');
  });

  /* ===================================================================
   * 5) 队列溢出丢弃时也要释放配额
   * =================================================================== */
  await test('队列溢出丢弃条目也会释放配额', () => {
    const { SongQueue } = require('../src/player/queue');
    const { RequestFilter } = require('../src/danmaku/parser');

    const filter = new RequestFilter({ sameSongWindowMs: 0, perUserCooldownMs: 0, maxQueuePerUser: 2 }, null);
    const queue = new SongQueue({ maxQueueSize: 2 });
    queue.onDrop = (entry) => filter.releaseUser(entry.userId);

    for (let i = 0; i < 2; i += 1) {
      filter.commit({ userId: 'u2', song: 'a' + i, fingerprint: 'x' + i });
      queue.push({ id: 'i' + i, song: 'a' + i, userId: 'u2', nickname: '乙', status: 'queued' });
    }
    assert.strictEqual(filter.check({ userId: 'u2', nickname: '乙', song: 'a9' }).ok, false, '配额应该满了');

    queue.push({ id: 'i2', song: 'a2', userId: 'u2', nickname: '乙', status: 'queued' });
    queue.push({ id: 'i3', song: 'a3', userId: 'u2', nickname: '乙', status: 'queued' });
    assert.ok(filter.check({ userId: 'u2', nickname: '乙', song: 'a8' }).ok, '溢出丢弃后应该又能点了');
    console.log('      → 溢出丢弃后配额已归还');
  });

  /* ===================================================================
   * 6) --port --mock 不能把 --mock 吞掉
   *
   * 原来取值参数会无条件吃掉下一个 argv，`--port --mock` 会让
   * port 变成 NaN（Node 随机挑端口）且 --mock 静默失效。
   * =================================================================== */
  await test('命令行缺值时不会吞掉后面的标志', () => {
    const { loadConfig } = require('../src/config');
    const c = loadConfig(['--port', '--mock']);
    assert.strictEqual(c.danmaku.source, 'mock', '--mock 不该被 --port 吞掉');
    assert.ok(Number.isFinite(Number(c.server.port)), 'port 不该是 NaN');

    const c2 = loadConfig(['--port', '9911', '--mock']);
    assert.strictEqual(Number(c2.server.port), 9911, '正常取值应该生效');
    assert.strictEqual(c2.danmaku.source, 'mock');
    console.log('      → 缺值选项被跳过，后续标志正常生效');
  });

  /* ===================================================================
   * 7) 音频代理等 drain 时，客户端断开不能永久挂起
   *
   * 只监听 'drain' 的话，客户端中途断开（切歌/刷新）就永远等不到，
   * 上游 reader 和 socket 一起泄漏 —— 每切一次歌漏一个。
   * =================================================================== */
  await testAsync('音频代理在客户端断开时不会挂住', async () => {
    const { MediaProxy } = require('../src/lib/media-proxy');

    // 冒充「B站 CDN」，持续吐数据
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': String(10 * 1024 * 1024) });
      const chunk = Buffer.alloc(64 * 1024, 1);
      const timer = setInterval(() => {
        if (!res.write(chunk)) {
          clearInterval(timer);
          res.once('drain', () => res.end());
        }
      }, 1);
      res.on('close', () => clearInterval(timer));
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    const upPort = upstream.address().port;

    const logger = { debug() {}, info() {}, warn() {}, error() {} };
    const proxy = new MediaProxy(logger);
    const url = proxy.register({
      id: 'reg-test',
      bvid: 'BVtest',
      cid: 1,
      title: 'test',
      upstreams: [`http://127.0.0.1:${upPort}/audio`],
      expireAt: Date.now() + 3600000,
    });

    const proxyServer = http.createServer((req, res) => {
      const key = decodeURIComponent(req.url.slice('/media/'.length));
      proxy.handle(req, res, key);
    });
    await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r));
    const proxyPort = proxyServer.address().port;

    // 收到一点数据就断开（模拟切歌 / 刷新页面）
    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: proxyPort, path: url }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => resolve());
      setTimeout(resolve, 3000);
    });
    await new Promise((r) => setTimeout(r, 300));

    // 断开后代理应该仍然能服务新请求（说明转发协程没挂死）
    const stillWorks = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: proxyPort, path: url }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve(res.statusCode === 200);
        });
      });
      req.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
    assert.ok(stillWorks, '客户端断开后代理应该仍然能服务新请求（没有卡死）');
    console.log('      → 断开后代理未挂起，仍可正常取流');

    await new Promise((r) => proxyServer.close(r));
    await new Promise((r) => upstream.close(r));
  });

  /* ===================================================================
   * 8) 磁盘缓存写入是原子的（临时文件 + rename）
   *
   * 原来 readFileSync→改→writeFileSync 非原子：并发落盘互相覆盖，
   * 中途被杀会留下半个 JSON 导致整个磁盘缓存静默失效。
   * =================================================================== */
  await testAsync('原唱缓存并发写入后文件仍是合法 JSON', async () => {
    const { MusicMeta } = require('../src/lib/music-meta');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsr-mm-'));
    const mm = new MusicMeta({ __root: dir }, { debug() {}, info() {}, warn() {} });

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => mm._writeDisk('k' + i, { artist: 'A' + i })))
    );

    const file = path.join(dir, 'music-meta-cache.json');
    assert.ok(fs.existsSync(file), '缓存文件应该存在');
    // 关键：文件必须是合法 JSON（不能是半个文件）
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(Object.keys(raw).length > 0, '至少应该有内容写进去');
    assert.ok(!fs.existsSync(file + '.tmp'), '临时文件应该已经被 rename 掉');
    console.log(`      → 并发写入后文件仍是合法 JSON（含 ${Object.keys(raw).length} 条）`);
  });
};
