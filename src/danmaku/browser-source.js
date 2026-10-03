'use strict';

const EventEmitter = require('events');
const path = require('path');
const protocol = require('./protocol');
const { ensureDir, sleep } = require('../lib/util');

/**
 * 浏览器兜底弹幕源：用 Playwright 打开真实的抖音直播间页面，
 * 监听页面自己的 WebSocket 帧并解析弹幕。
 *
 * 优点：完全复用抖音自己的签名逻辑，协议升级也不用改代码。
 * 缺点：需要安装 playwright（含 Chromium，约 150MB），启动慢一些。
 */
class BrowserSource extends EventEmitter {
  constructor(options = {}, logger) {
    super();
    this.options = options;
    this.logger = logger || console;
    this.name = 'browser';
    this.started = false;
    this.chatCount = 0;
    this.reloadTimer = null;
  }

  async _loadPlaywright() {
    for (const name of ['playwright', 'playwright-core']) {
      try {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const mod = require(name);
        this.playwrightName = name;
        return mod;
      } catch {
        /* 继续尝试 */
      }
    }
    throw new Error(
      '浏览器兜底模式需要 playwright，请在本项目目录执行：\n' +
        '  npm i playwright-core\n' +
        '（已装 Chrome/Edge 的话不用再下载 Chromium，脚本会自动用系统浏览器）\n' +
        '或者改用协议直连/插件转发模式（config.json 里 danmaku.source）。'
    );
  }

  /** 找系统已安装的 Chrome/Edge，省掉 150MB 浏览器下载 */
  _detectBrowserPath() {
    if (this.options.executablePath) return this.options.executablePath;
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
    const fs = require('fs');
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
    return '';
  }

  async start() {
    const webRid = String(this.options.webRid || '').trim();
    if (!webRid) throw new Error('浏览器兜底模式需要在 config.json 里填 danmaku.webRid');
    const { chromium } = await this._loadPlaywright();

    const userDataDir = this.options.userDataDir
      ? path.resolve(this.options.userDataDir)
      : path.resolve(process.cwd(), '.browser-profile');
    ensureDir(userDataDir);

    const launchOptions = {
      headless: this.options.headless !== false,
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-sandbox'],
      viewport: { width: 1280, height: 800 },
    };
    const executablePath = this._detectBrowserPath();
    if (executablePath) {
      launchOptions.executablePath = executablePath;
      this.logger.debug(`使用系统浏览器：${executablePath}`);
    }
    if (this.options.channel) launchOptions.channel = this.options.channel;
    if (!launchOptions.headless) launchOptions.args.push('--start-minimized');

    this.emit('status', { state: 'connecting', detail: '启动浏览器抓取弹幕...' });
    this.logger.info('启动 Chromium 监听直播间弹幕（首次可能较慢）...');
    this.context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    this.page = this.context.pages()[0] || (await this.context.newPage());

    this._bindPage(this.page);
    await this._goto(webRid);

    this.started = true;
    this.emit('status', { state: 'online', detail: '浏览器抓取弹幕中' });
    return true;
  }

  async _goto(webRid) {
    const url = `https://live.douyin.com/${webRid}`;
    this.logger.info(`打开直播间页面：${url}`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((err) => {
      this.logger.warn(`页面打开超时/失败：${err.message}`);
    });
  }

  _bindPage(page) {
    page.on('websocket', (ws) => {
      const url = ws.url();
      if (!/webcast|douyin/.test(url)) return;
      this.logger.debug(`发现页面 WebSocket：${url.slice(0, 160)}`);
      ws.on('framereceived', (frame) => {
        try {
          const buffer = this._frameToBuffer(frame);
          if (!buffer || !buffer.length) return;
          this.lastChatAt = this.lastChatAt || Date.now();
          this._onFrame(buffer);
        } catch (err) {
          this.logger.debug('网页帧解析失败:', err.message);
        }
      });
    });

    page.on('close', () => {
      this.emit('status', { state: 'offline', detail: '浏览器页面已关闭' });
    });
    page.on('crash', () => {
      this.emit('status', { state: 'error', detail: '浏览器页面崩溃' });
      this._scheduleReload();
    });
  }

  _frameToBuffer(frame) {
    if (!frame) return null;
    if (frame.payloadBuffer) {
      try {
        const buf = frame.payloadBuffer();
        if (buf && buf.length) return Buffer.from(buf);
      } catch {
        /* 某些类型没有 buffer 视图 */
      }
    }
    const payload = frame.payload;
    if (typeof payload === 'string') {
      // 抖音页面收到的二进制帧会被 playwright 以 base64 字符串给出
      try {
        const buf = Buffer.from(payload, 'base64');
        if (buf.length) return buf;
      } catch {
        return null;
      }
      return null;
    }
    if (payload instanceof ArrayBuffer) return Buffer.from(payload);
    return null;
  }

  _onFrame(buffer) {
    let frame;
    try {
      frame = protocol.decodePushFrame(buffer);
    } catch {
      return;
    }
    if (frame.payloadType !== 0 || !frame.payload.length) return;
    const response = protocol.decodeResponse(frame.payload);
    for (const msg of response.messages) {
      const decoded = protocol.decodeMessage(msg);
      if (!decoded) continue;
      if (decoded.type === 'chat') {
        this.chatCount += 1;
        this.lastChatAt = Date.now();
        this.emit('chat', decoded);
      }
      this.emit('message', decoded);
    }
  }

  _scheduleReload() {
    if (this.reloadTimer) return;
    this.reloadTimer = setTimeout(async () => {
      this.reloadTimer = null;
      if (!this.started || !this.page) return;
      this.logger.warn('正在重新加载直播间页面以恢复弹幕...');
      await this._goto(this.options.webRid).catch(() => {});
      await sleep(1500);
    }, 5000);
    if (this.reloadTimer.unref) this.reloadTimer.unref();
  }

  /** 页面长时间收不到弹幕时主动刷一下（只在「本来能收到、后来断了」时才刷） */
  startWatchdog(idleMs = 180000) {
    this.watchdog = setInterval(async () => {
      if (!this.started || !this.page) return;
      if (!this.chatCount) return; // 从来没收到过，刷新也没用（房间冷清）
      this.lastChatAt = this.lastChatAt || Date.now();
      const idle = Date.now() - this.lastChatAt;
      if (idle > idleMs) {
        this.logger.warn(`${Math.round(idle / 1000)}s 没收到弹幕，刷新直播间页面...`);
        this.lastChatAt = Date.now();
        await this._goto(this.options.webRid).catch(() => {});
      }
    }, 30000);
    if (this.watchdog.unref) this.watchdog.unref();
  }

  async stop() {
    this.started = false;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    this.emit('status', { state: 'offline', detail: '浏览器弹幕源已停止' });
  }
}

module.exports = { BrowserSource };
