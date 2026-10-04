'use strict';

const { uid, songFingerprint, shortSource } = (() => {
  const util = require('../lib/util');
  const parser = require('../danmaku/parser');
  return { uid: util.uid, songFingerprint: parser.songFingerprint, shortSource: util.shortSource };
})();

const STATUS = {
  SEARCHING: 'searching',
  QUEUED: 'queued',
  PLAYING: 'playing',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

/**
 * 点歌队列。只负责数据，不负责播放。
 */
class SongQueue {
  constructor(config = {}) {
    this.config = config;
    this.items = [];
    this.history = [];
    /**
     * 【条目被丢弃时的回调】必须设置！
     *
     * 为什么：每人的点歌配额（maxQueuePerUser）是在入队时 +1、
     * 只在"播完/跳过/清空队列"时 -1。
     * 而控制台删条目、队列溢出丢弃这两条路径原来都没有 -1 ——
     * 观众被删 3 次之后就会被永久拒绝（提示"已经排了3首，先听完吧"），
     * 但他其实一首都没在排，必须重启程序才能恢复。
     * 所以这里加一个钩子，让上层能释放配额。
     */
    this.onDrop = null;
  }

  get size() {
    return this.items.length;
  }

  /** 丢弃一个条目（不播了），并通知上层释放配额 */
  _drop(entry, reason) {
    if (!entry) return;
    entry.status = STATUS.SKIPPED;
    if (typeof this.onDrop === 'function') {
      try {
        this.onDrop(entry, reason);
      } catch {
        /* 回调出错不能影响队列操作 */
      }
    }
  }

  setMaxSize(max) {
    // 注意：_trim() 读的是 config.maxQueueSize，所以这里同时改两边，
    // 否则会出现"调了 setMaxSize 但上限没变"的空操作陷阱。
    this.maxSize = Number(max) || 50;
    if (this.config) this.config.maxQueueSize = this.maxSize;
  }

  /** 新点歌：先入队占位，稍后补上搜索结果 */
  createEntry({ song, nickname, userId, message = '', artist = '', title = '', direct = null, idle = false }) {
    const entry = {
      id: uid('song'),
      song,
      fingerprint: songFingerprint(song),
      nickname: nickname || '观众',
      userId: String(userId || nickname || 'unknown'),
      message,
      /**
       * 「歌手 - 歌名」格式的解析结果（解析器给的）。
       * 横线前是歌手、后是歌名 —— 唯一的歌手指定格式。
       * 不是这个格式时两者都是空串，搜索退回纯歌名 + 平台数据。
       */
      artist: artist || '',
      title: title || '',
      /**
       * 【直接指定视频】带 { bvid, page?, cid? } 时不走搜索，直接播这个。
       * 两个用途：观众贴 BV 号；以及空闲垫播（曲目来自合集，本来就带这些信息）。
       */
      direct: direct && direct.bvid ? direct : null,
      /** 是不是空闲垫播塞进来的（有人点歌时优先打断它） */
      idle: Boolean(idle),
      status: STATUS.SEARCHING,
      createdAt: Date.now(),
      startedAt: 0,
      playedMs: 0,
      pick: null,
      alternatives: [],
      failReason: '',
    };
    return entry;
  }

  /** 插到最前面（打断模式用） */
  unshift(entry) {
    this.items.unshift(entry);
    this._trim();
    return entry;
  }

  push(entry) {
    this.items.push(entry);
    this._trim();
    return entry;
  }

  /** 排到正在播放的下一首（VIP/插队用） */
  insertAfterCurrent(entry) {
    this.items.splice(0, 0, entry);
    this._trim();
    return entry;
  }

  _trim() {
    const max = Number(this.maxSize ?? this.config.maxQueueSize ?? 50);
    while (this.items.length > max) {
      const dropped = this.items.pop();
      // 被挤掉的条目也要释放配额，否则观众的点歌额度会被白白吃掉
      this._drop(dropped, 'overflow');
    }
  }

  shift() {
    return this.items.shift() || null;
  }

  remove(id) {
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx < 0) return null;
    const [entry] = this.items.splice(idx, 1);
    // 【必须释放配额】控制台删条目和"播完/跳过"一样，都该把人均额度还回去
    if (entry && entry.status !== STATUS.PLAYING) this._drop(entry, 'removed');
    return entry;
  }

  get(id) {
    return this.items.find((it) => it.id === id) || null;
  }

  findReady() {
    return this.items.find((it) => it.status === STATUS.QUEUED) || null;
  }

  takeReady() {
    const idx = this.items.findIndex((it) => it.status === STATUS.QUEUED);
    if (idx < 0) return null;
    const [entry] = this.items.splice(idx, 1);
    return entry;
  }

  clear() {
    const removed = this.items.slice();
    for (const it of removed) it.status = STATUS.SKIPPED;
    this.items = [];
    return removed;
  }

  /** 已完成/失败的记录（控制台展示用，带条数上限） */
  archive(entry) {
    if (!entry) return;
    this.history.unshift(entry);
    const max = Number(this.config.historySize ?? 50);
    if (this.history.length > max) this.history.length = max;
  }

  toJSON() {
    return {
      items: this.items.map((it) => this.serialize(it)),
      history: this.history.slice(0, 10).map((it) => this.serialize(it)),
      size: this.items.length,
    };
  }

  serialize(entry) {
    if (!entry) return null;
    return {
      id: entry.id,
      song: entry.song,
      nickname: entry.nickname,
      userId: entry.userId,
      status: entry.status,
      createdAt: entry.createdAt,
      startedAt: entry.startedAt,
      failReason: entry.failReason,
      pick: entry.pick
        ? {
            bvid: entry.pick.bvid,
            cid: entry.pick.cid,
            page: entry.pick.page,
            title: entry.pick.title,
            cleanTitle: entry.pick.cleanTitle,
            // 压缩过的来源标签（比如「陈奕迅等人华语金曲合集 · P5」），
            // 给播放页/悬浮层当小字用。原始 title 太长，直接显示会换行。
            source: shortSource(entry.pick.title || entry.pick.cleanTitle, entry.song),
            author: entry.pick.owner || entry.pick.author,
            duration: entry.pick.duration,
            play: entry.pick.play,
            pic: entry.pick.pic,
            score: Math.round(entry.pick.score || 0),
            pageUrl: entry.pick.pageUrl,
            embedUrl: entry.pick.embedUrl,
            mediaUrl: entry.pick.mediaUrl || '',
            reasons: entry.pick.reasons,
          }
        : null,
      alternatives: (entry.alternatives || []).map((a) => ({
        bvid: a.bvid,
        title: a.title,
        author: a.author,
        duration: a.duration,
        play: a.play,
        score: Math.round(a.score || 0),
      })),
    };
  }
}

module.exports = { SongQueue, STATUS };
