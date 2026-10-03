'use strict';

const EventEmitter = require('events');
const { DouyinDanmakuClient } = require('./client');
const { MockSource } = require('./mock-source');
const { BrowserSource } = require('./browser-source');

/**
 * 弹幕源统一入口：
 *   - native : HTTP 长轮询（默认，纯 Node，实测可用，不需要签名/登录）
 *   - browser: Playwright 打开直播间页面抓帧（备用；抖音会检测自动化，可能被限制）
 *   - extension: 浏览器插件把页面自己的连接转发过来（最稳，需装扩展）
 *   - mock   : 手动输入，用于线下调试
 *
 * 默认 native 已经足够；只有 native 连续失败时才建议切到 extension。
 * 开启 fallbackToBrowser 时，native 失败会自动降级到 browser（再到 extension）。
 */
class DanmakuService extends EventEmitter {
  constructor(config = {}, logger, options = {}) {
    super();
    this.config = config;
    this.port = options.port || Number(process.env.DSR_PORT) || 8787;
    this.logger = logger || console;
    this.source = null;
    this.sourceName = null;
    this.status = { state: 'idle', detail: '未启动' };
    this.silenceTimer = null;
    this.chatCount = 0;
    this.lastChatAt = 0;
    /** 曾经成功收到过弹幕：用来区分「房间冷清」和「通道后来挂了」 */
    this.everReceivedChat = false;
  }

  get activeName() {
    return this.sourceName;
  }

  /**
   * 轮询轮数（转发自当前弹幕源）。
   *
   * 用途：判断「通道是不是真的死了」。只看"多久没弹幕"会把安静的直播间
   * 误判成故障，而轮数只要通道活着就会一直涨 —— 这是可靠得多的信号。
   */
  get rounds() {
    const s = this.source;
    return s && typeof s.rounds === 'number' ? s.rounds : 0;
  }

  async start() {
    const cfg = this.config || {};
    const source = String(cfg.source || 'native').toLowerCase();
    if (source === 'mock') return this._startMock();
    if (source === 'browser') return this._startBrowser();
    if (source === 'extension') return this._startExtension();
    return this._startNative();
  }

  /**
   * 插件模式：不主动连接，等浏览器插件把抖音页面的原始帧 POST 过来。
   * 这条路最省事，也完全不怕抖音改签名算法。
   */
  async _startExtension(reason = '') {
    this._teardown();
    this.sourceName = 'extension';
    this.status = {
      state: 'online',
      detail: reason
        ? `等待浏览器插件转发弹幕（${reason}）`
        : '等待浏览器插件转发弹幕（需在 Chrome 里加载本项目 extension 目录）',
    };
    this.emit('status', { ...this.status, source: 'extension' });
    this.logger.info('插件模式：请在 Chrome 加载 extension 目录，并打开你的抖音直播间页面。');
    this.logger.info(`  扩展下载：http://127.0.0.1:${this.port}/extension.zip`);
    return { ok: true, source: 'extension', reason };
  }

  /** 插件转发的弹幕（由 HTTP /api/raw-frame 解析后喂进来） */
  feedChat(message) {
    if (!message) return;
    this.chatCount += 1;
    this.lastChatAt = Date.now();
    if (this.status.state !== 'online' || this.status.source !== 'extension') {
      this.status = { state: 'online', detail: '正在接收插件转发的弹幕', source: 'extension' };
      this.sourceName = this.sourceName || 'extension';
      this.emit('status', { ...this.status, source: 'extension' });
    }
    this.emit('chat', message);
    this.emit('message', message);
  }

  async _startMock() {
    this._teardown();
    const mock = new MockSource({}, this.logger);
    this._bind(mock, 'mock');
    await mock.start();
    this.sourceName = 'mock';
    return { ok: true, source: 'mock' };
  }

  _bind(source, name) {
    this.source = source;
    this.sourceName = name;
    source.on('chat', (msg) => {
      this.chatCount += 1;
      this.lastChatAt = Date.now();
      this.everReceivedChat = true;
      this.emit('chat', msg);
    });
    source.on('message', (msg) => this.emit('message', msg));
    source.on('status', (status) => {
      this.status = status;
      this.emit('status', { ...status, source: name });
    });
    source.on('ready', (info) => this.emit('ready', { ...info, source: name }));
    source.on('error', (err) => this.emit('source-error', err));
  }

  _teardown() {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.source) {
      try {
        // 先停循环，再关连接，避免重连时残留一个还在轮询的客户端
        if (typeof this.source.stop === 'function') this.source.stop();
        if (typeof this.source.close === 'function') this.source.close();
      } catch {
        /* ignore */
      }
      this.source.removeAllListeners();
      this.source = null;
      this.sourceName = null;
    }
  }

  async _startNative() {
    this._teardown();
    const cfg = this.config || {};
    const client = new DouyinDanmakuClient(
      {
        webRid: cfg.webRid,
        roomId: cfg.roomId,
        cookie: cfg.cookie,
        pollTimeoutMs: cfg.pollTimeoutMs,
        idleDelayMs: cfg.idleDelayMs,
        decompressOthers: cfg.decompressOthers === true,
        emitOtherMessages: cfg.emitOtherMessages === true,
        crossCheckCompanion: cfg.crossCheckCompanion !== false,
      },
      this.logger
    );
    this._bind(client, 'native');

    const before = this.chatCount;
    const connected = await client.connect().catch((err) => {
      this.logger.error('弹幕通道（HTTP 长轮询）启动失败：', err.message);
      this.emit('status', { state: 'error', detail: err.message, source: 'native' });
      return false;
    });

    if (!connected) {
      if (cfg.fallbackToBrowser) {
        this.logger.warn(`长轮询不可用（${client.lastErrorKind || '未知原因'}），自动切换到浏览器抓取模式...`);
        return this._startBrowser('长轮询失败');
      }
      this.sourceName = 'native';
      return { ok: false, source: 'native', reason: client.lastErrorKind || 'connect-failed' };
    }

    this.sourceName = 'native';

    // 连上了但一直没弹幕：可能是房间太冷清，也可能是通道被限制
    if (cfg.fallbackToBrowser) {
      const silenceMs = Number(cfg.silenceTimeoutMs || 90000);
      this.silenceTimer = setTimeout(() => {
        if (this.chatCount > before) return; // 期间收到过弹幕，说明通道是好的
        this.logger.warn(
          `${silenceMs / 1000}s 内没有收到任何弹幕。如果直播间明明很热闹，建议改用「插件转发」模式（最稳）。`
        );
        this._startBrowser('长轮询静默无数据').catch((err) => this.logger.error('切换浏览器模式失败：', err.message));
      }, silenceMs);
      if (this.silenceTimer.unref) this.silenceTimer.unref();
    }
    return { ok: true, source: 'native' };
  }

  async _startBrowser(reason = '') {
    this._teardown();
    const cfg = this.config || {};
    const browserCfg = cfg.browser || {};
    const source = new BrowserSource(
      {
        webRid: cfg.webRid,
        headless: browserCfg.headless !== false,
        channel: browserCfg.channel || '',
        userDataDir: browserCfg.userDataDir,
        executablePath: browserCfg.executablePath || '',
      },
      this.logger
    );
    this._bind(source, 'browser');
    try {
      await source.start();
      source.startWatchdog();
      this.sourceName = 'browser';
      if (reason) this.logger.info(`已切换为浏览器抓取模式（原因：${reason}）`);
      return { ok: true, source: 'browser', reason };
    } catch (err) {
      this.logger.error('浏览器抓取模式启动失败：', err.message);
      this.emit('status', { state: 'error', detail: err.message, source: 'browser' });
      // 最后一道兜底：等浏览器插件把弹幕推过来
      this.logger.warn('改为等待浏览器插件转发弹幕（extension 模式）。');
      return this._startExtension(`${reason ? `${reason}；` : ''}浏览器模式失败`);
    }
  }

  /** 手动投递弹幕（仅模拟源有效，也是控制台测试入口） */
  inject(line, nickname, userId) {
    if (this.sourceName === 'mock' && this.source && typeof this.source.inject === 'function') {
      return this.source.inject(line, nickname, userId);
    }
    return null;
  }

  async stop() {
    this._teardown();
    this.sourceName = null;
    this.status = { state: 'offline', detail: '已停止' };
  }
}

module.exports = { DanmakuService };
