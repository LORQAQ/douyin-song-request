'use strict';

/**
 * 音乐平台「原唱」查询。
 *
 * ## 为什么需要
 *
 * B站上搜「告白气球」，出来的可能是「周二珂翻唱版」而不是周杰伦原唱。
 * 光靠标题文本规则判断不出「谁是原唱」——必须去音乐平台查。
 *
 * ## 为什么选酷狗（实测选型，不是拍脑袋）
 *
 * | 接口 | 平均耗时 | 15 首命中率 | 备注 |
 * | --- | --- | --- | --- |
 * | **酷狗 songsearch v2** | **119ms** | **15/15** | 零签名，带 IsOriginal 原唱标记 |
 * | 咪咕 CMS | 177ms | 11/15 | 零签名，漠河舞厅查不到 |
 * | iTunes (country=hk) | 216~400ms | 15/15 | 有 429 限流，返回繁体 |
 * | MusicBrainz | 924ms | 排序不可靠 | 官方限速 1req/s，遇 503 |
 * | 网易云 | 263ms | **0/4** | 周杰伦版权下架，全是翻唱 |
 * | QQ音乐 | — | 不可用 | 接口返回 500 或空数组 |
 *
 * 关键：酷狗有 `IsOriginal` 字段（1=原唱，0=非原唱），
 * 4 首测试歌的原唱全部排第 0 位且 IsOriginal=1。
 *
 * ## 两个必须处理的坑（都踩过）
 *
 * 1. **空/乱码查询不返回空数组**，而是返回不相关的热门歌
 *    （`q=""` → 虞兮叹）。所以**必须做歌名归一化比对**，否则垃圾输入
 *    会被当成有效结果，反而把 B站候选带偏。
 * 2. **返回的歌手名可能是繁体**（周杰倫），而用户输入和 B站标题是简体。
 *    必须做简繁归一后再比对。
 *
 * ## 设计原则
 *
 * 查询**绝不能阻塞点歌主流程**。查不到就静默返回 null，
 * 调用方回退到纯 B站打分。所以这里有超时 + 缓存 + 失败静默。
 */

const { LruCache } = require('./util');
const { toSimplified, normalizeForCompare } = require('../bilibili/bili-api');

const KG_SEARCH_URL = 'https://songsearch.kugou.com/song_search_v2';
const KG_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://www.kugou.com/',
  Accept: 'application/json, text/plain, */*',
};

/** 歌名归一化：繁简 + 去标点/空白 + 小写。用于「这条结果到底是不是这首歌」的校验 */
function normTitle(text) {
  return normalizeForCompare(toSimplified(String(text || '')));
}

/**
 * 从「歌名」里剥掉点歌时可能带的噪声，得到干净的查询词。
 * 例如「周杰伦的晴天」「晴天 副歌」→「晴天」
 */
function cleanQueryForLookup(title) {
  let s = String(title || '').trim();
  // 去掉括号备注：「晴天（live）」→「晴天」
  s = s.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, ' ').trim();
  // 去掉常见后缀词
  s = s.replace(/(完整版|原唱|官方版|高清|无损|纯享|MV|mv|现场版|副歌|片段)\s*$/g, '').trim();
  return s || String(title || '').trim();
}

class MusicMeta {
  /**
   * @param {object} config   bilibili 配置段（复用缓存配置）
   * @param {object} logger
   */
  constructor(config = {}, logger = null) {
    this.config = config;
    this.logger = logger;
    // 原唱信息几乎不变，缓存 24 小时；弹幕高频重复点歌时收益极大
    this.cache = new LruCache(Number(config.musicCacheSize ?? 300));
  }

  /**
   * 查一首歌的原唱信息。
   *
   * @param {string} title 歌名（可以带噪声，会先清洗）
   * @returns {Promise<null|{artist, album, durationSec, year, isOriginal, searchText}>}
   *          查不到返回 null，**不抛异常**（点歌流程不能因为查原唱失败而中断）
   */
  async lookupOriginal(title) {
    if (this.config.lookupOriginal === false) return null;
    const query = cleanQueryForLookup(title);
    if (!query || query.length < 2) return null;

    const key = normTitle(query);
    const cached = this.cache.get(key);
    if (cached) return cached.value;

    // 先查磁盘缓存：酷狗会**间歇性限流**（实测同一批请求里有的成功有的失败），
    // 而原唱信息几乎不变，所以查到一次就存下来，之后不再依赖网络。
    const fromDisk = this._readDisk(key);
    if (fromDisk) {
      this.cache.set(key, { value: fromDisk });
      return fromDisk;
    }

    // 【in-flight 去重（防缓存击穿）】
    // 缓存只在查询**完成后**才写入，所以同一首歌被 N 个人同时点、
    // 或者自动重试和人工点歌撞在一起时，会并发发起 N×2 次酷狗请求。
    // 酷狗本身就有间歇限流（上面的注释也写了），并发只会把限流概率放大。
    // 这里让同一首歌的并发查询共用同一个 promise。
    if (!this.inflight) this.inflight = new Map();
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const task = (async () => {
      const timeoutMs = Number(this.config.musicLookupTimeoutMs ?? 4000);
      let result = null;
      // 重试 2 次：酷狗限流是间歇的，隔一下再试往往就通
      for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
        try {
          result = await this._searchKugou(query, timeoutMs);
        } catch (err) {
          if (this.logger) this.logger.debug(`查原唱失败（第${attempt + 1}次）「${query}」：${err.message}`);
        }
        if (!result && attempt === 0) await new Promise((r) => setTimeout(r, 400));
      }

      // 查不到也缓存一会儿，避免同一首冷门歌反复打接口
      this.cache.set(key, { value: result });
      if (result) this._writeDisk(key, result);
      return result;
    })();

    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 磁盘缓存：把查到的原唱信息持久化（酷狗限流时也能用） */
  _readDisk(key) {
    try {
      const fs = require('fs');
      const p = this._diskFile();
      if (!fs.existsSync(p)) return null;
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const hit = raw[key];
      // 30 天过期
      if (hit && Date.now() - hit.at < 30 * 86400000) return hit.value;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 写磁盘缓存。
   *
   * 【必须用「临时文件 + rename」】原来是 readFileSync → 改 → writeFileSync 的
   * 非原子读改写：多个查询同时完成时互相覆盖（后写的赢，前面的条目白白丢掉），
   * 而且如果进程正好被杀在 writeFileSync 中间，会留下半个 JSON ——
   * 之后 _readDisk 的 catch 会静默返回 null，整个磁盘缓存就此失效且没有任何提示。
   * rename 在同一分区上是原子操作，不会再出现半个文件。
   */
  _writeDisk(key, value) {
    try {
      const fs = require('fs');
      const p = this._diskFile();
      let raw = {};
      if (fs.existsSync(p)) {
        try {
          raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
          raw = {};
        }
      }
      raw[key] = { at: Date.now(), value };
      // 上限 2000 条，超了删最旧的
      const keys = Object.keys(raw);
      if (keys.length > 2000) {
        keys
          .sort((a, b) => (raw[a].at || 0) - (raw[b].at || 0))
          .slice(0, keys.length - 2000)
          .forEach((k) => delete raw[k]);
      }
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(raw), 'utf8');
      fs.renameSync(tmp, p);
    } catch {
      /* 写不了就算了，不影响功能 */
    }
  }

  _diskFile() {
    const path = require('path');
    const root = (this.config && this.config.__root) || process.cwd();
    return path.join(root, 'music-meta-cache.json');
  }

  async _searchKugou(query, timeoutMs) {
    const url = `${KG_SEARCH_URL}?keyword=${encodeURIComponent(query)}&page=1&pagesize=8&platform=WebFilter`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let json;
    try {
      const res = await fetch(url, { headers: KG_HEADERS, signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }

    const lists = (json && json.data && json.data.lists) || [];
    if (!lists.length) return null;

    const want = normTitle(query);
    // 【关键】必须校验歌名真的匹配。
    // 酷狗对空/乱码查询会返回不相关的热门歌，不校验就会把垃圾当结果。
    const matched = lists.filter((x) => {
      const names = [x.SongName, x.OriSongName, x.FileName].filter(Boolean).map(normTitle);
      return names.some((n) => n === want || n.includes(want) || want.includes(n));
    });
    if (!matched.length) return null;

    // 优先原唱（IsOriginal===1），其次热度高的
    const originals = matched.filter((x) => Number(x.IsOriginal) === 1);
    const pool = originals.length ? originals : matched;
    pool.sort((a, b) => Number(b.HeatLevel || 0) - Number(a.HeatLevel || 0));
    const best = pool[0];

    // 「低调组合&周杰伦」这种合唱要拆开取主唱
    const singerRaw = String(best.SingerName || '').trim();
    const artist = toSimplified(singerRaw.split(/[、&,，/]/)[0].trim());

    // 【重要】把**同一首歌所有版本**的时长都收集起来。
    // 实测「突然的陀螺」：酷狗上蔚蓝边际那条是 113s，但 B站上他本人的视频是 144s，
    // 而酷狗里另有 145s/140s/144s 等版本。只拿 Top1 的时长做比对太脆弱，
    // 所以返回一个时长列表，B站候选只要**接近其中任意一个**就算吻合。
    const durations = [...new Set(matched.map((x) => Number(x.Duration)).filter((d) => d > 30))].sort(
      (a, b) => a - b
    );

    return {
      artist,
      artistRaw: singerRaw,
      album: toSimplified(String(best.AlbumName || '').trim()),
      // 酷狗的 Duration 单位是「秒」（不是毫秒）
      durationSec: Number(best.Duration) || 0,
      /** 同一首歌在各平台/各版本出现过的时长（用于宽松比对） */
      durations,
      year: best.PublishDate ? String(best.PublishDate).slice(0, 4) : '',
      isOriginal: Number(best.IsOriginal) === 1,
      // 可直接用于 B站二次搜索，例如「周杰伦 - 晴天」
      searchText: toSimplified(String(best.FileName || `${singerRaw} - ${best.SongName}`).trim()),
      songName: toSimplified(String(best.SongName || '').trim()),
    };
  }
}

module.exports = { MusicMeta, cleanQueryForLookup, normTitle };
