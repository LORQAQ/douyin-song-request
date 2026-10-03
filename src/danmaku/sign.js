'use strict';

const { randomDigits } = require('../lib/util');

/**
 * 抖音弹幕相关的请求构造。
 *
 * 重要（实测结论，见 _probe_douyin/FINDINGS.md）：
 *   - 真正可用的通道是 HTTP 长轮询 /webcast/im/fetch/，它 **不校验 signature**。
 *   - WebSocket 直连会被 CDN 判定 DEVICE_BLOCKED（HTTP 200 + handshake-status 415），
 *     换域名/签名/Cookie 都无效，所以这里保留了「页面原样参数」的构造函数仅供排查使用。
 *   - roomId 现在不在直播间 HTML 里了，要用 /webcast/room/web/enter/?web_rid=xxx。
 */

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DY_HEADERS = {
  'User-Agent': CHROME_UA,
  Referer: 'https://live.douyin.com/',
  Origin: 'https://live.douyin.com',
  'Accept-Language': 'zh-CN,zh;q=0.9',
};

const ROOM_ENTER_URL = 'https://live.douyin.com/webcast/room/web/enter/';
const IM_FETCH_URL = 'https://live.douyin.com/webcast/im/fetch/';

/** 直播间页面（主要为了拿 ttwid cookie） */
async function fetchWebCookies(webRid, logger = null) {
  const url = `https://live.douyin.com/${webRid}`;
  try {
    const res = await fetch(url, {
      headers: { ...DY_HEADERS, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
    });
    const html = await res.text();
    return { html, cookies: collectCookies(res), status: res.status };
  } catch (err) {
    if (logger) logger.debug('获取直播间页面失败:', err.message);
    return { html: '', cookies: {}, status: 0 };
  }
}

function collectCookies(res) {
  const jar = {};
  const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const list = raw && raw.length ? raw : [res.headers.get('set-cookie')].filter(Boolean);
  for (const item of list) {
    const [pair] = String(item).split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return jar;
}

function cookieHeader(jar) {
  return Object.entries(jar || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

/**
 * 用官方房间信息接口把 web_rid 换成真实 roomId。
 * 返回 { roomId, nickname, status, userCount, title }，status: 2=直播中 4=已下播
 * 不带 cookie 通常也能通；失败时会自动补一次 ttwid 再试。
 */
async function fetchRoomInfo(webRid, cookie = '', logger = null, options = {}) {
  const params = new URLSearchParams({
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    enter_from: 'web_live',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Mozilla',
    browser_version: '5.0 (Windows)',
    web_rid: String(webRid),
  });
  const url = `${ROOM_ENTER_URL}?${params.toString()}`;

  const attempt = async (cookieText) => {
    const headers = { ...DY_HEADERS };
    if (cookieText) headers.Cookie = cookieText;
    const res = await fetch(url, { headers, redirect: 'follow' });
    const text = await res.text();
    if (!text) return { error: `空响应（HTTP ${res.status}）` };
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return { error: `非 JSON（HTTP ${res.status}）：${text.slice(0, 100)}` };
    }
    const room = json && json.data && Array.isArray(json.data.data) ? json.data.data[0] : null;
    if (!room) return { error: `响应里没有房间数据：${JSON.stringify(json).slice(0, 140)}` };
    const user = (json.data && json.data.user) || room.owner || {};
    return {
      info: {
        roomId: String(room.id_str || room.id || ''),
        nickname: user.nickname || room.nickname || '',
        status: Number(room.status),
        userCount: room.user_count_str || '',
        title: room.title || '',
      },
    };
  };

  try {
    let result = await attempt(cookie);
    if (result.error && !cookie && options.bootstrapCookie !== false) {
      // 有些网络环境需要先访问一次页面拿到 ttwid
      const page = await fetchWebCookies(webRid, logger);
      const boot = cookieHeader(page.cookies);
      if (boot) {
        if (logger) logger.debug('房间接口重试（带 ttwid）...');
        result = await attempt(boot);
      }
    }
    if (result.error) {
      if (logger) logger.debug(`房间接口失败：${result.error}`);
      return null;
    }
    return result.info;
  } catch (err) {
    if (logger) logger.debug(`房间接口请求失败：${err.message}`);
    return null;
  }
}

/** 从直播间 HTML 里尽力抓 roomId（页面改版后通常抓不到，仅作兜底） */
function extractRoomInfo(html) {
  const info = { roomId: '', nickname: '', title: '', status: null };
  if (!html) return info;
  const patterns = [
    /"roomId"\s*:\s*"(\d{5,})"/,
    /roomId&quot;\s*:\s*&quot;(\d{5,})&quot;/,
    /roomId\\?"\s*:\s*\\?"(\d{5,})\\?"/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      info.roomId = m[1];
      break;
    }
  }
  const nick =
    html.match(/"nickname"\s*:\s*"([^"]{1,60})"/) || html.match(/nickname&quot;\s*:\s*&quot;([^&]{1,60})&quot;/);
  if (nick) info.nickname = nick[1];
  return info;
}

/**
 * 构造 HTTP 长轮询地址（实测可用：不需要 signature / X-Bogus / 登录）
 * cursor 传上一次响应里的 Response.field2 即可持续收。
 */
function buildFetchUrl({ roomId, webRid, userUniqueId, cursor = '', internalExt = '' }) {
  const params = {
    resp_content_type: 'protobuf',
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    enter_from: 'web_live',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Mozilla',
    browser_version: '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    browser_online: 'true',
    tz_name: 'Asia/Shanghai',
    host: 'https://live.douyin.com',
    version_code: '180800',
    webcast_sdk_version: '1.0.15',
    update_version_code: '1.0.15',
    compress: 'gzip',
    did_rule: '3',
    endpoint: 'live_pc',
    support_wrds: '1',
    im_path: '/webcast/im/fetch/',
    identity: 'audience',
    need_persist_msg_count: '15',
    insert_task_id: '',
    live_reason: '',
    room_id: String(roomId || ''),
    web_rid: String(webRid || ''),
    user_unique_id: String(userUniqueId || ''),
    heartbeatDuration: '0',
  };
  if (cursor) params.cursor = cursor;
  if (internalExt) params.internal_ext = internalExt;
  return `${IM_FETCH_URL}?${new URLSearchParams(params).toString()}`;
}

module.exports = {
  buildFetchUrl,
  buildSignature,
  selfCheck,
  buildWssUrl,
  fetchWebCookies,
  fetchRoomInfo,
  collectCookies,
  cookieHeader,
  extractRoomInfo,
  randomDigits,
  CHROME_UA,
  DY_HEADERS,
  ROOM_ENTER_URL,
  IM_FETCH_URL,
};

/* ------------------------------------------------------------------ */
/* 以下为 WebSocket 直连的历史实现，保留用于排查（实测 DEVICE_BLOCKED） */
/* ------------------------------------------------------------------ */

const { md5 } = require('../lib/util');

function buildSignature(roomId, userUniqueId) {
  const stub = md5(`${roomId}${userUniqueId}`);
  const zeros = '0'.repeat(32);
  return { stub, signature: md5(`${stub}${zeros}${stub.length}`) + zeros + stub.length + stub };
}

function selfCheck(roomId, userUniqueId) {
  const { stub, signature } = buildSignature(roomId, userUniqueId);
  const expected = md5(`${stub}${'0'.repeat(32)}${stub.length}`);
  return { ok: signature.startsWith(expected) && signature.endsWith(stub), stub, signature };
}

const WS_HOSTS = [
  'webcast100-ws-web-lf.douyin.com',
  'webcast100-ws-web-lq.douyin.com',
  'webcast5-ws-web-lf.douyin.com',
  'webcast3-ws-web-lf.douyin.com',
];

function buildWssUrl({ roomId, webRid, userUniqueId, signature, host, imPath = '/webcast/im/fetch/', version = '180800' }) {
  const params = {
    app_name: 'douyin_web',
    version_code: version,
    webcast_sdk_version: '1.0.15',
    update_version_code: '1.0.15',
    compress: 'gzip',
    device_platform: 'web',
    cookie_enabled: 'true',
    screen_width: '1920',
    screen_height: '1080',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Mozilla',
    browser_version: '5.0 (Windows)',
    browser_online: 'true',
    tz_name: 'Asia/Shanghai',
    host: 'https://live.douyin.com',
    aid: '6383',
    live_id: '1',
    did_rule: '3',
    endpoint: 'live_pc',
    support_wrds: '1',
    im_path: imPath,
    identity: 'audience',
    need_persist_msg_count: '15',
    user_unique_id: userUniqueId,
    web_rid: webRid || '',
    room_id: roomId || '',
    heartbeatDuration: '0',
    signature: signature || '',
  };
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `wss://${host}/webcast/im/push/v2/?${qs}`;
}
