'use strict';

const { uniq } = require('../lib/util');

const PUNCT = /[\s\u3000·・~～!！?？,，.。、:：;；'"“”‘’()（）\[\]【】<>《》\-—_+*/\\|@#$%^&^]+/g;

/** 全角转半角 + 去零宽字符 + 折叠空白 */
function normalizeText(input) {
  let s = String(input || '');
  s = s.replace(/[\u200b-\u200f\u2028-\u202f\ufeff]/g, '');
  s = s.replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  s = s.replace(/[\u3000]/g, ' ');
  return s.trim();
}

/** 用于比对的歌曲指纹：去标点、去空白、小写 */
function songFingerprint(title) {
  return normalizeText(title)
    .toLowerCase()
    .replace(PUNCT, '')
    .replace(/(official|mv|官方|完整版|高音质|无损|原唱|正式版|高清|1080p|4k)/g, '')
    .trim();
}

/** 解析一条弹幕，判断是否是点歌请求 */
function parseRequest(content, config = {}) {
  const raw = normalizeText(content);
  if (!raw) return null;

  const keywords = config.keywords && config.keywords.length ? config.keywords : ['点歌'];
  const requireKeyword = config.requireKeyword !== false;

  // 命中的触发词：取最长的那个，避免「点」先于「点歌」匹配
  let hitKeyword = null;
  for (const kw of [...keywords].sort((a, b) => b.length - a.length)) {
    if (!kw) continue;
    if (raw.toLowerCase().includes(kw.toLowerCase())) {
      hitKeyword = kw;
      break;
    }
  }

  if (requireKeyword && !hitKeyword) return null;
  if (!requireKeyword && !config.allowAnyDanmaku && !hitKeyword) {
    // 不要求关键词但又没命中：交给调用方决定（默认仍然只认关键词）
    return null;
  }

  let song = raw;
  const stripWords = config.stripWords || [];
  if (hitKeyword) {
    song = song.replace(new RegExp(escapeRegExp(hitKeyword), 'ig'), ' ');
  }
  for (const word of [...stripWords].sort((a, b) => b.length - a.length)) {
    if (!word) continue;
    // 单字「来 / 放 / 的」只在句首、且后面有空格时才当作多余词，
    // 否则会把《夜空中最亮的星》《来生缘》这类正常歌名改坏。
    if (word.length === 1 && '来放的'.includes(word)) {
      song = song.replace(new RegExp(`^\\s*${escapeRegExp(word)}\\s+`, 'g'), ' ');
      continue;
    }
    song = song.replace(new RegExp(escapeRegExp(word), 'gi'), ' ');
  }

  // 广告/链接类先判定，避免下面把 "http://" 里的符号清掉后漏判
  const preReject = config.rejectIfContains || [];
  const preLower = song.toLowerCase();
  for (const bad of preReject) {
    if (bad && preLower.includes(String(bad).toLowerCase())) {
      return { ok: false, reason: 'rejected-word', song: song.trim(), keyword: hitKeyword, raw };
    }
  }

  // 注意：这里刻意不动「的」。像「我的未来不是梦」「夜空中最亮的星」这种歌名本身就带「的」，
  // 正则去掉会把歌名改坏；「周杰伦的晴天」这类带歌手的写法交给B站搜索的兜底逻辑处理。
  song = song.replace(/[\s:：,，、\-—]+/g, ' ').trim();

  // 层层剥掉首尾的语气词/括号/标点：「《晴天》吧~」-> 「晴天」
  const EDGE_PARTICLES = /(?:^[吧呗嘛呀啊哦喔哈啦嘞咯噢哟]+)|(?:[吧呗嘛呀啊哦喔哈啦嘞咯噢哟]+$)/g;
  const LEAD_BRACKETS = /^["'“”‘’《》〈〉【】\[\]()（）]+/;
  const TRAIL_BRACKETS = /["'“”‘’《》〈〉【】\[\]()（）]+$/;
  const EDGE_PUNCT = /(?:^[\s:：,，、\-—~～!！?？.。;；]+)|(?:[\s:：,，、\-—~～!！?？.。;；]+$)/g;
  for (let i = 0; i < 6; i += 1) {
    const before = song;
    song = song.replace(EDGE_PARTICLES, '').replace(EDGE_PUNCT, '');
    // 开括号只在句首才脱掉，避免把歌名中间的「《」吃掉；闭括号可以放心从尾部去掉
    if (config.stripQuotes !== false) song = song.replace(LEAD_BRACKETS, '').replace(TRAIL_BRACKETS, '');
    if (song === before) break;
  }
  song = song.replace(/\s{2,}/g, ' ').trim();

  // 落单的开括号：抖音弹幕经常只打半个，留着会干扰搜索
  const OPENERS = '《〈【（(｛{「『';
  const CLOSERS = '》〉】）)｝}」』';
  for (let i = 0; i < OPENERS.length; i += 1) {
    const open = OPENERS[i];
    const close = CLOSERS[i];
    if (song.includes(open) && !song.includes(close)) {
      song = song.split(open).join(' ');
    }
  }
  song = song.replace(/\s{2,}/g, ' ').trim();

  const minLength = Number(config.minLength ?? 2);
  const maxLength = Number(config.maxLength ?? 40);
  if (song.length < minLength) return { ok: false, reason: 'too-short', song, keyword: hitKeyword, raw };
  if (song.length > maxLength) return { ok: false, reason: 'too-long', song, keyword: hitKeyword, raw };

  const reject = config.rejectIfContains || [];
  const lower = song.toLowerCase();
  for (const bad of reject) {
    if (bad && lower.includes(String(bad).toLowerCase())) {
      return { ok: false, reason: 'rejected-word', song, keyword: hitKeyword, raw };
    }
  }
  // 纯符号/纯数字不算歌名
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(song)) {
    return { ok: false, reason: 'not-a-song', song, keyword: hitKeyword, raw };
  }

  /**
   * 【唯一的歌手指定格式：`歌手 - 歌名`】
   *
   * 约定（由主播/观众遵守）：
   *   `点歌 周杰伦 - 晴天`      → 歌手=周杰伦，歌名=晴天
   *   `点歌 Alan Walker - Alone` → 歌手=Alan Walker，歌名=Alone
   *
   * **横线前面是歌手，后面是歌名。别的格式一律不认** ——
   * 空格分隔（`点歌 晴天 周杰伦`）不解析歌手，退回纯歌名搜索。
   *
   * 为什么不做格式猜测：之前试过用「首字母大写」「不在官方歌名里」等启发式
   * 去猜哪边是歌手，结果在同名不同歌的场景（Alone/Stay/Hello）反复出错，
   * 还让代码变得难以预测。一个明确的格式约定比一堆猜测可靠得多。
   *
   * 上面第 76 行为了清理噪声把 `-` 换成了空格，所以这里回到**原始文本**
   * 重新按分隔符切开（去掉触发词之后的部分）。
   */
  let artist = '';
  let title = '';
  if (config.dashArtistFormat !== false) {
    const rawAfterKeyword = String(content || '')
      .trim()
      .replace(hitKeyword ? new RegExp(escapeRegExp(hitKeyword), 'ig') : /$^/, ' ')
      .trim();
    const segs = rawAfterKeyword
      .split(/\s*[-–—]\s*/)
      .map((x) => x.replace(/^[\s:：,，、]+|[\s:：,，、]+$/g, '').trim())
      .filter(Boolean);
    // 恰好两段才算（「A - B - C」不猜）。歌手名不该是长句，限制 40 字以内。
    if (segs.length === 2 && segs[0].length >= 1 && segs[0].length <= 40 && segs[1].length >= 1) {
      artist = segs[0];
      title = segs[1];
    }
  }

  return {
    ok: true,
    song,
    keyword: hitKeyword,
    raw,
    /** 「歌手 - 歌名」解析出的歌手；没写这个格式时是空串 */
    artist,
    /** 「歌手 - 歌名」解析出的歌名；没写这个格式时是空串 */
    title,
  };
}

/**
 * 从一段文本里识别「直接指定B站视频」的写法。
 *
 * 为什么需要：自动搜索再准也只是「猜」。热门歌的原唱常常搜不到（版权下架），
 * 主播/观众如果想放某个**具体**视频，最可靠的办法就是直接把链接或 BV 号发出来。
 * 支持的形式：
 *   https://www.bilibili.com/video/BV1xx411c7mD
 *   BV1xx411c7mD            （裸 BV 号）
 *   av123456 / BV 号带空格
 *
 * 返回 { bvid } 或 null。
 */
function parseDirectVideo(input) {
  const raw = normalizeText(input);
  if (!raw) return null;

  // BV 号：BV + 10 位 base58（大小写敏感，但观众常打错大小写，统一成标准形式）
  const bvMatch = raw.match(/\b(BV[0-9A-Za-z]{10})\b/);
  if (bvMatch) return { bvid: bvMatch[1] };

  // av 号
  const avMatch = raw.match(/\bav(\d{1,12})\b/i);
  if (avMatch) return { aid: Number(avMatch[1]) };

  // b23.tv 短链 / bilibili 链接里带 BV
  const urlMatch = raw.match(/https?:\/\/[^\s]*bilibili\.com\/[^\s]*/i);
  if (urlMatch) {
    const inner = urlMatch[0].match(/(BV[0-9A-Za-z]{10})/);
    if (inner) return { bvid: inner[1] };
    return { url: urlMatch[0] };
  }

  return null;
}

/** 多首歌：「点歌 晴天/七里香」 */
function splitSongs(song) {
  if (!song) return [];
  return uniq(
    song
      .split(/[\/|、,，;；]+|\s+和\s+/)
      .map((s) => s.trim())
      .filter((s) => /[\u4e00-\u9fa5a-zA-Z]/.test(s))
  );
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 点歌过滤器：同歌去重窗口 + 每人冷却 + 每人队列上限
 */
class RequestFilter {
  constructor(config = {}, logger = null) {
    this.config = config;
    this.logger = logger;
    this.songHistory = new Map(); // fingerprint -> timestamp
    this.userLast = new Map(); // userId -> timestamp
    this.userQueue = new Map(); // userId -> count
  }

  updateConfig(config) {
    this.config = config;
  }

  /**
   * 检查一个点歌请求是否允许，**通过时就地预留名额**。
   *
   * 【为什么必须预留】原来的流程是 check（只读）→ 异步搜索（2~20 秒）→ 成功才 commit。
   * 同一首歌被 N 个人同时点（直播间很常见）时，N 个请求都在 commit 之前完成了 check，
   * 于是全部通过，sameSongWindowMs 完全失效；perUserCooldownMs 同理
   * （userLast 只在 commit 时写，同一秒内连发多首也能绕过）。
   *
   * 现在改成：check 通过的同时就把 songHistory / userLast / userQueue 写上。
   * 搜索失败时由调用方调 cancel() 回滚，观众不会因为一次失败就半天点不了。
   */
  check({ userId, nickname, song }) {
    const now = Date.now();
    const windowMs = Number(this.config.sameSongWindowMs ?? 900000);
    const cooldownMs = Number(this.config.perUserCooldownMs ?? 60000);
    const maxPerUser = Number(this.config.maxQueuePerUser ?? 3);
    const key = String(userId);

    const fp = songFingerprint(song);
    const last = this.songHistory.get(fp);
    if (last && now - last < windowMs) {
      return { ok: false, reason: 'duplicate', message: `「${song}」最近点过啦，换一首吧~` };
    }

    const lastByUser = this.userLast.get(key);
    if (cooldownMs > 0 && lastByUser && now - lastByUser < cooldownMs) {
      const left = Math.ceil((cooldownMs - (now - lastByUser)) / 1000);
      return { ok: false, reason: 'cooldown', message: `${nickname} 点歌太快啦，${left}秒后再来~` };
    }

    const queued = this.userQueue.get(key) || 0;
    if (maxPerUser > 0 && queued >= maxPerUser) {
      return { ok: false, reason: 'user-queue-full', message: `${nickname} 已经排了${queued}首，先听完吧~` };
    }

    // ---- 通过：立刻预留（这一步是关键，不能延后到搜索成功之后）----
    this.songHistory.set(fp, now);
    this.userLast.set(key, now);
    this.userQueue.set(key, queued + 1);
    this._gc(now, windowMs, cooldownMs);

    return { ok: true, fingerprint: fp };
  }

  /**
   * 回滚一次预留（搜索失败 / 条目被取消时用）。
   * 让观众可以马上重试，而不是被去重窗口挡 15 分钟。
   */
  cancel({ userId, song, fingerprint }) {
    const key = String(userId);
    const fp = fingerprint || songFingerprint(song);

    const queued = this.userQueue.get(key) || 0;
    if (queued > 0) {
      if (queued === 1) this.userQueue.delete(key);
      else this.userQueue.set(key, queued - 1);
    }
    this.songHistory.delete(fp);
  }

  /** 清理过期记录，防止 Map 无限增长 */
  _gc(now, windowMs, cooldownMs) {
    for (const [k, t] of this.songHistory) {
      if (now - t > windowMs) this.songHistory.delete(k);
    }
    for (const [k, t] of this.userLast) {
      if (now - t > Math.max(cooldownMs, 60000) * 5) this.userLast.delete(k);
    }
  }

  /** 兼容旧调用：commit 现在只是把时间戳刷新一下（名额在 check 时已经占好了） */
  commit({ userId, song, fingerprint }) {
    const now = Date.now();
    const fp = fingerprint || songFingerprint(song);
    this.songHistory.set(fp, now);
    this.userLast.set(String(userId), now);
    const windowMs = Number(this.config.sameSongWindowMs ?? 900000);
    const cooldownMs = Number(this.config.perUserCooldownMs ?? 60000);
    this._gc(now, windowMs, cooldownMs);
  }

  releaseUser(userId) {
    const key = String(userId);
    const next = (this.userQueue.get(key) || 0) - 1;
    if (next <= 0) this.userQueue.delete(key);
    else this.userQueue.set(key, next);
  }

  reset() {
    this.songHistory.clear();
    this.userLast.clear();
    this.userQueue.clear();
  }
}

module.exports = {
  normalizeText,
  songFingerprint,
  parseRequest,
  parseDirectVideo,
  splitSongs,
  RequestFilter,
  escapeRegExp,
};
