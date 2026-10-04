'use strict';

const { EventEmitter } = require('events');

/**
 * 【空闲垫播】
 *
 * 需求（主播原话）：
 *   「直播间没人点歌的时候给我播放周杰伦合集，有人点歌就打断」
 *
 * 也就是直播时不能有静音的空档 —— 没人点歌就自动放一位歌手的合集当背景，
 * 一有人点歌就立刻打断、切到观众点的那首。
 *
 * 设计：
 *   · 主流程**复用它已有的队列**，不另起一套播放通道。
 *     垫播就是往队列里塞一条带 `idle: true` 标记的点歌，
 *     所以「排队 / 打断 / 音量校准 / 直链刷新」这些机制全都自动生效，
 *     不会出现两套播放逻辑互相打架。
 *   · 只在**真的空闲**时才垫：没有正在播的、队列里也没人点的、
 *     并且安静了 idleDelayMs 毫秒（默认 8 秒，避免点歌间隙疯狂插歌）。
 *   · 垫播的歌来自「歌手合集」（`_popularCollectionVideos`），
 *     排队播放、不重复；一轮放完再从头轮。
 *   · 有人点歌时 `interruptForRealSong()` 会把正在播的垫播曲目跳过。
 *
 * 配置（config.json）：
 *   "idlePlay": {
 *     "enabled": true,
 *     "singers": ["周杰伦"],       // 垫播歌手（按顺序轮着用）
 *     "delayMs": 8000,             // 空闲多久才开始垫
 *     "maxPerRound": 0             // 0 = 一轮放完整个合集
 *   }
 */
class IdlePlayer extends EventEmitter {
  /**
   * @param {object} config  整份配置（读 config.idlePlay）
   * @param {object} deps
   * @param {import('../bilibili/bili-api').BilibiliClient} deps.bili
   * @param {object} deps.logger
   * @param {object} deps.engine  播放引擎（用来判断空闲、塞歌曲）
   */
  constructor(config = {}, { bili, logger, engine } = {}) {
    super();
    this.bili = bili;
    this.logger = logger || console;
    this.engine = engine;
    this.applyConfig(config);

    /** 待播列表（来自各歌手合集，混合后打乱过一次） */
    this.playlist = [];
    /** 已经放到哪了 */
    this.cursor = 0;
    /** 正在加载列表？防并发重复拉 */
    this.loading = false;
    /** 定时器 */
    this.timer = null;
    /** 当前正在播的是不是垫播 */
    this.playingIdle = false;
    /** 上一次"有动静"的时间（有人点歌 / 有歌在播 / 刚垫过） */
    this.lastActivityAt = Date.now();
    /** 统计 */
    this.stats = { filled: 0, skippedForRealSong: 0, loadFailed: 0 };
  }

  applyConfig(config = {}) {
    const c = config.idlePlay || {};
    this.enabled = c.enabled === true;
    this.singers = (Array.isArray(c.singers) ? c.singers : [])
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    // 空闲多久才开始垫。太短会在点歌间隙乱插歌，太长直播间会有明显静音
    this.delayMs = Math.max(0, Number(c.delayMs ?? 8000));
    this.maxPerRound = Math.max(0, Number(c.maxPerRound ?? 0));
    this.checkEveryMs = Math.max(2000, Number(c.checkEveryMs ?? 5000));
    if (this.enabled && !this.singers.length) {
      this.logger.warn?.('空闲垫播已开启，但 idlePlay.singers 是空的 —— 不会播任何东西');
    }
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.logger.info(
      `🎵 空闲垫播已启动：没人点歌超过 ${Math.round(this.delayMs / 1000)} 秒就播 ` +
        `「${this.singers.join('、')}」的合集`
    );

    /**
     * 【playingIdle 必须跟着引擎实际状态走】
     *
     * 原来只在 _fillOnce 里置 true、在 interruptForRealSong 里置 false。
     * 于是垫播那首**自然播完**（或被主播手动跳过）时，标记一直是 true ——
     * 之后 interruptForRealSong 一看 playingIdle 就直接 return，
     * 下次有人点歌就"打不断"了。
     *
     * 这里订阅引擎的 state 事件，以 `current.idle` 为唯一事实来源。
     */
    if (this.engine && typeof this.engine.on === 'function') {
      this._onState = () => {
        const cur = this.engine.current;
        this.playingIdle = Boolean(cur && cur.idle);
      };
      this.engine.on('state', this._onState);
    }

    // 后台先把合集拉好，避免第一次真的要垫的时候干等十几秒
    this._loadPlaylist().catch(() => {});
    this.timer = setInterval(() => {
      this._tick().catch((err) => this.logger.debug?.(`空闲垫播检查出错：${err.message}`));
    }, this.checkEveryMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this._onState && this.engine && typeof this.engine.off === 'function') {
      this.engine.off('state', this._onState);
      this._onState = null;
    }
    this.playingIdle = false;
  }

  /** 有人点歌了 —— 记一下时间，并打断正在播的垫播 */
  noteRealSong() {
    this.lastActivityAt = Date.now();
    this.interruptForRealSong();
  }

  /**
   * 有人点歌时打断垫播。
   *
   * 只对**垫播**生效：观众自己点的歌不会被别人打断
   * （那是 interrupt 模式该管的事，不归这里）。
   *
   * 注意判断条件是 `engine.current.idle`，不是自己缓存的 playingIdle ——
   * 状态可能因为自然播完/手动跳过而与缓存不一致（这个坑踩过）。
   */
  interruptForRealSong() {
    const cur = this.engine && this.engine.current;
    const isIdleNow = Boolean(cur && cur.idle);
    // 用引擎的实际状态纠正缓存
    this.playingIdle = isIdleNow;
    if (!isIdleNow) return false;

    this.playingIdle = false;
    this.stats.skippedForRealSong += 1;
    this.logger.info('⏭ 有人点歌，打断垫播');
    try {
      this.engine.skip('idle-interrupt');
    } catch (err) {
      this.logger.debug?.(`打断垫播失败：${err.message}`);
    }
    return true;
  }

  /** 定时检查：现在是不是该垫播了 */
  async _tick() {
    if (!this.enabled || !this.engine) return;
    // 正在垫播 → 什么都不做（等它播完自然会再进来）
    if (this.playingIdle) return;
    // 有正在播的歌 → 不插手
    if (this.engine.current) return;
    // 队列里还有人点的歌（含正在搜索的） → 不插手
    const items = (this.engine.queue && this.engine.queue.items) || [];
    if (items.length) {
      this.lastActivityAt = Date.now();
      return;
    }
    // 还没安静够久
    if (Date.now() - this.lastActivityAt < this.delayMs) return;

    await this._fillOnce();
  }

  /** 垫一首 */
  async _fillOnce() {
    const track = await this._nextTrack();
    if (!track) return;

    this.playingIdle = true;
    this.lastActivityAt = Date.now();
    this.stats.filled += 1;

    const song = track.part || track.collectionTitle || '空闲垫播';
    this.logger.info(`🎵 空闲垫播：${song}${track.collectionTitle ? '（' + track.collectionTitle.slice(0, 18) + '）' : ''}`);

    /**
     * 【必须直接指定视频】不能走「按歌名搜索」那条路 ——
     * 那会引入"同名不同歌"的风险，而且多花 2~4 秒。
     * 合集条目已经有 bvid + page + cid，直接用最准最快。
     */
    const engine = this.engine;
    const created = await engine
      .requestSong({
        song,
        nickname: '空闲垫播',
        userId: 'idle-player',
        message: song,
        force: true,
        direct: { bvid: track.bvid, page: track.page, cid: track.cid },
        idle: true,
      })
      .catch((err) => {
        this.logger.debug?.(`垫播入队失败：${err.message}`);
        return null;
      });

    if (!created || created.ok === false) {
      this.playingIdle = false;
      this.logger.debug?.(`垫播没入队成功：${(created && created.reason) || '未知原因'}`);
    }
  }

  /** 取下一条待垫的曲目（按顺序轮，播完一轮重新开始） */
  async _nextTrack() {
    if (!this.playlist.length) await this._loadPlaylist();
    if (!this.playlist.length) return null;
    if (this.cursor >= this.playlist.length) {
      // 一轮放完 → 从头再来（直播间会一直有声音）
      this.cursor = 0;
      this.logger.debug?.('空闲垫播：一轮放完，从头再来');
    }
    const track = this.playlist[this.cursor];
    this.cursor += 1;
    return track || null;
  }

  /** 拉取所有垫播歌手的合集曲目 */
  async _loadPlaylist() {
    if (this.loading || !this.bili || !this.singers.length) return;
    this.loading = true;
    try {
      const all = [];
      for (const artist of this.singers) {
        try {
          const r = await this.bili._popularCollectionVideos(artist);
          const list = (r && r.list) || [];
          if (!list.length) {
            this.logger.debug?.(`空闲垫播：「${artist}」没找到可用合集`);
            continue;
          }
          for (const v of list) {
            if (!v || !v.bvid) continue;
            all.push({ ...v, idleSinger: artist });
          }
          this.logger.info(`空闲垫播：「${artist}」合集准备好 ${list.length} 首`);
        } catch (err) {
          this.stats.loadFailed += 1;
          this.logger.debug?.(`空闲垫播：拉「${artist}」合集失败：${err.message}`);
        }
      }
      if (this.maxPerRound > 0) all.length = Math.min(all.length, this.maxPerRound);
      this.playlist = all;
      this.cursor = 0;
    } finally {
      this.loading = false;
    }
  }

  /** 控制台展示用 */
  getState() {
    return {
      enabled: this.enabled,
      singers: this.singers,
      delayMs: this.delayMs,
      ready: this.playlist.length,
      cursor: this.cursor,
      playingIdle: this.playingIdle,
      stats: { ...this.stats },
    };
  }
}

module.exports = { IdlePlayer };
