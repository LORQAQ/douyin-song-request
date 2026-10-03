'use strict';

const EventEmitter = require('events');
const { SongQueue, STATUS } = require('./queue');
const { parseRequest, splitSongs, parseDirectVideo, RequestFilter } = require('../danmaku/parser');
const { formatDuration, truncate, shortSource } = require('../lib/util');

/**
 * 点歌播放引擎：
 *   弹幕 -> 解析歌名 -> 过滤(去重/冷却) -> B站搜索 -> 入队 -> 播放 -> 播完切下一首
 *
 * 两种模式：
 *   queue     : 排队播放（默认）
 *   interrupt : 新点歌立刻打断正在播放的
 *
 * 事件：
 *   'state'  状态变化（给控制台/播放页广播）
 *   'log'    日志
 *   'toast'  播放页提示条
 *   'chat'   收到的弹幕（控制台展示）
 */
class PlaybackEngine extends EventEmitter {
  constructor({ config, bili, logger, mediaProxy = null, loudness = null }) {
    super();
    this.config = config;
    this.bili = bili;
    this.logger = logger || console;
    this.mediaProxy = mediaProxy;
    this.loudness = loudness;
    this.queue = new SongQueue(config.playback || {});
    this.filter = new RequestFilter(config.filter || {}, logger);
    // 队列里条目被丢弃（控制台删除 / 队列溢出）时，要把该观众的点歌配额还回去，
    // 否则删几次之后他就会被永久拒绝点歌。
    this.queue.onDrop = (entry) => {
      if (entry && entry.userId) this.filter.releaseUser(entry.userId);
    };
    this.current = null;
    this.resolving = false;
    /** 「按曲目时长兜底结束」的定时器句柄（防止页面没上报 ended 导致队列停摆） */
    this._fallbackTimer = null;
    this.stats = {
      chatSeen: 0,
      requests: 0,
      played: 0,
      failed: 0,
      skipped: 0,
      rejected: 0,
      retried: 0,
      recovered: 0,
      startedAt: Date.now(),
    };
    this.recentChats = [];
    /** 暂时没搜到、稍后自动重试的点歌（B站风控时很常见） */
    this.pendingRetries = [];
    this.retryTimer = null;
    /** state 广播节流（弹幕高峰期避免每秒序列化十几次状态） */
    this._stateTimer = null;
    this._broadcastDirty = false;
  }

  updateConfig(config) {
    this.config = config;
    this.queue.config = config.playback || {};
    this.filter.updateConfig(config.filter || {});
  }

  get mode() {
    return this.config.playback.mode || 'queue';
  }

  setMode(mode) {
    if (!['queue', 'interrupt'].includes(mode)) return this.mode;
    this.config.playback.mode = mode;
    this.logger.info(`播放模式切换为：${mode === 'queue' ? '排队播放' : '立即打断'}`);
    this.broadcastState();
    return mode;
  }

  /* ------------------------------ 弹幕入口 ------------------------------ */

  handleChat(message) {
    const content = (message && message.content) || '';
    const nickname = (message && (message.nickname || (message.user && message.user.nickname))) || '观众';
    const userId = String((message && (message.userId || (message.user && message.user.id))) || nickname);
    this.stats.chatSeen += 1;
    // 面板只需要最近几十条，且太长的弹幕截断，避免长文本长期占内存
    const maxChats = Number((this.config.playback || {}).recentChatsSize ?? 30);
    this.recentChats.unshift({
      content: content.length > 200 ? `${content.slice(0, 200)}…` : content,
      nickname,
      at: Date.now(),
    });
    if (this.recentChats.length > maxChats) this.recentChats.length = maxChats;
    this.emit('chat', { content, nickname, userId, at: Date.now() });
    if (!content) return;

    const parsed = parseRequest(content, this.config.trigger || {});
    if (!parsed || !parsed.ok) return;
    const songs = splitSongs(parsed.song);
    if (!songs.length) return;
    for (const song of songs) this.requestSong({ song, nickname, userId, message: content });
  }

  /** 点歌主流程（也供控制台手动调用） */
  async requestSong({ song, nickname = '观众', userId = 'manual', message = '', force = false }) {
    const clean = String(song || '').trim();
    if (!clean) return { ok: false, reason: 'empty' };

    if (!force) {
      const check = this.filter.check({ userId, nickname, song: clean });
      if (!check.ok) {
        this.stats.rejected += 1;
        this.logger.debug(`忽略点歌「${clean}」(${nickname})：${check.reason}`);
        this.emit('toast', { kind: 'reject', text: check.message, nickname, song: clean });
        this.broadcastState();
        return { ok: false, reason: check.reason, message: check.message };
      }
    }

    const entry = this.queue.createEntry({ song: clean, nickname, userId, message });
    this.stats.requests += 1;

    const isInterrupt = this.mode === 'interrupt';
    if (isInterrupt) this.queue.unshift(entry);
    else this.queue.push(entry);

    this.logger.info(`🎵 ${nickname} 点歌：${clean}${isInterrupt ? '（打断模式）' : ''}`);
    this.emit('log', { level: 'info', text: `${nickname} 点歌 ${clean}` });
    this.broadcastState();

    // 搜索（异步补全，不阻塞其它点歌）
    this.resolveEntry(entry).catch((err) => {
      this.logger.error(`解析点歌失败「${clean}」：`, err.message);
    });

    if (isInterrupt && this.current && this.current.status === STATUS.PLAYING) {
      this.logger.info('打断模式：切到新点歌');
      this.skip('新点歌打断');
    } else if (!this.current) {
      this.playNext();
    }

    return { ok: true, entry, mode: this.mode };
  }

  async resolveEntry(entry) {
    try {
      // 已经带着匹配结果（比如撤销上一步复用）就不用再搜一次
      if (entry.pick && entry.status !== STATUS.SEARCHING) {
        return entry;
      }
      // 观众直接发了B站链接 / BV 号：不做搜索，直接用那个视频。
      // 这是唯一能保证「放的确实是想要的那个视频」的方式。
      const direct = parseDirectVideo(entry.song);
      let result;
      if (direct) {
        try {
          const pick = await this.bili.pickByVideo(direct);
          this.logger.info(`🔗 直接用观众指定的视频：${truncate(pick.title, 40)}`);
          result = { ok: true, pick, alternatives: [] };
        } catch (err) {
          result = { ok: false, reason: `指定的视频取不到：${err.message}` };
        }
      } else {
        result = await this.bili.pickForSong(entry.song);
      }
      if (!result.ok) {
        entry.status = STATUS.FAILED;
        entry.failReason = result.reason || '搜索无结果';
        this.stats.failed += 1;
        // 风控/超时这类临时问题，安排一次后台自动重试，不用观众再点一遍
        const transient = /风控|超时|网络|频繁|412|code=-799/i.test(entry.failReason);
        const scheduled = transient && this.scheduleRetry(entry);
        this.logger.warn(
          `没找到「${entry.song}」的合适视频：${entry.failReason}${scheduled ? '（已安排 45 秒后自动重试）' : ''}`
        );
        this.emit('toast', {
          kind: 'fail',
          text: scheduled ? `《${entry.song}》暂时没搜到，稍后自动重试` : `没找到《${entry.song}》合适的版本`,
          nickname: entry.nickname,
        });
        this.queue.archive(entry);
        this.queue.remove(entry.id);
        this.broadcastState();
        this._maybePlay();
        return null;
      }
      entry.pick = result.pick;
      entry.alternatives = result.alternatives || [];
      entry.status = STATUS.QUEUED;
      if (this.mediaProxy) entry.pick.mediaUrl = `/media/${entry.id}`;
      this.filter.commit({ userId: entry.userId, song: entry.song, fingerprint: entry.fingerprint });
      this.logger.info(
        `   ↳ 匹配到：${truncate(entry.pick.title, 46)} | ${entry.pick.owner || '未知UP'} | ${formatDuration(
          entry.pick.duration
        )} | 播放${entry.pick.play} | 得分${Math.round(entry.pick.score)}`
      );
      this.broadcastState();
      this._maybePlay();
      return entry;
    } catch (err) {
      entry.status = STATUS.FAILED;
      entry.failReason = err.message;
      this.stats.failed += 1;
      this.logger.error(`搜索「${entry.song}」出错：`, err.message);
      this.queue.remove(entry.id);
      this.queue.archive(entry);
      this.broadcastState();
      this._maybePlay();
      return null;
    }
  }

  /* ------------------------------ 播放控制 ------------------------------ */

  /**
   * 把搜索失败的点歌放进重试队列（B站 412 风控、网络抖动时很有用）。
   * 最多重试 2 次，每次间隔 45 秒。
   */
  scheduleRetry(entry) {
    const maxRetries = Number((this.config.bilibili || {}).retryTimes ?? 2);
    const item = this.pendingRetries.find((it) => it.entry.song === entry.song);
    if (item) return true;
    if (this.pendingRetries.length >= 5) return false;
    const attempt = (entry.retryAttempt || 0) + 1;
    if (attempt > maxRetries) return false;
    entry.retryAttempt = attempt;
    this.pendingRetries.push({ entry, at: Date.now() + 45000, attempt });
    this._armRetryTimer();
    return true;
  }

  _armRetryTimer() {
    if (this.retryTimer || !this.pendingRetries.length) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this._runRetries().catch((err) => this.logger.debug(`重试任务出错：${err.message}`));
    }, 15000);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  /** 手动立刻重试（控制台按钮） */
  async retryNow() {
    if (!this.pendingRetries.length) return { ok: false, reason: 'nothing-to-retry' };
    const due = this.pendingRetries.slice();
    this.pendingRetries = [];
    for (const item of due) item.at = Date.now();
    this.logger.info(`手动触发重试：${due.length} 首`);
    // 直接处理，不等定时器
    await this._runRetries(due).catch((err) => this.logger.warn(`重试失败：${err.message}`));
    return { ok: true, count: due.length };
  }

  async _runRetries(explicitList = null) {
    const now = Date.now();
    let due;
    if (explicitList) {
      due = explicitList;
    } else {
      due = this.pendingRetries.filter((it) => it.at <= now);
      this.pendingRetries = this.pendingRetries.filter((it) => it.at > now);
    }
    for (const item of due) {
      const { entry } = item;
      this.stats.retried += 1;
      this.logger.info(`自动重试点歌「${entry.song}」（第 ${item.attempt} 次）`);
      const retryEntry = this.queue.createEntry({
        song: entry.song,
        nickname: entry.nickname,
        userId: entry.userId,
        message: entry.message,
      });
      retryEntry.retryAttempt = item.attempt;
      this.queue.push(retryEntry);
      this.broadcastState();
      // 串行处理，避免同一时间打太多请求又触发风控
      // eslint-disable-next-line no-await-in-loop
      const resolved = await this.resolveEntry(retryEntry);
      if (resolved) this.stats.recovered += 1;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1500));
    }
    this._armRetryTimer();
  }

  _maybePlay() {
    if (this.current) return;
    const ready = this.queue.findReady();
    if (!ready) return;
    this.logger.debug(`_maybePlay: 取「${ready.song}」开始播放（队列 ${this.queue.items.length} 首）`);
    this.playNext();
  }

  /** 取下一首可播放的，交给播放页 */
  async playNext() {
    if (this.current) return this.current;
    if (this.resolving) return null;
    this.resolving = true;
    try {
      const entry = this.queue.takeReady();
      // 跳过还在搜索中的占位：先播已经就绪的
      while (!entry && this.queue.items.some((it) => it.status === STATUS.SEARCHING)) {
        if (this.queue.items.length === 0) break;
        // 没有就绪项但有搜索中的，等它搜完（resolveEntry 会再调 _maybePlay）
        return null;
      }
      if (!entry) return null;

      entry.status = STATUS.PLAYING;
      entry.startedAt = Date.now();
      this.current = entry;

      // 提前解析音频直链（失败就回退内嵌播放器）
      //
      // 【竞态修复】buildPlayPayload 里会做直链解析 + ffmpeg 响度测量，
      // 实测最长可能等 30 秒。这段窗口里如果主播点了「跳过」（或打断模式来了新歌），
      // finishCurrent 会把 this.current 清空、本条目归档成 skipped，
      // 但 await 一返回原来的代码照样 emit('play') ——
      // 结果页面开始播一首已经被丢弃的歌，而 this.current 是 null，
      // 播完后 onEnded 第一行就直接 return，队列彻底停摆，只能手点跳过。
      // 所以 await 之后必须重新确认"这一首还在播"。
      const payload = await this.buildPlayPayload(entry);
      if (this.current !== entry || entry.status !== STATUS.PLAYING) {
        this.logger.debug(`「${entry.song}」在准备播放期间已被跳过，丢弃这次播放`);
        return null;
      }

      this.logger.info(`▶ 正在播放：${entry.pick.cleanTitle || entry.pick.title}（${entry.nickname} 点）`);
      this.emit('play', payload);
      this.emit('toast', {
        kind: 'play',
        text: `正在播放《${entry.pick.cleanTitle || entry.song}》`,
        sub: `${entry.nickname} 点的`,
        nickname: entry.nickname,
      });
      this.broadcastStateNow();
      // 【兜底计时器】内嵌(embed)模式下 <audio> 没有 src，永远不触发 ended，
      // 页面看门狗也因为 mode!=='direct' 直接 return —— 那首歌播完队列就永久卡死。
      // 所以这里按曲目时长安排一个兜底结束（收到真正的 ended 会把它清掉）。
      this._armDurationFallback(entry, payload);
      return entry;
    } finally {
      this.resolving = false;
    }
  }

  /**
   * 按曲目时长安排「兜底结束」定时器。
   *
   * 用途：防止播放页因为任何原因没有上报 ended（内嵌模式、浏览器卡死、
   * 页面被系统挂起…）导致队列永久停摆。
   * 正常情况下 ended 会先到，定时器会被清掉，没有任何副作用。
   */
  _armDurationFallback(entry, payload) {
    this._clearDurationFallback();
    const dur = Number(payload && payload.duration) || 0;
    if (!dur || dur < 5) return; // 时长不可信就不兜底
    // 多给 8 秒余量：避免比真实播放提前触发（网络缓冲、seek 等）
    const ms = (dur + 8) * 1000;
    this._fallbackTimer = setTimeout(() => {
      this._fallbackTimer = null;
      if (this.current !== entry) return;
      this.logger.warn(`「${entry.song}」超过时长 ${dur}s 仍未收到播放结束通知，按已结束处理（兜底）`);
      this.finishCurrent('timeout-fallback');
    }, ms);
    if (this._fallbackTimer.unref) this._fallbackTimer.unref();
  }

  _clearDurationFallback() {
    if (this._fallbackTimer) {
      clearTimeout(this._fallbackTimer);
      this._fallbackTimer = null;
    }
  }

  /** 组装播放页需要的 payload：优先纯音频直链，失败回退内嵌播放器 */
  async buildPlayPayload(entry) {
    const pick = entry.pick;
    const playback = this.config.playback || {};
    const payload = {
      id: entry.id,
      song: entry.song,
      nickname: entry.nickname,
      bvid: pick.bvid,
      // title = 大字显示的歌名（要短、要干净）
      // source = 小字显示的来源（压缩过的合集名 + 分P号，比如「陈奕迅等人华语金曲合集 · P5」）
      title: pick.cleanTitle || pick.song || pick.title,
      source: shortSource(pick.title || pick.cleanTitle, entry.song),
      fullTitle: pick.title,
      author: pick.owner || pick.author,
      duration: pick.duration,
      durationText: formatDuration(pick.duration),
      pic: pick.pic,
      pageUrl: pick.pageUrl,
      embedUrl: pick.embedUrl,
      mode: 'embed',
      volume: Number(playback.volume ?? 0.8),
      startedAt: Date.now(),
    };

    const wantDirect = playback.useDirectStream !== false && playback.audioMode !== false;
    if (wantDirect) {
      try {
        if (!pick.cid) {
          const info = await this.bili.getVideoInfo(pick.bvid);
          pick.cid = info.cid;
          if (info.duration) pick.duration = info.duration;
          payload.duration = pick.duration;
          payload.durationText = formatDuration(pick.duration);
        }
        const stream = await this.bili.resolveAudioStream(pick.bvid, pick.cid);
        payload.mode = 'direct';
        payload.cid = pick.cid;
        // 注意：B站 CDN 校验 Referer，浏览器直接播会 403，
        // 所以这里给的是本机代理地址，由服务端带上正确请求头去取流。
        if (this.mediaProxy) {
          payload.audioUrl = this.mediaProxy.register({
            id: entry.id,
            bvid: pick.bvid,
            cid: pick.cid,
            title: payload.title,
            upstreams: [stream.url, ...(stream.backups || [])],
            expireAt: stream.expireAt,
            // 【直链自动刷新】B站直链约 2 小时过期，过期后播放页会直接放不了。
            // 把「重新解析」的能力交给代理，它取流失败时会自己调这个回调，
            // 主播不用手动跳过（实测这是「刚才能放、过一会放不了」的根因）。
            refresh: async () => {
              // 强制绕过缓存重新解析
              this.bili.streamCache.delete(`${pick.bvid}:${pick.cid}`);
              const fresh = await this.bili.resolveAudioStream(pick.bvid, pick.cid);
              payload.audioUrl = `/media/${encodeURIComponent(entry.id)}`;
              return fresh;
            },
          });
          payload.audioBackups = [];
          payload.proxied = true;
        } else {
          payload.audioUrl = stream.url;
          payload.audioBackups = stream.backups || [];
        }
        payload.expireAt = stream.expireAt;
        payload.codec = stream.codec;
        this.logger.debug(`音频直链解析成功（${payload.codec || 'unknown'}，带宽${stream.bandwidth || 0}）`);

        // 音量自动校准：不同投稿音量差异能有 10dB，统一到目标响度
        if (this.loudness && this.loudness.enabled && playback.normalizeVolume !== false) {
          try {
            const measured = await this.loudness.measure(pick.bvid, stream.url);
            if (measured.adjusted) {
              payload.gainDb = measured.gainDb;
              payload.lufs = measured.lufs;
              // 在主播设定的音量基础上乘上修正倍率，并做上下限保护
              const gain = 10 ** (measured.gainDb / 20);
              payload.volume = Math.max(0, Math.min(1, payload.volume * gain));
            }
          } catch (err) {
            this.logger.debug(`音量校准跳过：${err.message}`);
          }
        }
      } catch (err) {
        this.logger.warn(`音频直链解析失败，回退官方内嵌播放器：${err.message}`);
        payload.mode = playback.fallbackToEmbed === false ? 'direct' : 'embed';
        payload.directError = err.message;
      }
    }
    return payload;
  }

  /** 播放页上报播放结束 */
  onEnded(id) {
    if (!this.current || (id && this.current.id !== id)) return;
    return this.finishCurrent('ended');
  }

  finishCurrent(reason = 'ended') {
    const entry = this.current;
    if (!entry) return null;
    // 无论是正常播完还是跳过，都要把「兜底结束」定时器清掉，不然它会晚点再触发一次
    this._clearDurationFallback();
    entry.status = reason === 'ended' ? STATUS.DONE : STATUS.SKIPPED;
    entry.playedMs = Date.now() - entry.startedAt;
    this.filter.releaseUser(entry.userId);
    this.queue.archive(entry);
    this.current = null;
    if (reason === 'ended') this.stats.played += 1;
    else this.stats.skipped += 1;
    this.logger.info(`⏹ ${reason === 'ended' ? '播放结束' : '已跳过'}：${entry.pick.cleanTitle || entry.song}`);
    this.broadcastStateNow();
    const gap = Number((this.config.playback || {}).songGapMs ?? 1000);
    setTimeout(() => {
      this._maybePlay();
      this.broadcastStateNow();
    }, gap);
    return entry;
  }

  skip(reason = 'manual') {
    if (!this.current) return null;
    this.emit('command', { cmd: 'stop', reason });
    return this.finishCurrent('skip');
  }

  /**
   * 撤销上一步：误点跳过、或者刚播完就想再听一遍时用。
   * 把最近一条历史记录重新放回队首，空闲时立刻播放。
   */
  async undoLast() {
    const last = this.queue.history[0];
    if (!last) return { ok: false, reason: 'empty-history' };
    if (this.current && this.current.song === last.song) return { ok: false, reason: 'already-playing' };

    this.queue.history.shift();
    const entry = this.queue.createEntry({
      song: last.song,
      nickname: last.nickname,
      userId: last.userId,
      message: last.message || last.song,
    });
    // 已经有匹配结果就直接复用，省一次搜索
    if (last.pick) {
      entry.pick = last.pick;
      entry.alternatives = last.alternatives || [];
      entry.status = STATUS.QUEUED;
    }
    this.queue.items.unshift(entry);
    this.logger.info(`↩ 撤销上一步：把《${last.song}》重新放回队列`);
    this.broadcastState();
    if (entry.pick) this.filter.commit({ userId: entry.userId, song: entry.song, fingerprint: entry.fingerprint });
    else this.resolveEntry(entry).catch((err) => this.logger.debug(`撤销后解析失败：${err.message}`));
    this._maybePlay();
    return { ok: true, entry };
  }

  /** 播放页报错（如直链 403 或视频简介不存在），按配置跳下一首 */
  onError(id, message = '') {
    if (!this.current || (id && this.current.id !== id)) return null;
    this.logger.warn(`播放出错：${message}`);
    return this.finishCurrent('error');
  }

  /** 切到备选版本：同一首歌换一个视频 */
  async switchCandidate(entryId, bvid) {
    const entry = this.queue.get(entryId) || (this.current && this.current.id === entryId ? this.current : null);
    if (!entry) return { ok: false, reason: 'not-found' };
    const candidate = (entry.alternatives || []).find((a) => a.bvid === bvid);
    if (!candidate) return { ok: false, reason: 'candidate-not-found' };
    const info = await this.bili.getVideoInfo(bvid).catch(() => null);
    entry.pick = {
      ...candidate,
      cleanTitle: candidate.cleanTitle || candidate.title,
      owner: (info && info.owner) || candidate.author,
      cid: info && info.cid,
      pageUrl: this.bili.getPageUrl(bvid),
      embedUrl: this.bili.getEmbedUrl(bvid, { autoplay: 1, danmaku: 0 }),
    };
    this.broadcastState();
    if (this.current && this.current.id === entryId) {
      const payload = await this.buildPlayPayload(entry);
      this.emit('play', payload);
    }
    return { ok: true, entry };
  }

  /** 播完当前后暂停（清空队列） */
  clearQueue() {
    const removed = this.queue.clear();
    for (const it of removed) this.filter.releaseUser(it.userId);
    this.logger.info(`清空队列（${removed.length} 首）`);
    this.broadcastState();
    return removed.length;
  }

  /** 让某首提前播放 */
  promote(id) {
    const idx = this.queue.items.findIndex((it) => it.id === id);
    if (idx <= 0) return false;
    const [entry] = this.queue.items.splice(idx, 1);
    if (entry.status === STATUS.SEARCHING) {
      this.queue.items.unshift(entry);
    } else {
      this.queue.items.unshift(entry);
    }
    this.broadcastState();
    return true;
  }

  broadcastState() {
    this._broadcastDirty = true;
    if (this._stateTimer) return;
    const delay = Number((this.config.playback || {}).stateBroadcastMs ?? 250);
    if (delay <= 0) {
      this._flushState();
      return;
    }
    // 弹幕高峰期每条弹幕都广播一次 9KB 的 state 是纯浪费（面板每秒刷 10 次没人看得出），
    // 这里做节流：250ms 内的多次变更合并成一次推送。
    this._stateTimer = setTimeout(() => this._flushState(), delay);
    if (this._stateTimer.unref) this._stateTimer.unref();
  }

  _flushState() {
    if (this._stateTimer) {
      clearTimeout(this._stateTimer);
      this._stateTimer = null;
    }
    if (!this._broadcastDirty) return;
    this._broadcastDirty = false;
    this.emit('state', this.getState());
  }

  /** 立即广播（播放切换这类关键节点用，不让面板等） */
  broadcastStateNow() {
    this._broadcastDirty = true;
    this._flushState();
  }

  getState() {
    const playback = this.config.playback || {};
    return {
      mode: this.mode,
      current: this.current ? this.queue.serialize(this.current) : null,
      playing: Boolean(this.current),
      queue: this.queue.items.map((it) => this.queue.serialize(it)),
      history: this.queue.history.slice(0, 20).map((it) => this.queue.serialize(it)),
      pendingRetries: this.pendingRetries.map((it) => ({
        song: it.entry.song,
        nickname: it.entry.nickname,
        attempt: it.attempt,
        inMs: Math.max(0, it.at - Date.now()),
      })),
      recentChats: this.recentChats.slice(0, 20),
      stats: { ...this.stats, uptimeMs: Date.now() - this.stats.startedAt },
      config: {
        audioMode: playback.audioMode !== false,
        useDirectStream: playback.useDirectStream !== false,
        normalizeVolume: playback.normalizeVolume !== false,
        loudnessAvailable: Boolean(this.loudness && this.loudness.enabled),
        volume: Number(playback.volume ?? 0.8),
        showToast: Boolean((this.config.audioPage || {}).showToast),
      },
      loudness: this.loudness ? { ...this.loudness.stats, enabled: this.loudness.enabled } : null,
    };
  }
}

module.exports = { PlaybackEngine, STATUS };
