'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { ensureDir } = require('./lib/util');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

class WebServer {
  /**
   * @param {object} deps
   * @param {object} deps.config
   * @param {import('events').EventEmitter} deps.engine
   * @param {import('events').EventEmitter} deps.danmaku
   * @param {object} deps.logger
   * @param {object} deps.app  回调集合：onConfigPatch / onManualSong / onDanmakuInject / onRestartDanmaku / onQuit
   */
  constructor(deps) {
    this.config = deps.config;
    this.engine = deps.engine;
    this.danmaku = deps.danmaku;
    this.logger = deps.logger;
    this.app = deps.app || {};
    /** 可选：把插件转发的原始帧解析成弹幕的回调 (hex) => chatMessage[] */
    this.frameDecoder = deps.frameDecoder || null;
    /** 可选：B站音频代理（解决 CDN Referer 校验导致的 403） */
    this.mediaProxy = deps.mediaProxy || null;
    this.publicDir = path.join(this.config.__paths.root, 'public');
    this.sockets = new Set();
    this.logBuffer = [];
    this.logSubscribers = new Set();
    this.server = http.createServer((req, res) => {
      // 【必须接住 Promise】_handleHttp 是 async 的，任何漏出去的异常都会变成
      // unhandledRejection，而 Node ≥15 默认直接结束进程 ——
      // 一个畸形请求就能把直播工具打挂。这里兜底成 500。
      this._handleHttp(req, res).catch((err) => {
        this.logger.warn(`处理 HTTP ${req.method} ${req.url} 出错：${err.message}`);
        try {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', ...this._corsHeaders() });
          }
          res.end(JSON.stringify({ ok: false, error: err.message }));
        } catch {
          /* 响应已经废了就算 */
        }
      });
    });
    // maxPayload：默认 100MB，一个超大帧就能吃光内存。这个程序的帧都很小。
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
    this.server.on('upgrade', (req, socket, head) => this._handleUpgrade(req, socket, head));
    this._startHeartbeat();
  }

  get port() {
    return this.config.server.port;
  }

  get host() {
    return this.config.server.host || '127.0.0.1';
  }

  get baseUrl() {
    return `http://${this.host === '0.0.0.0' ? '127.0.0.1' : this.host}:${this.port}`;
  }

  listen() {
    /**
     * 【跟踪 HTTP 连接】http.Server.close() 只是停止接受新连接，
     * 它会**一直等已有连接结束**（keep-alive 连接默认要挂很久）。
     * 不把这些 socket 记下来，关服务时就会"卡住不返回" ——
     * 测试里表现为测试进程不退，真实使用中表现为"点了停止但程序不退"。
     */
    if (!this.httpConns) {
      this.httpConns = new Set();
      this.server.on('connection', (socket) => {
        this.httpConns.add(socket);
        socket.on('close', () => this.httpConns.delete(socket));
      });
    }
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.removeListener('error', reject);
        resolve(this.baseUrl);
      });
    });
  }

  close() {
    if (this._hb) {
      clearInterval(this._hb);
      this._hb = null;
    }
    // 【必须 terminate 而不是 close】close() 是优雅关闭，要等对方回 close 帧；
    // 如果客户端已经不正常了（或者测试里被强行断开），这个等待可能永远不结束，
    // 连带 server.close() 的回调也不触发 —— 表现为"关服务时挂住"。
    for (const ws of this.sockets) {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
    }
    this.sockets.clear();
    try {
      this.wss.close();
    } catch {
      /* ignore */
    }
    // 强制关掉还挂着的 HTTP 连接（keep-alive 的会让 server.close() 一直等）
    if (this.httpConns) {
      for (const s of this.httpConns) {
        try {
          s.destroy();
        } catch {
          /* ignore */
        }
      }
      this.httpConns.clear();
    }
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      // 兜底：就算还有连接没断干净，2 秒后也强行返回。
      // 【不能 unref】unref 的定时器不"撑住"事件循环 —— 如果这时正好没有别的
      // 活跃句柄，进程会直接退出，这个兜底永远不会触发（测试里就是这么挂的）。
      setTimeout(finish, 2000);
      this.server.close(finish);
    });
  }

  /* ------------------------------- 日志 ------------------------------- */

  pushLog(line) {
    this.logBuffer.push(line);
    if (this.logBuffer.length > 300) this.logBuffer.shift();
  }

  /* ------------------------------ WebSocket ------------------------------ */

  _handleUpgrade(req, socket, head) {
    // 【安全】WebSocket **不受同源策略和 CORS 限制**：
    // 主播开着这个程序时，他浏览器里访问的任何网站都能连 ws://127.0.0.1:8787，
    // 而 updateConfig 能改配置并落盘。所以必须校验 Origin：
    // 只接受本机来源（页面上同源的 ws / 没有 Origin 的本地客户端）。
    const origin = req.headers.origin || '';
    if (origin && !this._isLocalOrigin(origin)) {
      this.logger.warn(`拒绝来自 ${origin} 的 WebSocket 连接（非本机来源）`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      ws.role = url.pathname.includes('audio') ? 'audio' : 'console';
      ws.clientId = Math.random().toString(36).slice(2, 9);
      ws.isAlive = true;
      this.sockets.add(ws);
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('close', () => {
        this.sockets.delete(ws);
        this._notifyStatus();
      });
      ws.on('error', () => {
        this.sockets.delete(ws);
        this._notifyStatus();
      });
      ws.on('message', (raw) => this._onClientMessage(ws, raw));
      this._send(ws, {
        type: 'hello',
        role: ws.role,
        clientId: ws.clientId,
        state: this.engine.getState(),
        status: this._status(),
        logs: ws.role === 'console' ? this.logBuffer.slice(-120) : [],
        urls: this._urls(),
      });
    });
  }

  /** 判断 Origin 是不是本机来源（127.0.0.1 / localhost / [::1]） */
  _isLocalOrigin(origin) {
    try {
      const u = new URL(origin);
      const h = u.hostname.replace(/^\[|\]$/g, '');
      return h === '127.0.0.1' || h === 'localhost' || h === '::1';
    } catch {
      return false;
    }
  }

  /**
   * WebSocket 心跳。
   *
   * 为什么需要：TCP 半开（拔网线、系统休眠、播放器被杀但没发 close）时
   * socket 会一直留在 this.sockets 里，_health() 就会一直报「有播放页在收音乐」，
   * 主播看到的是"一切正常"但实际没人接收音频。
   * 每 30 秒 ping 一次，上一轮没回 pong 的就判定为僵尸连接，踢掉。
   */
  _startHeartbeat() {
    this._hb = setInterval(() => {
      for (const ws of this.sockets) {
        if (ws.isAlive === false) {
          this.logger.debug('清理无响应的 WebSocket 连接（僵尸连接）');
          this.sockets.delete(ws);
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, 30000);
    if (this._hb.unref) this._hb.unref();
  }

  _status() {
    const audioClients = [...this.sockets].filter((ws) => ws.role === 'audio' && ws.readyState === ws.OPEN).length;
    // 【全部做防御性取值】_status() 会在 WebSocket 握手/断开时被调用，
    // 而 config 可能来自不完整的配置对象（测试、旧配置文件等）。
    // 原来直接写 this.config.bilibili.cookie，config 里没有 bilibili 段时
    // 会抛 TypeError —— 而且是在 ws 的 close 回调里抛，属于未捕获异常。
    const danmakuCfg = this.config.danmaku || {};
    const biliCfg = this.config.bilibili || {};
    return {
      danmaku: (this.danmaku && this.danmaku.status) || { state: 'idle', detail: '' },
      source: (this.danmaku && this.danmaku.activeName) || danmakuCfg.source || 'native',
      webRid: danmakuCfg.webRid || '',
      roomId: danmakuCfg.roomId || '',
      biliCookie: Boolean(biliCfg.cookie),
      audioClients,
      audioPageOpen: audioClients > 0,
      uptimeMs: process.uptime() * 1000,
      node: process.version,
    };
  }

  _urls() {
    return {
      base: this.baseUrl,
      console: `${this.baseUrl}/`,
      audio: `${this.baseUrl}/audio`,
      launcher: `${this.baseUrl}/launcher`,
      overlay: `${this.baseUrl}/overlay`,
      extensionZip: `${this.baseUrl}/extension.zip`,
    };
  }

  /** 健康检查：给外部探针/自恢复用，能看出「服务活着但弹幕挂了」 */
  _health() {
    const mem = process.memoryUsage();
    const danmakuState = (this.danmaku.status && this.danmaku.status.state) || 'unknown';
    const audioClients = [...this.sockets].filter((ws) => ws.role === 'audio' && ws.readyState === ws.OPEN).length;
    const stats = this.engine.stats || {};
    const unhealthy = [];
    // 防御性取值：config 里没有 danmaku 段时不该抛异常（健康检查必须永远能返回）
    const danmakuCfg = this.config.danmaku || {};
    const source = String(danmakuCfg.source || 'native').toLowerCase();
    if (!danmakuCfg.webRid && source !== 'mock') {
      unhealthy.push('还没配置直播间号（控制台里填一下）');
    } else if (danmakuState !== 'online' && source !== 'mock') {
      unhealthy.push('弹幕通道未连接');
    }
    if (!audioClients) unhealthy.push('没有播放页在接收音乐');
    if (mem.heapUsed > 900 * 1024 * 1024) unhealthy.push('内存占用偏高');
    return {
      ok: unhealthy.length === 0,
      at: Date.now(),
      uptimeMs: Math.round(process.uptime() * 1000),
      issues: unhealthy,
      danmaku: { state: danmakuState, source: this.danmaku.activeName || source },
      audioClients,
      memoryMB: {
        heapUsed: Math.round(mem.heapUsed / 1048576),
        heapTotal: Math.round(mem.heapTotal / 1048576),
        rss: Math.round(mem.rss / 1048576),
      },
      counters: {
        chatSeen: stats.chatSeen || 0,
        requests: stats.requests || 0,
        played: stats.played || 0,
        failed: stats.failed || 0,
        rejected: stats.rejected || 0,
        retried: stats.retried || 0,
        recovered: stats.recovered || 0,
      },
    };
  }

  /** 排障信息：出问题时一条命令就能看到全貌 */
  _diagnostics() {
    const health = this._health();
    const danmakuStats =
      this.danmaku.source && typeof this.danmaku.source.stats === 'object' ? this.danmaku.source.stats : null;
    return {
      health,
      config: this._sanitizedConfig(),
      urls: this._urls(),
      danmaku: {
        source: this.danmaku.activeName || this.config.danmaku.source,
        status: this.danmaku.status,
        chats: this.danmaku.chatCount,
        lastChatAt: this.danmaku.lastChatAt,
        everReceivedChat: this.danmaku.everReceivedChat,
        detail: danmakuStats,
      },
      engine: {
        mode: this.engine.mode,
        current: this.engine.current ? this.engine.current.song : null,
        queueLength: this.engine.queue.size,
        pendingRetries: this.engine.pendingRetries.map((it) => `${it.entry.song}（${it.attempt}）`),
        biliCache: {
          search: this.engine.bili.cache ? this.engine.bili.cache.size : 0,
          view: this.engine.bili.viewCache ? this.engine.bili.viewCache.size : 0,
        },
      },
      mediaProxy: this.mediaProxy ? this.mediaProxy.stats : null,
      memoryMB: health.memoryMB,
      node: process.version,
      platform: process.platform,
    };
  }

  _send(ws, payload) {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  broadcast(payload) {
    const text = JSON.stringify(payload);
    for (const ws of this.sockets) {
      if (ws.readyState !== ws.OPEN) continue;
      // 日志只发给控制台
      if (payload.type === 'log' && ws.role !== 'console') continue;
      try {
        ws.send(text);
      } catch {
        /* ignore */
      }
    }
  }

  /** 播放页连接/断开时，让控制台知道「现在有没有人负责出声」 */
  _notifyStatus() {
    this.broadcast({ type: 'status', status: this._status(), urls: this._urls() });
  }

  async _onClientMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const { type } = msg;
    try {
      switch (type) {
        case 'skip':
          this.engine.skip('manual');
          break;
        case 'pause':
          this.broadcast({ type: 'command', cmd: 'pause' });
          break;
        case 'resume':
          this.broadcast({ type: 'command', cmd: 'resume' });
          break;
        case 'stop':
          this.engine.skip('manual');
          break;
        case 'ended':
          this.engine.onEnded(msg.id);
          break;
        case 'playError':
          this.engine.onError(msg.id, msg.message);
          break;
        case 'reloadMedia': {
          // 播放页的音频地址过期了，重新解析一次直链并发给它
          const entry = this.engine.current && this.engine.current.id === msg.id ? this.engine.current : null;
          if (entry) {
            try {
              const payload = await this.engine.buildPlayPayload(entry);
              entry.pick.mediaUrl = payload.audioUrl || entry.pick.mediaUrl;
              this.broadcast({ type: 'play', ...payload });
            } catch (err) {
              this.logger.warn(`重新获取音频地址失败：${err.message}`);
              this.broadcast({ type: 'playError', id: msg.id, message: err.message });
            }
          }
          break;
        }
        case 'volume': {
          // 【必须校验】msg.value 是 'abc' / {} / undefined 时 Number() 得到 NaN，
          // 会被直接写进配置并落盘（JSON.stringify(NaN) → null），
          // 而播放页的 `Number(v) || 0` 会把它变成 0 —— 整场直播静音且不报错。
          const v = Number(msg.value);
          if (!Number.isFinite(v)) {
            this.logger.warn(`忽略非法的音量值：${JSON.stringify(msg.value)}`);
            break;
          }
          const clamped = Math.min(1, Math.max(0, v));
          this.config.playback.volume = clamped;
          this.broadcast({ type: 'volume', value: clamped });
          if (this.app.onConfigPatch) this.app.onConfigPatch({ playback: { volume: clamped } });
          break;
        }
        case 'toggleMute':
          this.muted = !this.muted;
          this.broadcast({ type: 'mute', value: this.muted });
          break;
        case 'setMode':
          this.engine.setMode(msg.mode);
          if (this.app.onConfigPatch) this.app.onConfigPatch({ playback: { mode: msg.mode } });
          break;
        case 'manualSong':
          if (this.app.onManualSong) await this.app.onManualSong(msg);
          break;
        case 'injectDanmaku':
          if (this.app.onDanmakuInject) this.app.onDanmakuInject(msg.text, msg.nickname);
          break;
        case 'clearQueue':
          this.engine.clearQueue();
          break;
        case 'undo':
          await this.engine.undoLast();
          break;
        case 'retryNow': {
          // 手动立刻重试那些因风控暂时没搜到的点歌
          if (this.app.onRetryNow) await this.app.onRetryNow();
          break;
        }
        case 'removeQueueItem':
          this.engine.queue.remove(msg.id);
          this.engine.broadcastState();
          break;
        case 'promote':
          this.engine.promote(msg.id);
          break;
        case 'switchCandidate':
          await this.engine.switchCandidate(msg.id, msg.bvid);
          break;
        case 'restartDanmaku':
          if (this.app.onRestartDanmaku) await this.app.onRestartDanmaku();
          break;
        case 'updateConfig':
          if (this.app.onConfigPatch) await this.app.onConfigPatch(msg.patch || {});
          break;
        case 'ping':
          this._send(ws, { type: 'pong', at: Date.now() });
          break;
        default:
          this.logger.debug(`未知的客户端消息：${type}`);
      }
    } catch (err) {
      this.logger.warn(`处理客户端消息 ${type} 失败：${err.message}`);
    }
  }

  /* -------------------------------- HTTP -------------------------------- */

  async _handleHttp(req, res) {
    // 【安全】URL 解析必须在 try 里 —— 实测 `GET /%` 这种残缺百分号编码
    // 会让 decodeURIComponent 抛 URIError，而这个 async 处理函数的返回值
    // 没人接，异常会变成 unhandledRejection，Node ≥15 默认直接结束进程。
    // 也就是任何网页 fetch 一下就能把主播的点歌程序打挂。
    //
    // 注意：url 必须声明在 try **外面**（用 let）—— 下面的 /api/img 等分支
    // 还要用它的 searchParams。之前写成 const 在 try 内，块外访问会抛
    // ReferenceError，表现成这些接口全部 500。
    let pathname = '/';
    let url = null;
    try {
      url = new URL(req.url || '/', this.baseUrl);
      pathname = decodeURIComponent(url.pathname);
    } catch (err) {
      // 非法 URL / 非法百分号编码：返回 400，不要影响进程
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...this._corsHeaders() });
      res.end('bad request url');
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, this._corsHeaders());
      res.end();
      return;
    }

    try {
      if (pathname === '/favicon.ico' || pathname === '/favicon.svg') return this._serveFavicon(res);
      if (pathname === '/api/state') return this._json(res, this.engine.getState());
      if (pathname === '/api/status')
        return this._json(res, { status: this._status(), urls: this._urls(), config: this._sanitizedConfig() });
      if (pathname === '/api/health') return this._json(res, this._health());
      if (pathname === '/api/diagnostics') return this._json(res, this._diagnostics());

      if (pathname === '/api/song' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const result = await this.engine.requestSong({
          song: body.song,
          nickname: body.nickname || '主播手动',
          userId: body.userId || 'console',
          message: body.song || '',
          force: true,
        });
        return this._json(res, result);
      }

      if (pathname === '/api/skip' && req.method === 'POST') {
        this.engine.skip('http');
        return this._json(res, { ok: true });
      }

      if (pathname === '/api/undo' && req.method === 'POST') {
        const result = await this.engine.undoLast();
        return this._json(res, result);
      }

      if (pathname === '/api/clear' && req.method === 'POST') {
        return this._json(res, { ok: true, cleared: this.engine.clearQueue() });
      }

      if (pathname === '/api/mode' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        return this._json(res, { ok: true, mode: this.engine.setMode(body.mode) });
      }

      if (pathname === '/api/search') {
        const song = url.searchParams.get('q') || '';
        const result = await this.engine.bili.searchSong(song);
        return this._json(res, result);
      }

      if (pathname === '/api/inject' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (this.app.onDanmakuInject) this.app.onDanmakuInject(body.text, body.nickname);
        return this._json(res, { ok: true });
      }

      // 浏览器插件转发过来的抖音原始帧（十六进制）
      if (pathname === '/api/raw-frame' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const messages = this.frameDecoder ? this.frameDecoder(body.hex) : [];
        for (const msg of messages) {
          if (this.danmaku && typeof this.danmaku.feedChat === 'function') this.danmaku.feedChat(msg);
          else this.engine.handleChat(msg);
        }
        if (this.app.onFrame) this.app.onFrame(messages.length);
        return this._json(res, { ok: true, chats: messages.length });
      }

      if (pathname === '/api/img') return this._proxyImage(url, res);
      if (pathname === '/extension.zip') return this._serveExtensionZip(res);
      if (pathname.startsWith('/media/')) {
        if (!this.mediaProxy) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('media proxy disabled');
          return;
        }
        const key = decodeURIComponent(pathname.slice('/media/'.length));
        return this.mediaProxy.handle(req, res, key);
      }

      return this._serveStatic(pathname, res);
    } catch (err) {
      this.logger.error(`HTTP ${pathname} 出错：`, err.message);
      this._json(res, { ok: false, error: err.message }, 500);
    }
  }

  _corsHeaders() {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
  }

  /** 内联一个音符小图标，省掉浏览器的 404 */
  _serveFavicon(res) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0d1117"/><path d="M43 12v27.5a8.5 8.5 0 1 1-4-7.2V19l-14 3.6v21.9a8.5 8.5 0 1 1-4-7.2V17.4z" fill="#00aeec"/><circle cx="23" cy="48" r="4" fill="#ff2d55"/></svg>`;
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=86400',
    });
    res.end(svg);
  }

  _json(res, data, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...this._corsHeaders(),
    });
    res.end(body);
  }

  _sanitizedConfig() {
    const clone = JSON.parse(JSON.stringify(this.config));
    clone.bilibili = clone.bilibili || {};
    if (clone.bilibili.cookie) clone.bilibili.cookie = '***已配置***';
    clone.danmaku = clone.danmaku || {};
    if (clone.danmaku.cookie) clone.danmaku.cookie = '***已配置***';
    delete clone.__paths;
    delete clone.__flags;
    return clone;
  }

  /** B站图片防盗链：服务端代取一次再吐给页面 */
  async _proxyImage(url, res) {
    let target = url.searchParams.get('u');
    if (!target) {
      res.writeHead(400);
      res.end('missing u');
      return;
    }
    // 【必须补齐协议】B 站搜索接口返回的封面是**协议相对** URL
    // （形如 `//i0.hdslb.com/bfs/archive/xxx.jpg`），`new URL()` 直接解析会抛错。
    // 不补的话封面图全部 400，悬浮窗和控制台上的封面就是坏的。
    if (target.startsWith('//')) target = 'https:' + target;
    else if (/^[\w.-]+\.[a-z]{2,}\//i.test(target)) target = 'https://' + target;

    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      res.writeHead(400);
      res.end('bad url');
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      res.writeHead(400);
      res.end('bad protocol');
      return;
    }
    const allowed = /(^|\.)(hdslb\.com|bilibili\.com|douyinpic\.com|douyincdn\.com|bytedance\.com)$/i;
    if (!allowed.test(parsed.hostname)) {
      res.writeHead(403);
      res.end('host not allowed');
      return;
    }

    // 【超时 + 大小上限】这是个未鉴权的 GET 接口，上游慢/不回包时
    // 这个请求会一直挂着，而 arrayBuffer() 是全量进内存 ——
    // 几十个并发大图就能把内存和连接数顶上去。封面图本来就很小（几十 KB）。
    const MAX_BYTES = 5 * 1024 * 1024;
    let upstream;
    try {
      upstream = await fetch(target, {
        headers: {
          Referer: 'https://www.bilibili.com/',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      const timedOut = err.name === 'TimeoutError';
      res.writeHead(timedOut ? 504 : 502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(timedOut ? 'upstream timeout' : 'upstream failed');
      return;
    }

    if (!upstream.ok) {
      try {
        await upstream.body?.cancel();
      } catch {
        /* ignore */
      }
      res.writeHead(upstream.status);
      res.end('upstream error');
      return;
    }

    // content-length 能提前判断就提前拒绝，省得把大文件读进内存
    const len = Number(upstream.headers.get('content-length') || 0);
    if (len > MAX_BYTES) {
      try {
        await upstream.body?.cancel();
      } catch {
        /* ignore */
      }
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('image too large');
      return;
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      res.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('image too large');
      return;
    }

    res.writeHead(200, {
      'Content-Type': upstream.headers.get('content-type') || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      ...this._corsHeaders(),
    });
    res.end(buf);
  }

  _serveStatic(pathname, res) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    if (rel === '/audio') rel = '/audio.html';
    if (rel === '/launcher') rel = '/launcher.html';
    // 歌单悬浮层（给直播伴侣做窗口捕获用，背景透明）
    if (rel === '/overlay') rel = '/overlay.html';
    const filePath = path.join(this.publicDir, path.normalize(rel).replace(/^([/\\])+/, ''));
    // 包含性检查要带上路径分隔符：纯字符串前缀比较会让 `public-backup/x`
    // 这种同级目录也通过检查（现在目录树里没有这种目录，但写法本身不安全）。
    const rootPrefix = this.publicDir.endsWith(path.sep) ? this.publicDir : this.publicDir + path.sep;
    if (filePath !== this.publicDir && !filePath.startsWith(rootPrefix)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...this._corsHeaders(),
      });
      res.end(data);
    });
  }

  /** 打一个扩展 zip 包给主播下载（没装 7zip 也能用，用最小 ZIP 实现） */
  _serveExtensionZip(res) {
    const dir = path.join(this.config.__paths.root, 'extension');
    if (!fs.existsSync(dir)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('extension 目录不存在');
      return;
    }
    const files = [];
    const walk = (current, prefix = '') => {
      for (const name of fs.readdirSync(current)) {
        const full = path.join(current, name);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full, `${prefix}${name}/`);
        else files.push({ name: `${prefix}${name}`, full, mtime: stat.mtime });
      }
    };
    walk(dir);
    const zip = buildZip(files);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="douyin-song-request-extension.zip"',
      ...this._corsHeaders(),
    });
    res.end(zip);
  }
}

/** 极简 ZIP（store 模式，无压缩）实现，避免引入第三方依赖 */
function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = fs.readFileSync(file.full);
    const nameBuf = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(0, 8);
    centralEntry.writeUInt16LE(0, 10);
    centralEntry.writeUInt16LE(0, 12);
    centralEntry.writeUInt16LE(0, 14);
    centralEntry.writeUInt32LE(crc, 16);
    centralEntry.writeUInt32LE(data.length, 20);
    centralEntry.writeUInt32LE(data.length, 24);
    centralEntry.writeUInt16LE(nameBuf.length, 28);
    centralEntry.writeUInt16LE(0, 30);
    centralEntry.writeUInt16LE(0, 32);
    centralEntry.writeUInt16LE(0, 34);
    centralEntry.writeUInt16LE(0, 36);
    centralEntry.writeUInt32LE(0, 38);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

module.exports = { WebServer, ensureDir };
