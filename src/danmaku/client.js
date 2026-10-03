'use strict';

const EventEmitter = require('events');
const protocol = require('./protocol');
const sign = require('./sign');
const { sleep } = require('../lib/util');

/**
 * 抖音弹幕客户端（HTTP 长轮询实现）
 *
 * 为什么不直连 WebSocket：
 *   经实测（见 _probe_douyin/FINDINGS.md），wss 直连会被 CDN 判定 DEVICE_BLOCKED
 *   （表现为 HTTP 200 + handshake-status: 415，ws 库只看到 close 1006），
 *   换域名/换签名/带完整浏览器 Cookie/在真实 Chrome 里新建连接都无效——那是设备信誉判定。
 *   而同一份数据用 HTTP 长轮询 GET /webcast/im/fetch/ 就能拿到，
 *   **不需要 signature、不需要 X-Bogus、不需要登录**。
 *
 * 流程：
 *   1) GET 直播间页面拿 ttwid（可选，不带也能通）
 *   2) GET /webcast/room/web/enter/?web_rid=xxx  -> 真实 roomId、开播状态
 *   3) 循环 GET /webcast/im/fetch/?...&cursor=上次的cursor，protobuf 响应解出弹幕
 *
 * 事件：'ready' / 'message' / 'chat' / 'status' / 'error'
 */
class DouyinDanmakuClient extends EventEmitter {
  constructor(options = {}, logger) {
    super();
    this.webRid = String(options.webRid || '').trim();
    this.roomId = String(options.roomId || '').trim();
    /** 是否由调用方明确指定了 roomId（指定了就完全尊重它） */
    this.explicitRoomId = Boolean(this.roomId);
    /** 是否用直播伴侣的数据交叉核对房间（默认开，调试时可关） */
    this.crossCheckCompanion = options.crossCheckCompanion !== false;
    this.userUniqueId = String(options.userUniqueId || sign.randomDigits(19));
    this.cookie = options.cookie || '';
    this.logger = logger || console;
    this.pollTimeoutMs = Number(options.pollTimeoutMs || 25000);
    this.idleDelayMs = Number(options.idleDelayMs || 800);
    this.maxErrors = Number(options.maxErrors || 6);
    /** 只关心弹幕时跳过非弹幕消息的解压与派发（默认开，实测省 60% 解压开销） */
    this.decompressOthers = options.decompressOthers === true;
    this.emitOtherMessages = options.emitOtherMessages === true;
    this.closed = false;
    this.cursor = '';
    this.internalExt = '';
    this.cookies = {};
    this.nickname = '';
    this.roomStatus = null;
    this.messageCount = 0;
    this.chatCount = 0;
    this.lastMessageAt = 0;
    this.lastErrorKind = '';
    this.rounds = 0;
    this.consecutiveErrors = 0;
  }

  get connected() {
    return !this.closed && this.rounds > 0;
  }

  /* --------------------------- 第一步：解析房间 --------------------------- */

  /**
   * 解析出可以用的 roomId。
   *
   * 顺序：
   *   1) 配置里的 roomId（有就直接用）
   *   2) 用配置的 webRid 调抖音房间接口
   *   3) 从本机直播伴侣的数据里读真实 roomId 兜底（换号/号码变了也能自愈）
   */
  async prepare() {
    if (!this.webRid && !this.roomId) {
      throw new Error('缺少直播间号：请在 config.json 填 danmaku.webRid（live.douyin.com/ 后面的那串数字）');
    }

    if (this.webRid) {
      // 顺带拿一份 ttwid（抓不到也不影响）
      try {
        const page = await sign.fetchWebCookies(this.webRid, this.logger);
        this.cookies = page.cookies || {};
      } catch {
        /* ignore */
      }

      const info = await sign.fetchRoomInfo(this.webRid, this.cookie || sign.cookieHeader(this.cookies), this.logger);
      if (info && info.roomId) {
        this.roomId = info.roomId;
        this.nickname = info.nickname || this.nickname;
        this.roomStatus = info.status;
        this.logger.info(
          `房间已就绪：roomId=${this.roomId}${this.nickname ? `，主播=${this.nickname}` : ''}` +
            (info.status === 4 ? '（当前显示已下播）' : info.status === 2 ? '（直播中）' : '')
        );

        // 和直播伴侣记的场次核对一下，避免连到别人房间（例如换了账号）
        this._crossCheckWithCompanion(info);
        return { roomId: this.roomId, nickname: this.nickname, status: this.roomStatus };
      }

      this.logger.warn(`房间接口没查到「${this.webRid}」，尝试用本机直播伴侣的数据兜底...`);
    }

    // 兜底：直接读本机直播伴侣记录的 roomId
    const fallback = this._roomIdFromCompanion();
    if (fallback) {
      this.roomId = fallback;
      this.logger.info(`已从直播伴侣数据读取 roomId=${this.roomId}（本次直播场次）`);
      return { roomId: this.roomId, nickname: this.nickname, status: this.roomStatus };
    }

    if (this.roomId) {
      this.logger.debug(`使用配置的 roomId=${this.roomId}`);
      return { roomId: this.roomId, nickname: this.nickname, status: this.roomStatus };
    }

    throw new Error(
      `没能解析出 roomId（直播间号 ${this.webRid}）。请确认号码正确、直播间存在；` +
        '也可以在 config.json 里直接填 danmaku.roomId。'
    );
  }

  /** 读本机直播伴侣当前场次的 roomId */
  _roomIdFromCompanion() {
    try {
      const { readCompanionInfo } = require('../lib/companion');
      const info = readCompanionInfo();
      if (!info.available) return '';
      if (info.nickname && !this.nickname) this.nickname = info.nickname;
      return info.roomId || '';
    } catch (err) {
      this.logger.debug(`读取直播伴侣数据失败：${err.message}`);
      return '';
    }
  }

  /**
   * 交叉核对：抖音接口返回的 roomId 应该和直播伴侣记录的最近场次一致。
   *
   * 默认开启，但**非常保守**：
   *   - 只有「配置的号查出来的主播」和「直播伴侣里的主播」**昵称不同**时才认为是连错了；
   *   - 昵称相同（同一个主播的不同场次）不动；
   *   - 配置了 roomId 时完全不干预（调用方已经明确指定了房间）。
   * 想关闭：config.json 里 danmaku.crossCheckCompanion = false
   * （做弹幕调试、或故意监听别人的直播间时要关掉）
   */
  _crossCheckWithCompanion(apiInfo) {
    if (this.crossCheckCompanion === false) return;
    if (this.explicitRoomId) return; // 调用方明确指定了 roomId，尊重它
    try {
      const { readCompanionInfo } = require('../lib/companion');
      const local = readCompanionInfo();
      if (!local.available || !local.roomId) return;
      if (local.roomId === apiInfo.roomId) {
        this.logger.debug('房间号已和直播伴侣记录核对一致');
        return;
      }
      // 昵称一致说明是同一个主播的不同场次，属于正常情况，不用改
      if (local.nickname && apiInfo.nickname && local.nickname === apiInfo.nickname) {
        this.logger.debug(`直播伴侣记录的是另一场（${local.roomId}），当前场次为 ${apiInfo.roomId}`);
        return;
      }
      this.logger.warn(
        `配置的直播间号指向「${apiInfo.nickname}」，但本机直播伴侣最近开播的是「${local.nickname || '未知'}」。` +
          `已自动改用你本机的 roomId=${local.roomId}，避免连错房间。` +
          '（想监听别人直播间请把 danmaku.crossCheckCompanion 设为 false）'
      );
      this.roomId = local.roomId;
      if (local.nickname) this.nickname = local.nickname;
    } catch (err) {
      this.logger.debug(`交叉核对失败（忽略）：${err.message}`);
    }
  }

  /* --------------------------- 第二步：长轮询 --------------------------- */

  async connect() {
    this.closed = false;
    const prepared = await this.prepare();
    this.emit('status', { state: 'connecting', detail: '正在建立弹幕长轮询...' });

    const ok = await this._pollOnce({ silent: true });
    if (!ok) {
      this.emit('status', { state: 'error', detail: this.lastErrorKind || '首次轮询失败' });
      return false;
    }
    this.rounds = Math.max(this.rounds, 1);
    this.emit('status', { state: 'online', detail: '弹幕长轮询已连接（HTTP）' });
    this.emit('ready', { roomId: this.roomId, webRid: this.webRid, nickname: this.nickname });
    this.logger.info(`弹幕通道已连接（HTTP 长轮询，roomId=${this.roomId}）`);
    this._loop();
    return prepared;
  }

  async _loop() {
    while (!this.closed) {
      try {
        const ok = await this._pollOnce();
        if (ok) {
          this.consecutiveErrors = 0;
        } else {
          this.consecutiveErrors += 1;
        }
      } catch (err) {
        this.consecutiveErrors += 1;
        this.logger.debug(`轮询异常：${err.message}`);
      }

      if (this.closed) break;

      if (this.consecutiveErrors >= this.maxErrors) {
        this.logger.warn(`${this.maxErrors} 次轮询连续失败，暂停 15 秒后重试...`);
        this.emit('status', { state: 'error', detail: this.lastErrorKind || '轮询连续失败' });
        await sleep(15000);
        this.consecutiveErrors = 0;
        continue;
      }
      if (this.consecutiveErrors > 0) {
        await sleep(Math.min(8000, 500 * 2 ** this.consecutiveErrors));
        continue;
      }
      await sleep(this.idleDelayMs);
    }
  }

  /** 一次长轮询；silent=true 时不发状态事件（用于首次探测） */
  async _pollOnce({ silent = false } = {}) {
    const url = sign.buildFetchUrl({
      roomId: this.roomId,
      webRid: this.webRid,
      userUniqueId: this.userUniqueId,
      cursor: this.cursor,
      internalExt: this.internalExt,
    });
    const cookie = this.cookie || sign.cookieHeader(this.cookies);
    const headers = {
      ...sign.DY_HEADERS,
      Accept: 'application/x-protobuf, application/octet-stream, */*',
      // 让服务端用 gzip 压缩响应体，省带宽（弹幕频道动辄几十 KB/次）
      'Accept-Encoding': 'gzip',
    };
    if (cookie) headers.Cookie = cookie;
    if (this.cursor) headers['x-ms-cursor'] = this.cursor;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.pollTimeoutMs);
    // 【超时必须覆盖读 body】原来在拿到响应头后就 clearTimeout 了，
    // 而抖音长轮询是 chunked 流式返回：如果连接被中间设备「半开」
    // （收到头，body 再也不来也不断），下面那句 arrayBuffer() 会永久 pending ——
    // _pollOnce 不返回 → _loop 卡死 → 不重连、错误计数不增长，
    // 而状态还显示 online，控制台看起来"一切正常"。
    // 所以这里把清理放到读完 body 之后（用 finally 保证一定清）。
    let res;
    try {
      res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
    } catch (err) {
      clearTimeout(timer);
      this.lastErrorKind =
        err.name === 'AbortError' ? `长轮询超时（${this.pollTimeoutMs}ms）` : `网络错误：${err.message}`;
      if (!silent) this.logger.debug(this.lastErrorKind);
      return false;
    }

    if (!res.ok) {
      clearTimeout(timer);
      this.lastErrorKind = `HTTP ${res.status}`;
      if (!silent) this.logger.warn(`弹幕轮询返回 ${res.status}`);
      // 未成功时也要把响应体放掉，否则连接回不到 keep-alive 池
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return false;
    }

    let buffer;
    try {
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      this.lastErrorKind =
        err.name === 'AbortError' ? `读取响应体超时（${this.pollTimeoutMs}ms）` : `读取响应失败：${err.message}`;
      if (!silent) this.logger.debug(this.lastErrorKind);
      return false;
    } finally {
      clearTimeout(timer);
    }
    // 万一服务端没按 gzip 返回而给的是压缩体，这里兼容一下
    if (buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) {
      buffer = protocol.gunzip(buffer);
    }
    if (!buffer.length) {
      // 空响应也算一次成功轮询（房间冷清时会这样）
      this.rounds += 1;
      return true;
    }

    const response = protocol.decodeResponse(buffer, { decompressOthers: this.decompressOthers });
    this.rounds += 1;
    if (response.cursor) this.cursor = response.cursor;
    if (response.internalExt) this.internalExt = response.internalExt;

    if (!this._firstDataLogged && response.messages.length) {
      this._firstDataLogged = true;
      const skipped = response.messages.filter((m) => m.payloadSkipped).length;
      this.logger.info(
        `已收到第一帧弹幕数据（${response.messages.length} 条消息，${buffer.length} 字节${
          skipped ? `，跳过 ${skipped} 条非弹幕消息的解压` : ''
        }）`
      );
    }

    for (const msg of response.messages) {
      this.messageCount += 1;
      const decoded = protocol.decodeMessage(msg);
      if (!decoded) continue;
      this.lastMessageAt = Date.now();
      if (decoded.type === 'chat') {
        this.chatCount += 1;
        // 进场/点赞/礼物消息在只关心弹幕时可以直接丢弃，减少无谓的对象分配
        this.emit('chat', decoded);
        continue;
      }
      if (this.emitOtherMessages) this.emit('message', decoded);
    }
    return true;
  }

  close() {
    this.closed = true;
    this.emit('status', { state: 'offline', detail: '弹幕轮询已停止' });
  }

  get stats() {
    return {
      rounds: this.rounds,
      messages: this.messageCount,
      chats: this.chatCount,
      lastMessageAt: this.lastMessageAt,
    };
  }
}

module.exports = { DouyinDanmakuClient };
