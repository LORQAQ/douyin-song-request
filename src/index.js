'use strict';

const { loadConfig } = require('./config');
const { Logger } = require('./lib/logger');
const { BilibiliClient } = require('./bilibili/bili-api');
const { PlaybackEngine } = require('./player/player');
const { DanmakuService } = require('./danmaku');
const { WebServer } = require('./server');
const { MediaProxy } = require('./lib/media-proxy');
const { LoudnessAnalyzer } = require('./lib/loudness');
const { launchAudioPlayer, openInDefaultBrowser } = require('./lib/launcher');
const { deepMerge, writeJson, readJsonSafe, sanitizeConfigPatch } = require('./lib/util');
const protocol = require('./danmaku/protocol');

const BANNER = `
  ____                    _          ____                        _   
 |  _ \\  ___  _   _ _ __ (_)_ __    / ___|  ___  _ __   __ _   __| |  
 | | | |/ _ \\| | | | '_ \\| | '_ \\   \\___ \\ / _ \\| '_ \\ / _\` | / _\` |  
 | |_| | (_) | |_| | | | | | | | |   ___) | (_) | | | | (_| || (_| |  
 |____/ \\___/ \\__,_|_| |_|_|_| |_|  |____/ \\___/|_| |_|\\__,_| \\__,_|  

 抖音弹幕点歌 -> 自动搜索B站并播放（音乐模式 / 直播伴侣）
`;

async function main() {
  const config = loadConfig(process.argv.slice(2));
  const logger = new Logger('app', config.__flags?.includes('verbose') ? 'debug' : 'info');

  if (config.__flags?.includes('help')) {
    printHelp();
    return;
  }

  console.log(BANNER);

  // 把项目根目录带进 bilibili 配置，供 pins.json（本地固定答案表）定位
  const bili = new BilibiliClient({ ...(config.bilibili || {}), __root: config.__paths.root }, logger.child('bili'));
  const mediaProxy = new MediaProxy(logger.child('media'));
  const loudness = new LoudnessAnalyzer(
    { ...(config.loudness || {}), toolsDir: config.__paths.root },
    logger.child('loudness')
  );
  const engine = new PlaybackEngine({ config, bili, logger: logger.child('player'), mediaProxy, loudness });
  const danmaku = new DanmakuService(config.danmaku || {}, logger.child('danmaku'), { port: config.server.port });

  const server = new WebServer({
    config,
    engine,
    danmaku,
    logger: logger.child('web'),
    mediaProxy,
    frameDecoder: (hex) => decodeExtensionFrame(hex, logger.child('ext')),
    app: {
      onManualSong: async (msg) => {
        return engine.requestSong({
          song: msg.song,
          nickname: msg.nickname || '主播手动',
          userId: msg.userId || 'console',
          message: msg.song || '',
          force: msg.force !== false,
        });
      },
      onDanmakuInject: (text, nickname) => {
        const injected = danmaku.inject(text, nickname);
        if (!injected) {
          logger.warn('当前不是模拟弹幕源，无法手动注入弹幕（可在控制台直接点「手动点歌」）');
        }
        return injected;
      },
      onRetryNow: async () => {
        const result = await engine.retryNow();
        if (!result.ok) logger.info('当前没有需要重试的点歌');
        return result;
      },
      onRestartDanmaku: async () => {
        logger.info('正在重启弹幕连接...');
        await danmaku.stop();
        await startDanmaku();
      },
      onConfigPatch: async (patch) => {
        // 【安全】不能接受任意字段的 patch。
        //
        // 原因：patch 会被 deepMerge 进活配置，然后 writeJson(config.__paths.config, ...) 落盘。
        // 如果 patch 里带 `__paths`（把落盘路径重指到别处）或 `bilibili.__root`
        // （WBI 密钥缓存和原唱缓存都以它为根 writeFileSync），
        // 就等于「可以往任意路径写文件」。虽然 WebSocket 已经校验了 Origin，
        // 但纵深防御不能少 —— 这里把这两个内部字段直接剥掉。
        const safePatch = sanitizeConfigPatch(patch);

        // 只在内存里合并生效
        Object.assign(config, deepMerge(config, safePatch));
        engine.updateConfig(config);
        bili.updateConfig(config.bilibili || {});
        // 落盘时**只写用户改过的那几个字段**：
        // 绝不能把整份默认配置写进 config.json——那样默认值会被固化，
        // 而且会把 example 里的中文注释/内容复制一遍，容易出编码问题。
        try {
          const userConfig = readJsonSafe(config.__paths.config, {}) || {};
          const next = deepMerge(userConfig, safePatch);
          writeJson(config.__paths.config, next);
        } catch (err) {
          logger.warn(`保存配置失败：${err.message}（本次改动只在内存中生效）`);
        }
        server.broadcast({ type: 'status', status: server._status(), urls: server._urls() });
        logger.info(`配置已更新：${JSON.stringify(safePatch).slice(0, 200)}`);
      },
    },
  });

  // 日志同时推给控制台页面
  logger.onLine((line) => {
    server.pushLog(line);
    server.broadcast({ type: 'log', line });
  });

  engine.on('state', (state) => server.broadcast({ type: 'state', state }));
  engine.on('command', (cmd) => server.broadcast({ type: 'command', ...cmd }));
  engine.on('toast', (toast) => server.broadcast({ type: 'toast', toast }));
  // 关键：把「该播哪首歌」和音频地址推给播放页，否则播放页不会出声
  engine.on('play', (payload) => server.broadcast({ type: 'play', ...payload }));

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在退出...`);
    watchdog.stop();
    clearInterval(memoryTimer);
    await danmaku.stop().catch(() => {});
    await server.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  const baseUrl = await server.listen();
  logger.info(`控制台已启动：${baseUrl}/`);
  logger.info(`音乐播放页：${baseUrl}/audio（这个页面负责出声）`);

  async function startDanmaku() {
    const result = await danmaku.start();
    server.broadcast({ type: 'status', status: server._status(), urls: server._urls() });
    return result;
  }

  danmaku.on('chat', (msg) => engine.handleChat(msg));
  danmaku.on('status', (status) => {
    server.broadcast({ type: 'danmakuStatus', status });
  });
  danmaku.on('ready', (info) => logger.info(`弹幕通道就绪：${info.source} roomId=${info.roomId || '-'}`));

  // 后台预热白名单合集：11 个 UP 主、几百首歌，第一次查要 ~20 秒，
  // 启动时先拉好，之后每次点歌查白名单都是 0 开销。**不阻塞启动。**
  if (typeof bili.warmupCollections === 'function') {
    logger.info('正在后台预热白名单合集（不影响使用，几秒后完成）…');
    bili.warmupCollections().catch((err) => logger.debug(`合集预热失败：${err.message}`));
  }

  /**
   * 看门狗：
   *   1) 每 30 秒把健康状态推给控制台（弹幕断了要让主播一眼看到）
   *   2) 弹幕连续 3 分钟收不到、且之前是通的，就自动重连一次
   *   3) 每 10 分钟记录一次内存，涨太快会提醒（长时间开播防泄漏）
   */
  const watchdog = {
    lastChatAt: 0,
    reconnectAt: 0,
    memorySamples: [],
    timer: null,
    start() {
      this.timer = setInterval(async () => {
        const status = server._status();
        server.broadcast({ type: 'status', status, urls: server._urls() });

        const source = String(config.danmaku.source || 'native').toLowerCase();
        const chats = danmaku.chatCount;
        if (chats > 0) this.lastChatAt = danmaku.lastChatAt || Date.now();

        const silent = this.lastChatAt && Date.now() - this.lastChatAt > 180000;
        const offline = danmaku.status.state !== 'online';
        if (source !== 'mock' && (offline || silent) && Date.now() - this.reconnectAt > 120000) {
          this.reconnectAt = Date.now();
          logger.warn(
            offline
              ? `检测到弹幕通道异常（${danmaku.status.detail || danmaku.status.state}），自动重连...`
              : '3 分钟没收到任何弹幕，自动重连弹幕通道...'
          );
          danmaku.stop().catch(() => {});
          setTimeout(() => {
            startDanmaku().catch((err) => logger.error('自动重连失败：', err.message));
          }, 1000);
        }
      }, 30000);
      if (this.timer.unref) this.timer.unref();
    },
    stop() {
      if (this.timer) clearInterval(this.timer);
    },
  };

  // 内存采样：只在明显异常增长时提示，避免刷屏
  const memoryTimer = setInterval(() => {
    const mem = process.memoryUsage();
    const mb = (n) => Math.round(n / 1048576);
    watchdog.memorySamples.push(mb(mem.heapUsed));
    if (watchdog.memorySamples.length > 20) watchdog.memorySamples.shift();
    if (mb(mem.heapUsed) > 900) {
      logger.warn(`内存占用偏高：堆 ${mb(mem.heapUsed)}MB / RSS ${mb(mem.rss)}MB（长时间开播可以重启一次程序）`);
    } else {
      logger.debug(`内存：堆 ${mb(mem.heapUsed)}MB / RSS ${mb(mem.rss)}MB`);
    }
  }, 600000);
  if (memoryTimer.unref) memoryTimer.unref();

  const source = String(config.danmaku.source || 'native').toLowerCase();
  if (source === 'mock') {
    logger.warn('当前是「模拟弹幕源」模式：不会连抖音，只在控制台手动测试。');
  } else if (!config.danmaku.webRid) {
    // 这种情况是「还没配」，不是「出错了」：用友好提示，别吓主播
    logger.warn('还没有配置直播间号 —— 打开 http://127.0.0.1:' + config.server.port + '/ 填一下就能自动连上。');
  } else if (source === 'native') {
    logger.info('弹幕通道：HTTP 长轮询（纯本机请求，无需登录）。');
  }

  await startDanmaku().catch((err) => {
    if (!config.danmaku.webRid && String(config.danmaku.source) !== 'mock') {
      logger.warn(`弹幕通道暂未启动（${err.message}）`);
      return;
    }
    logger.error('弹幕服务启动失败：', err.message);
  });
  watchdog.start();

  // 自动拉起专用播放器（把音频钉到虚拟声卡）
  const launchCfg = config.launchPlayer || {};
  if (launchCfg.auto) {
    try {
      launchAudioPlayer({
        url: `${baseUrl}/audio`,
        deviceName: launchCfg.deviceName || '',
        userDataDir: launchCfg.userDataDir,
        app: launchCfg.app !== false,
        logger,
      });
    } catch (err) {
      logger.warn(`自动启动播放器失败：${err.message}（可以手动打开 ${baseUrl}/audio）`);
    }
  } else if (config.server.openBrowser) {
    openInDefaultBrowser(`${baseUrl}/`, logger);
  }

  if (!config.danmaku.webRid && source !== 'mock') {
    logger.info(`提示：先在浏览器打开 ${baseUrl}/ 填好直播间号，点「保存并重连」。`);
  }
}

/**
 * 浏览器插件转发的原始帧 -> 弹幕消息列表。
 * 插件只负责把抖音页面自己那条 WebSocket 的帧转过来，解析仍在本机完成。
 */
function decodeExtensionFrame(hex, logger) {
  const chats = [];
  if (!hex || typeof hex !== 'string') return chats;
  try {
    const buffer = Buffer.from(hex, 'hex');
    const frame = protocol.decodePushFrame(buffer);
    if (frame.payloadType !== 0 || !frame.payload.length) return chats;
    const response = protocol.decodeResponse(frame.payload);
    for (const msg of response.messages) {
      const decoded = protocol.decodeMessage(msg);
      if (decoded && decoded.type === 'chat' && decoded.content) chats.push(decoded);
    }
    if (!chats.length && response.messages.length && logger) {
      logger.debug(`插件帧解析出 ${response.messages.length} 条非弹幕消息`);
    }
  } catch (err) {
    if (logger) logger.debug(`插件帧解析失败：${err.message}`);
  }
  return chats;
}

function printHelp() {
  console.log(`
用法：node src/index.js [选项]

选项：
  --rid <直播间号>     抖音直播间号（live.douyin.com/ 后面那串数字）
  --room-id <数字>     直接指定抖音 roomId（跳过页面解析）
  --port <端口>        控制台端口，默认 8787
  --source <模式>      弹幕源：native(HTTP长轮询,默认) / extension(插件转发) / browser(浏览器抓取) / mock(手动测试)
  --keyword <词,词>    自定义触发词，如 --keyword "点歌,来一首"
  --mode <模式>        queue(排队) / interrupt(立刻打断)
  --volume <0-1>       音量
  --cookie <cookie>    B站 cookie（可选，能提高搜索和音质稳定性）
  --dy-cookie <cookie> 抖音 cookie（可选）
  --mock               等于 --source mock
  --open               启动后用默认浏览器打开控制台
  --verbose            打印调试日志
  --mem-limit <MB>     只做检查提示（默认期望 256MB）
                       V8 的堆上限只能在 node 启动时用 --max-old-space-size= 指定，
                       进程起来之后改不了。启动脚本（start.bat 等）里已经带上了；
                       如果你是自己敲 node src/index.js，看到提示就加上它。
`);
}

/**
 * 【内存安全阀·检查】
 *
 * 为什么需要：
 *   实测稳态堆内存只有 10~15MB，RSS 约 130MB（大头是 V8 自身的基线开销）。
 *   Node 默认允许堆涨到 4GB 左右，万一某处出现意外增长，会先把机器吃满才暴露。
 *   设成 256MB 之后，异常增长会早早抛 OOM（日志里能看到），不会拖死主播的机器。
 *
 * 为什么这里只提示、不自己重启：
 *   试过"检测到没设就 spawn 一个带参数的自己再退出"，但父进程一退出，
 *   Windows 上很容易把子进程一起带走（stdio 继承 + 进程树），
 *   表现得像"程序莫名起不来"。启动脚本里带参数又简单又可靠，就不绕这一圈了。
 */
function checkMemLimit(argv) {
  const i = argv.indexOf('--mem-limit');
  const want = i >= 0 ? Number(argv[i + 1]) : 256;
  if (!want || want <= 0) return;

  const hasFlag = process.execArgv.some((a) => a.startsWith('--max-old-space-size'));
  if (hasFlag) return;

  const limitMB = Math.round(require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024);
  if (limitMB <= want) return;

  // 只提示一次，不刷屏
  console.log(
    `提示：当前 V8 堆上限是 ${limitMB}MB（没有限制）。\n` +
      `      加 --max-old-space-size=${want} 可以让内存异常增长更早暴露；\n` +
      `      用 start.bat 启动的话已经自动带上了，这里可以忽略。\n`
  );
}

// 启动时检查一下内存上限（只提示，不改行为）
checkMemLimit(process.argv.slice(2));

/**
 * 【进程兜底】不要把未捕获异常变成「程序莫名消失」。
 *
 * 实测教训：HTTP 处理函数是 async 的，任何漏出去的异常都会变成
 * unhandledRejection，而 Node ≥15 默认直接结束进程 ——
 * 一个畸形请求（比如 `GET /%`）就能把正在直播的点歌工具打挂，
 * 主播只会看到窗口没了。这里统一记日志并继续运行。
 */
process.on('unhandledRejection', (reason) => {
  const msg = reason && reason.stack ? reason.stack : String(reason);
  console.error('[未处理的 Promise 拒绝] ' + msg.split('\n').slice(0, 4).join('\n  '));
});
process.on('uncaughtException', (err) => {
  const msg = err && err.stack ? err.stack : String(err);
  console.error('[未捕获异常] ' + msg.split('\n').slice(0, 4).join('\n  '));
  // 故意不退出：直播工具宁可带伤运行，也不要让主播的直播断掉。
  // 真正致命的错误（端口被占等）在启动阶段就会抛出并被 main() 的 catch 处理。
});

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
