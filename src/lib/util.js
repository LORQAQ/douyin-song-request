'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randomDigits(len = 16) {
  let s = '';
  while (s.length < len) s += String(Math.floor(Math.random() * 10));
  return s.slice(0, len);
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

/** 去掉 HTML 标签与常见实体，B站搜索结果标题带 <em class="keyword"> */
function stripHtml(input) {
  if (!input) return '';
  return String(input)
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 "4:03" / "1:02:33" 转成秒 */
function durationTextToSec(text) {
  if (text == null) return 0;
  if (typeof text === 'number') return text;
  const parts = String(text).split(':').map((n) => parseInt(n, 10));
  if (parts.some((n) => Number.isNaN(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function formatDuration(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }
  return `${m}:${String(r).padStart(2, '0')}`;
}

function truncate(text, len = 40) {
  const s = String(text || '');
  return s.length <= len ? s : `${s.slice(0, len - 1)}…`;
}

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch;
  if (typeof base !== 'object' || base === null) return patch === undefined ? base : patch;
  if (typeof patch !== 'object' || patch === null) return base;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    out[key] = deepMerge(base[key], patch[key]);
  }
  return out;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

/** 带条数上限的 LRU 缓存，防止长时间运行时内存无限增长 */
class LruCache {
  constructor(maxSize = 200) {
    this.maxSize = Math.max(1, Number(maxSize) || 200);
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    // 访问即刷新到队尾
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxSize) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  has(key) {
    return this.map.has(key);
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

/** 简易滑动窗口限速器（串行化调用，并保留每次调用的结果与异常） */
class RateLimiter {
  constructor(minIntervalMs = 0) {
    this.minIntervalMs = minIntervalMs;
    this.last = 0;
    this.chain = Promise.resolve();
  }

  run(fn) {
    const result = this.chain.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.last);
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      return fn();
    });
    // 把「结果 promise」继续作为下一条的排队基准，同时吞掉拒绝，避免未处理的 rejection
    this.chain = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

/** 带超时的 fetch，返回 { status, ok, headers, text, json } */
async function request(url, options = {}) {
  const { timeoutMs = 15000, headers = {}, method = 'GET', body, redirect = 'follow', raw = false } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, redirect, signal: controller.signal });
    const text = raw ? null : await res.text();
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      text,
      json() {
        return JSON.parse(text);
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

/** B站接口需要 Referer，否则容易 412 */
const BILI_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

/**
 * 把一段很长的 B站标题压成一个能显示在直播画面上的短来源标签。
 *
 * 为什么需要：合集/歌单类的标题经常长到离谱，比如
 *   「陈奕迅等人华语金曲合集｜学习静心｜坐车通勤｜开车伴听｜睡前放松循环歌单 · P5 0005. 富士山下 - 陈奕迅」
 * 直接显示出来会换行、挤爆播放页和悬浮层。
 * 目标输出：「陈奕迅等人华语金曲合集 · P5」
 *
 * @param {string} rawTitle 原始标题
 * @param {string} [songName] 歌名（大字已经显示了，这里去掉避免重复）
 * @param {number} [limit=16] 最大字数
 */
function shortSource(rawTitle, songName, limit = 16) {
  if (!rawTitle) return '';
  let t = String(rawTitle);

  // ① 去掉歌名（外面的大字已经显示了）
  if (songName) t = t.split(songName).join(' ');

  // ② 抽分P 号
  const p = t.match(/[·\s]*P(\d+)/);
  const pageTag = p ? ` · P${p[1]}` : '';

  // ③ 按分隔符切段，优先挑「合集类」关键词的那段
  const KEY = /(合集|全集|精选|歌单|无损|金曲|专辑|单曲|MV)/i;
  const segs = t
    .split(/[｜|·/、,，]/)
    .map((s) => s.replace(/[【】《》（）()\[\]「」]/g, ' ').replace(/\s{2,}/g, ' ').trim())
    .filter((s) => s.length >= 2);
  let head = segs.find((s) => KEY.test(s)) || segs[0] || '';

  // ④ 太长就按「段」丢弃，不硬截字符（避免留下半个括号）
  if (head.length > limit) {
    const chunks = head.split(/(?=[【《（(\[「])/).filter(Boolean);
    let out = '';
    for (const c of chunks) {
      if ((out + c).length > limit) break;
      out += c;
    }
    head = `${(out || head.slice(0, limit)).replace(/[\s·]+$/, '')}…`;
  }

  return head ? head + pageTag : pageTag.replace(/^ · /, '');
}

module.exports = {
  md5,
  sleep,
  randomDigits,
  uniq,
  stripHtml,
  durationTextToSec,
  formatDuration,
  truncate,
  shortSource,
  deepMerge,
  ensureDir,
  readJsonSafe,
  writeJson,
  uid,
  RateLimiter,
  LruCache,
  request,
  BILI_HEADERS,
};
