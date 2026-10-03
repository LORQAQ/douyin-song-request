'use strict';

/**
 * 从本机「抖音直播伴侣」的数据里读出当前的真实房间信息。
 *
 * 为什么需要它：
 *   - 抖音的 web_rid（直播间号，形如 7456814）是**账号级固定**的，
 *     但万一是新号/换号，光靠配置就会连到错的房间。
 *   - 直播伴侣每场开播都会把 roomId / 昵称写进本机数据，
 *     读它就能自动核对「配置里的号」和「真实的号」是否一致，不一致自动纠正。
 *
 * 只读本机文件，不上传任何东西。
 */

const fs = require('fs');
const path = require('path');

/** 最近一次扫描结果（避免启动时反复读盘） */
let cached = null;

/** 直播伴侣可能的数据目录 */
function companionDirs() {
  const bases = [process.env.APPDATA, process.env.LOCALAPPDATA, process.env.USERPROFILE].filter(Boolean);
  const names = ['webcast_mate', '直播伴侣', 'LiveCompanion'];
  const dirs = [];
  for (const base of bases) {
    for (const name of names) {
      const p = path.join(base, name);
      try {
        if (fs.existsSync(p)) dirs.push(p);
      } catch {
        /* ignore */
      }
    }
  }
  return dirs;
}

/**
 * 找出应该优先读取的文件。
 *
 * 经验教训：直播伴侣根目录下有成百上千个缓存文件，
 * 如果无脑递归扫描，很容易在还没走到 WBStore 时就撞上数量上限
 * （实测 400 个上限时完全扫不到 roomStore.json）。
 * 所以这里先精确命中已知的关键文件，扫不到再退化成全量扫描。
 *
 * ⚠️ 版本变化（实测 13.0.5）：房间信息**已经不在 `WBStore/roomStore.json`** 了，
 * 那个文件现在只剩界面设置（`roomStore.liveSetting.*`）。
 * 房间历史搬到了 `globalStore/liveRecorderStore.json`（字段名是 `room_id`，下划线），
 * 账号信息在 `WBStore/userStore.json`。
 * 两个地方都要读，所以下面的匹配逻辑对新旧格式并存处理。
 */
const KEY_FILES = [
  ['globalStore', 'liveRecorderStore.json'],
  ['WBStore', 'userStore.json'],
  ['WBStore', 'roomStore.json'],
  ['WBStore', 'appStore.json'],
  ['appSettings', 'config.json'],
];

function keyFiles(root) {
  const out = [];
  for (const parts of KEY_FILES) {
    const p = path.join(root, ...parts);
    try {
      if (fs.existsSync(p)) out.push(p);
    } catch {
      /* ignore */
    }
  }
  // storage / Local Storage 里可能有账号信息
  for (const sub of ['storage', 'Local Storage', 'WebStorage']) {
    const dir = path.join(root, sub);
    try {
      if (!fs.existsSync(dir)) continue;
      for (const name of fs.readdirSync(dir).slice(0, 20)) {
        const full = path.join(dir, name);
        try {
          const st = fs.statSync(full);
          if (st.isFile() && st.size > 200 && st.size < 30 * 1024 * 1024) out.push(full);
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 兜底：递归找几个小文件（只在关键文件没命中时才用） */
function fallbackFiles(root, limit = 300) {
  const out = [];
  const skip = /gecko_cache|Dictionaries|fonts|materialLib|GPUCache|[\\/]Cache[\\/]|Code Cache|blob_storage|GPUCache/i;
  const walk = (dir, depth) => {
    if (out.length >= limit || depth > 2) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      const full = path.join(dir, e.name);
      if (skip.test(full)) continue;
      if (e.isDirectory()) walk(full, depth + 1);
      else if (/\.(json|log|txt|dat)$/i.test(e.name)) {
        try {
          const st = fs.statSync(full);
          if (st.size > 200 && st.size < 30 * 1024 * 1024) out.push(full);
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root, 0);
  return out;
}

/**
 * 读取本机直播伴侣里的账号与房间信息。
 * @param {object} [options]
 * @param {number} [options.cacheMs] 缓存时长（默认 5 秒，避免启动时重复扫描磁盘）
 * @returns {{ available: boolean, nickname?: string, roomId?: string, uid?: string,
 *             shortId?: string, webRid?: string, startTime?: number, dirs: string[] }}
 */
function readCompanionInfo(options = {}) {
  const cacheMs = options.cacheMs === undefined ? 5000 : Number(options.cacheMs);
  if (cached && cacheMs > 0 && Date.now() - cached.at < cacheMs) return cached.value;

  const value = scanCompanion();
  cached = { at: Date.now(), value };
  return value;
}

function scanCompanion() {
  const dirs = companionDirs();
  const result = { available: false, dirs };
  if (!dirs.length) return result;

  const roomIds = new Map(); // roomId -> 文件修改时间（用最近一次开播作为当前场次）
  let nickname = '';
  let uid = '';
  let shortId = '';
  let webRid = '';
  let startTime = 0;

  for (const dir of dirs) {
    // 第一轮：只读关键文件（快且准）
    let files = keyFiles(dir);
    let scannedKey = false;
    for (const file of files) {
      try {
        if (fs.statSync(file).size > 200) scannedKey = true;
      } catch {
        /* ignore */
      }
    }
    if (!scannedKey) {
      // 第二轮：关键文件都不在（换了版本/目录结构），再全量找
      files = files.concat(fallbackFiles(dir));
    }

    for (const file of files) {
      let text = '';
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const isOwnerFile = /roomStore|userStore|liveRecorderStore/i.test(file);
      if (isOwnerFile) {
        const mtime = (() => {
          try {
            return fs.statSync(file).mtimeMs;
          } catch {
            return 0;
          }
        })();
        // 房间号：兼容三种写法
        //   "room_id_str": "7692..."   （旧 roomStore）
        //   "roomId": "7692..."        （旧版）
        //   "room_id": "7692..."       （新 liveRecorderStore，实测字段名带下划线）
        const roomPatterns = [
          /"room_id_str"\s*:\s*"?(\d{10,20})"?/g,
          /"roomId"\s*:\s*"?(\d{10,20})"?/g,
          /"room_id"\s*:\s*"?(\d{10,20})"?/g,
        ];
        for (const re of roomPatterns) {
          for (const m of text.matchAll(re)) {
            if (!roomIds.has(m[1]) || roomIds.get(m[1]) < mtime) roomIds.set(m[1], mtime);
          }
        }
        const nick = text.match(/"nickname"\s*:\s*"([^"]{1,40})"/);
        if (nick && !nickname) nickname = nick[1];
        // uid：新版 liveRecorderStore 里就是顶层 "uid"；旧版在 roomStore 的 "owner" 对象里。
        if (!uid) {
          const directUid = text.match(/"uid"\s*:\s*"?(\d{10,20})"?/);
          if (directUid && !/roomId|room_id/i.test(directUid[0])) uid = directUid[1];
        }
        // 注意：roomStore 里 "id_str" 出现多次（房间/流/主播），
        // 只有 "owner": { 对象里的那个才是账号 ID。
        const ownerIdx = text.indexOf('"owner":');
        if (ownerIdx >= 0 && !uid) {
          const ownerTail = text.slice(ownerIdx, ownerIdx + 3000);
          // 优先取 "id_str"，取不到再退而取 "id"
          const ownerId =
            ownerTail.match(/"id_str"\s*:\s*"(\d{10,20})"/) || ownerTail.match(/"id"\s*:\s*(\d{10,20})/);
          if (ownerId) uid = ownerId[1];
        }
        const s = text.match(/"short_id"\s*:\s*"?(\d{6,14})"?/);
        if (s && !shortId) shortId = s[1];
        const st = text.match(/"start_time"\s*:\s*(\d{10,13})/);
        if (st) startTime = Math.max(startTime, Number(st[1]));
      }
      if (!webRid) {
        const w = text.match(/"webRid"\s*:\s*"(\d{6,14})"/) || text.match(/"web_rid"\s*:\s*"(\d{6,14})"/);
        if (w) webRid = w[1];
      }
    }
  }

  // 取最近一次开播的 roomId 作为「当前场次」
  let latestRoomId = '';
  let latestTime = -1;
  for (const [rid, t] of roomIds) {
    if (t > latestTime) {
      latestTime = t;
      latestRoomId = rid;
    }
  }

  if (!nickname && !latestRoomId) return result;
  return {
    available: true,
    dirs,
    nickname,
    roomId: latestRoomId,
    uid,
    shortId,
    webRid,
    startTime,
    allRoomIds: [...roomIds.keys()],
  };
}

module.exports = { readCompanionInfo, companionDirs };
